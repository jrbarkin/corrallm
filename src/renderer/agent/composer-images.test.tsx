import { createRef } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConnectionDescriptor } from '../../shared/adapter';
import { MAX_IMAGE_BYTES, MAX_IMAGE_TOTAL } from '../../shared/api/limits';
import { NEW_SESSION } from '../../shared/model/session';
import { MADE_UP } from '../../shared/test-made-up';
import { useCatalog as adoptCatalog } from '../test-catalog';
import { Composer } from './Composer';

/*
 * What a composer lets be pasted or dropped, by the connection's own image limits (B16 C3/X4):
 * made-up connections with one PNG type, a tiny per-image cap and one image, so no vendor's limit
 * (and none of the platform's ceilings) is what decides.
 */

type Declared = ConnectionDescriptor['images'];
const TINY: Declared = { types: ['image/png'], maxBytes: 16, max: 1 };
const SUBJECT = 'Zed Agent · ACP';

/** A file of `bytes` bytes (its content really that long, so the decoded size agrees). */
const file = (bytes: number, type = 'image/png', name = 'shot.png') =>
  new File([new Uint8Array(bytes)], name, { type });
/** A file that says it is `size` bytes long, whatever it holds. */
const claiming = (size: number, name: string) => {
  const one = file(3, 'image/png', name);
  Object.defineProperty(one, 'size', { value: size });
  return one;
};

/** FileReaders that finish when told, so several can be in flight at once. */
const readers: { reader: { result: string | null; onload: (() => void) | null }; file: File }[] =
  [];
class HeldReader {
  result: string | null = null;
  onload: (() => void) | null = null;
  readAsDataURL(of: File) {
    readers.push({ reader: this, file: of });
  }
}
async function finishReading(from = 0, to = readers.length) {
  for (const { reader, file: of } of readers.slice(from, to)) {
    const text = btoa(String.fromCharCode(...new Uint8Array(await of.arrayBuffer())));
    reader.result = `data:${of.type};base64,${text}`;
    act(() => {
      reader.onload?.();
    });
  }
}

beforeEach(() => {
  readers.length = 0;
  vi.stubGlobal('FileReader', HeldReader);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function mount(declared: Declared = TINY) {
  await adoptCatalog(MADE_UP);
  const send = vi.fn();
  const field = createRef<HTMLTextAreaElement>();
  const tree = (rules: { declared: Declared; subject?: string }) => (
    <Composer
      agentName="Worker"
      agent="zed"
      session={NEW_SESSION}
      field={field}
      imageRules={{ declared: rules.declared, subject: rules.subject ?? SUBJECT }}
      controls={{
        send,
        stop: vi.fn(),
        unqueue: vi.fn(),
        setMode: vi.fn(),
        setModel: vi.fn(),
      }}
    />
  );
  const view = render(tree({ declared }));
  const box = screen.getByRole<HTMLTextAreaElement>('textbox');
  const paste = (...files: File[]) => {
    fireEvent.paste(box, { clipboardData: { files, getData: () => '' } });
  };
  const drop = (...files: File[]) => {
    const target = view.container.querySelector('.agent-input');
    if (!target) throw new Error('no input');
    fireEvent.drop(target, { dataTransfer: { files } });
  };
  const type = (text: string) => {
    fireEvent.change(box, { target: { value: text } });
  };
  const rules = (next: Declared) => {
    view.rerender(tree({ declared: next }));
  };
  return { send, box, paste, drop, type, rules, view };
}

const previews = () => screen.queryAllByRole('img').length;

describe('a composer’s images by its connection’s limits', () => {
  it('refuses a paste past the per-image cap in words naming that cap, keeping text and previews', async () => {
    const { paste, type, box } = await mount({ ...TINY, max: 2 });
    type('What is this?');
    paste(file(16));
    await finishReading();
    expect(previews()).toBe(1);
    paste(file(17, 'image/png', 'big.png'));
    expect(readers).toHaveLength(1);
    expect(screen.getByRole('alert').textContent).toBe(
      `big.png: ${SUBJECT} takes images of at most 16 bytes each.`,
    );
    expect(previews()).toBe(1);
    expect(box.value).toBe('What is this?');
  });

  it('passes an image exactly at the cap, and sends it', async () => {
    const { paste, type, box, send } = await mount();
    paste(file(16));
    await finishReading();
    expect(previews()).toBe(1);
    expect(screen.queryByRole('alert')).toBeNull();
    type('here');
    fireEvent.keyDown(box, { key: 'Enter' });
    await act(async () => {
      await Promise.resolve();
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[1]).toHaveLength(1);
  });

  it('refuses a drop past the cap, sending and attaching nothing', async () => {
    const { drop, send } = await mount();
    drop(file(17, 'image/png', 'dropped.png'));
    expect(readers).toHaveLength(0);
    expect(screen.getByRole('alert').textContent).toContain('takes images of at most 16 bytes');
    expect(previews()).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses a second image past the connection’s count, and a kind it does not take', async () => {
    const { paste } = await mount();
    paste(file(4));
    await finishReading();
    paste(file(4, 'image/png', 'two.png'));
    expect(screen.getByRole('alert').textContent).toBe(
      `two.png: ${SUBJECT} takes at most 1 image in a message.`,
    );
    expect(previews()).toBe(1);
  });

  it('refuses a kind the connection does not take, naming the kinds it does', async () => {
    const { paste } = await mount();
    paste(file(4, 'image/jpeg', 'photo.jpg'));
    expect(screen.getByRole('alert').textContent).toBe(
      `photo.jpg: ${SUBJECT} takes only PNG images.`,
    );
    expect(readers).toHaveLength(0);
  });

  it('refuses every image when the connection takes none', async () => {
    const { paste } = await mount(null);
    paste(file(1));
    expect(screen.getByRole('alert').textContent).toBe(`shot.png: ${SUBJECT} takes no images.`);
    expect(readers).toHaveLength(0);
  });

  it('is not widened by a descriptor declaring more than the platform’s ceilings', async () => {
    const { paste } = await mount({
      types: ['image/png'],
      maxBytes: 10 * MAX_IMAGE_BYTES,
      max: 100,
    });
    paste(claiming(MAX_IMAGE_BYTES + 1, 'huge.png'));
    expect(screen.getByRole('alert').textContent).toBe(
      `huge.png: ${SUBJECT} takes images of at most 5 MB each.`,
    );
    paste(claiming(MAX_IMAGE_BYTES, 'edge.png'));
    expect(readers).toHaveLength(1);
  });
});

describe('images still being read', () => {
  it('cannot overrun the count: a paste made while another is read counts it', async () => {
    const { paste } = await mount();
    paste(file(4, 'image/png', 'one.png'));
    paste(file(4, 'image/png', 'two.png'));
    expect(readers).toHaveLength(1);
    expect(screen.getByRole('alert').textContent).toContain('takes at most 1 image');
    await finishReading();
    expect(previews()).toBe(1);
  });

  it('cannot overrun the total: rapid pastes reserve each file before any is read', async () => {
    const { paste } = await mount({
      types: ['image/png'],
      maxBytes: MAX_IMAGE_BYTES,
      max: 20,
    });
    const big = (name: string) => claiming(MAX_IMAGE_TOTAL / 5 - 1, name);
    paste(big('a.png'), big('b.png'), big('c.png'));
    paste(big('d.png'), big('e.png'), big('f.png'));
    // Four files of just under a fifth fit in the total, five do not.
    expect(readers).toHaveLength(5);
    paste(claiming(MAX_IMAGE_TOTAL / 5 + 1, 'g.png'));
    expect(readers).toHaveLength(5);
    expect(screen.getByRole('alert').textContent).toContain('of images in a message');
    await finishReading();
    expect(previews()).toBe(5);
  });

  it('rechecks against the connection it has when the read ends, attaching nothing it refuses', async () => {
    const { paste, rules, type, box } = await mount();
    type('keep me');
    paste(file(8));
    // The agent's connection is replaced by one that takes no images, before the read ends.
    rules(null);
    await finishReading();
    expect(previews()).toBe(0);
    expect(screen.getByRole('alert').textContent).toBe(`shot.png: ${SUBJECT} takes no images.`);
    expect(box.value).toBe('keep me');
  });

  it('attaches nothing after it is gone', async () => {
    const { paste, view } = await mount();
    paste(file(8));
    view.unmount();
    await finishReading();
    expect(screen.queryAllByRole('img')).toHaveLength(0);
  });

  it('rechecks on submit: a preview the connection no longer takes stays, and nothing is sent', async () => {
    const { paste, rules, type, box, send } = await mount();
    paste(file(8));
    await finishReading();
    type('hello');
    rules({ types: ['image/png'], maxBytes: 4, max: 1 });
    fireEvent.keyDown(box, { key: 'Enter' });
    await act(async () => {
      await Promise.resolve();
    });
    expect(send).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe(
      `${SUBJECT} takes images of at most 4 bytes each.`,
    );
    expect(previews()).toBe(1);
    expect(box.value).toBe('hello');
  });
});
