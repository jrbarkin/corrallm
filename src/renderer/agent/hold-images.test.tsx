import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConnectionDescriptor } from '../../shared/adapter';
import type { Graph } from '../graph/flow';
import { GraphEditor } from '../test-graph';
import { fakeSessions } from '../test-sessions';
import { useCatalog as adoptCatalog } from '../test-catalog';
import { renderReady, events } from '../test-render';
import type { FakeCanvas } from '../test-canvas';
import { expectOneOp } from '../test-api';
import { made, settle } from './test-agent-view';

// jsdom cannot draw xterm.js: a fake terminal stands in.
vi.mock('../terminal/screen', async () => {
  const { fakeScreens } = await import('../terminal/test-screen');
  return { createScreen: fakeScreens.create };
});

const PNG: ConnectionDescriptor['images'] = { types: ['image/png'], maxBytes: 16, max: 1 };

/** FileReaders that finish at once with the file's bytes. */
class QuickReader {
  result: string | null = null;
  onload: (() => void) | null = null;
  readAsDataURL(of: File) {
    void of.arrayBuffer().then((buffer) => {
      this.result = `data:${of.type};base64,${btoa(String.fromCharCode(...new Uint8Array(buffer)))}`;
      this.onload?.();
    });
  }
}
beforeEach(() => {
  vi.stubGlobal('FileReader', QuickReader);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/*
 * A problem hold's reply goes to the agent whose task failed (src/main/core/run-replies.ts), and
 * its images are held to that agent's connection, not to the agent whose view answers it.
 */

/** Viewed agent `a` (zed.acp, images `viewed`) holding on `b`'s failed task (zed.free, `target`). */
async function held(
  viewed: ConnectionDescriptor['images'],
  target: ConnectionDescriptor['images'],
  asking = true,
) {
  const catalog = made((connections) => {
    const acp = connections['zed.acp'];
    const free = connections['zed.free'];
    if (!acp || !free) throw new Error('The fixture needs its connections.');
    acp.images = viewed;
    free.images = target;
  });
  await adoptCatalog(catalog);
  const fake = fakeSessions();
  const graph: Graph = {
    nodes: [
      {
        id: 'a',
        type: 'agent',
        position: { x: 0, y: 0 },
        data: {
          label: 'a',
          connection: 'zed.acp',
          queue: [{ id: 'ok', by: 'you', action: 'shell', target: 'b' }] as never,
        },
      },
      {
        id: 'b',
        type: 'agent',
        position: { x: 300, y: 0 },
        data: { label: 'b', connection: 'zed.free' },
      },
    ],
    edges: [],
  };
  const box: { canvas?: FakeCanvas } = {};
  const { container } = await renderReady(
    <GraphEditor
      initialGraph={graph}
      sessionReplies={fake.replies}
      onCanvas={(made) => {
        box.canvas = made;
      }}
    />,
  );
  const canvas = box.canvas;
  if (!canvas) throw new Error('No fake canvas');
  const hold = () => {
    act(() => {
      canvas.run({
        running: true,
        agents: {
          a: {
            current: 'ok',
            status: 'asking',
            outcomes: {},
            problem: { kind: 'failed', reason: 'failed', text: 'b failed', agent: 'b' },
          },
        },
      });
    });
  };
  if (asking) hold();
  const card = container.querySelector<HTMLElement>('.react-flow__node[data-id="a"]');
  if (!card) throw new Error('no agent');
  await events.doubleClick(card);
  await settle();
  act(() => {
    fake.emit('a', 'zed.acp', {
      type: 'started',
      role: 'append',
      resume: true,
      list: true,
      model: null,
      mode: null,
      models: [],
    });
  });
  const view = within(screen.getByRole('dialog', { name: 'a' }));
  const composer = view.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message a' });
  const png = new File([new Uint8Array(4)], 'shot.png', { type: 'image/png' });
  const paste = async () => {
    fireEvent.paste(composer, { clipboardData: { files: [png], getData: () => '' } });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  };
  return { canvas, view, composer, paste, hold, fake };
}

describe('images in the reply to a problem hold', () => {
  it('are refused at the paste when the agent the reply goes to takes none', async () => {
    const { view, paste } = await held(PNG, null);
    await paste();
    expect(view.getByRole('alert').textContent).toContain('b');
    expect(view.getByRole('alert').textContent).toContain('takes no images');
    expect(view.queryByRole('img', { name: 'Image 1' })).toBeNull();
  });

  it('are kept with the draft when the hold arrives after they were pasted, and nothing is sent', async () => {
    const { canvas, view, composer, paste, hold } = await held(PNG, null, false);
    await paste();
    expect(view.getByRole('img', { name: 'Image 1' })).toBeTruthy();
    hold();
    await events.change(composer, { target: { value: 'Try again' } });
    const before = canvas.core.operations.length;
    await events.keyDown(composer, { key: 'Enter' });
    await settle();
    expect(canvas.core.operations.slice(before)).toEqual([]);
    expect(view.getByRole('alert').textContent).toContain('takes no images');
    expect(composer.value).toBe('Try again');
    expect(view.getByRole('img', { name: 'Image 1' })).toBeTruthy();
  });

  it('go to the agent that takes them, though the viewed agent takes none', async () => {
    const { canvas, view, composer, paste } = await held(null, PNG);
    await paste();
    expect(view.getByRole('img', { name: 'Image 1' })).toBeTruthy();
    await events.change(composer, { target: { value: 'Try again' } });
    const before = canvas.core.operations.length;
    await events.keyDown(composer, { key: 'Enter' });
    await settle();
    const sent = canvas.core.operations.slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.op).toBe('reply');
    expect(JSON.stringify(sent[0]?.args)).toContain('"images"');
    expectOneOp({ operations: sent }, 'reply', sent[0]?.args);
  });
});
