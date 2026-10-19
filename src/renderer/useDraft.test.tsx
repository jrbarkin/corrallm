import { act, fireEvent, render, screen } from '@testing-library/react';
import { useLayoutEffect, useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import { flushDrafts, useDraft } from './useDraft';
import { fakeCore, expectOneOp } from './test-api';

function Field({
  value = 'Original',
  commit = () => undefined,
  multiline = false,
}: {
  value?: string;
  commit?: (text: string) => void;
  multiline?: boolean;
}) {
  const draft = useDraft(value, commit, { multiline });
  return multiline ? (
    <textarea aria-label="Text" {...draft} />
  ) : (
    <input aria-label="Text" {...draft} />
  );
}

function Echo({ commit }: { commit: (text: string) => void }) {
  const [value, setValue] = useState('Original');
  return (
    <>
      <Field
        value={value}
        commit={(text) => {
          commit(text);
          setValue(text);
        }}
      />
      <output>{value}</output>
    </>
  );
}

const field = () => screen.getByRole<HTMLInputElement>('textbox', { name: 'Text' });
const type = (text: string) => {
  act(() => {
    field().focus();
  });
  fireEvent.change(field(), { target: { value: text } });
};

afterEach(() => {
  vi.useRealTimers();
});

it.each(['blur', 'Enter', 'idle'] as const)(
  'commits only on %s, once, and only if text changed',
  (how) => {
    vi.useFakeTimers();
    const commit = vi.fn();
    render(<Echo commit={commit} />);
    type('Draft');
    expect(commit).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(599);
    });
    expect(commit).not.toHaveBeenCalled();
    if (how === 'blur') fireEvent.blur(field());
    else if (how === 'Enter') fireEvent.keyDown(field(), { key: 'Enter' });
    else
      act(() => {
        vi.advanceTimersByTime(1);
      });
    expect(commit).toHaveBeenCalledExactlyOnceWith('Draft');
    fireEvent.blur(field());
    act(() => {
      vi.advanceTimersByTime(1000);
      void flushDrafts();
    });
    expect(commit).toHaveBeenCalledOnce();
    type('Draft');
    fireEvent.blur(field());
    expect(commit).toHaveBeenCalledOnce();
  },
);

it('counts idle time from the last keystroke', () => {
  vi.useFakeTimers();
  const commit = vi.fn();
  render(<Echo commit={commit} />);
  type('D');
  act(() => {
    vi.advanceTimersByTime(500);
  });
  type('Draft');
  act(() => {
    vi.advanceTimersByTime(599);
  });
  expect(commit).not.toHaveBeenCalled();
  act(() => {
    vi.advanceTimersByTime(1);
  });
  expect(commit).toHaveBeenCalledExactlyOnceWith('Draft');
});

it('Escape restores the original text and leaves nothing to commit', () => {
  vi.useFakeTimers();
  const commit = vi.fn();
  render(<Field commit={commit} />);
  type('Discard');
  fireEvent.keyDown(field(), { key: 'Escape' });
  expect(field().value).toBe('Original');
  fireEvent.blur(field());
  act(() => {
    vi.advanceTimersByTime(1000);
    void flushDrafts();
  });
  expect(commit).not.toHaveBeenCalled();
});

it('leaves multiline Enter to the textarea, keeping the line break in its draft', () => {
  const commit = vi.fn();
  render(<Field commit={commit} multiline />);
  type('First');
  expect(fireEvent.keyDown(field(), { key: 'Enter' })).toBe(true);
  // jsdom does not implement the browser's default insertion of a line break.
  fireEvent.change(field(), { target: { value: 'First\nSecond' } });
  expect(field().value).toBe('First\nSecond');
  expect(commit).not.toHaveBeenCalled();
  fireEvent.blur(field());
  expect(commit).toHaveBeenCalledExactlyOnceWith('First\nSecond');
});

it('protects an uncommitted focused draft from outside changes, then shows the current value on leave', () => {
  const commit = vi.fn();
  const view = render(<Field commit={commit} />);
  type('Mine');
  view.rerender(<Field value="Elsewhere" commit={commit} />);
  expect(field().value).toBe('Mine');
  fireEvent.blur(field());
  expect(commit).toHaveBeenCalledExactlyOnceWith('Mine');
  expect(field().value).toBe('Elsewhere');
});

it('flushes all drafts before a pointer gesture and before a shortcut, with React changes applied', () => {
  const commit = vi.fn();
  render(
    <>
      <Echo commit={commit} />
      <button type="button">Drag or act</button>
    </>,
  );
  type('Pointer');
  fireEvent.pointerDown(screen.getByRole('button'));
  expect(screen.getByRole('status').textContent).toBe('Pointer');
  type('Shortcut');
  fireEvent.keyDown(document.body, { key: 's', metaKey: true });
  expect(screen.getByRole('status').textContent).toBe('Shortcut');
  expect(commit.mock.calls).toEqual([['Pointer'], ['Shortcut']]);
});

it('does not commit while moving the caret in a focused draft', () => {
  const commit = vi.fn();
  render(<Field commit={commit} />);
  type('Draft');
  fireEvent.pointerDown(field());
  fireEvent.click(field());
  fireEvent.keyDown(field(), { key: 'ArrowLeft' });
  expect(commit).not.toHaveBeenCalled();
});

it('keeps text selection, undo and clipboard shortcuts local to the focused field', () => {
  const commit = vi.fn();
  render(<Field commit={commit} />);
  type('Draft');
  for (const key of ['a', 'z', 'c', 'v', 'x']) fireEvent.keyDown(field(), { key, ctrlKey: true });
  expect(commit).not.toHaveBeenCalled();
});

it('leaves Escape available to the surrounding panel when nothing is pending', () => {
  render(<Field />);
  act(() => {
    field().focus();
  });
  expect(fireEvent.keyDown(field(), { key: 'Escape' })).toBe(true);
});

it('removes a departing field’s pending timer and draft', () => {
  vi.useFakeTimers();
  const commit = vi.fn();
  const view = render(<Field commit={commit} />);
  type('Old canvas');
  view.unmount();
  act(() => {
    vi.advanceTimersByTime(1000);
    void flushDrafts();
  });
  expect(commit).not.toHaveBeenCalled();
});

it('flushes every pending field once from the window’s registry', () => {
  const one = vi.fn();
  const two = vi.fn();
  render(
    <>
      <Field commit={one} />
      <Field commit={two} />
    </>,
  );
  for (const [i, input] of screen.getAllByRole('textbox').entries())
    fireEvent.change(input, { target: { value: `Draft ${String(i)}` } });
  act(() => {
    void flushDrafts();
    void flushDrafts();
  });
  expect(one).toHaveBeenCalledExactlyOnceWith('Draft 0');
  expect(two).toHaveBeenCalledExactlyOnceWith('Draft 1');
});

it.each(['pending', 'already started'] as const)(
  'awaits a %s draft commit before sending an operation',
  async (how) => {
    const core = fakeCore();
    const saving = Promise.withResolvers<undefined>();
    const commit = vi.fn(() => saving.promise);
    render(<Field commit={commit} />);
    type('Draft');
    if (how === 'already started') fireEvent.blur(field());
    const called = core.api.linkOpen({ url: 'https://example.com' });
    expect(commit).toHaveBeenCalledExactlyOnceWith('Draft');
    await Promise.resolve();
    expect(core.operations).toEqual([]);
    saving.resolve(undefined);
    await called;
    expectOneOp(core, 'link.open', { url: 'https://example.com' });
    core.dispose();
  },
);

it('lets a draft send its own operation while the following operation waits for its topic revision', async () => {
  const core = fakeCore();
  core.snapshot('usage', { readings: [], rules: {} }, 0);
  core.respond('usage.setRule', { revs: { usage: 1 } });
  render(<Field commit={() => core.api.usageSetRule({ backend: 'codex', rule: null })} />);
  type('Draft');
  const called = core.api.linkOpen({ url: 'https://example.com' });
  await vi.waitFor(() => {
    expectOneOp(core, 'usage.setRule', { backend: 'codex', rule: null });
  });
  core.change({ topic: 'usage', rev: 1, replace: { readings: [], rules: {} } });
  await called;
  expect(core.operations.map(({ op }) => op)).toEqual(['usage.setRule', 'link.open']);
  core.dispose();
});

it('waits for a draft before an operation started by a React layout effect during the flush', async () => {
  const core = fakeCore();
  core.snapshot('usage', { readings: [], rules: {} });
  core.respond('usage.setRule', { revs: { usage: 1 } });
  const calls: Promise<unknown>[] = [];
  function Editor() {
    const [changed, setChanged] = useState(false);
    useLayoutEffect(() => {
      if (changed) calls.push(core.api.linkOpen({ url: 'https://example.com' }));
    }, [changed]);
    return (
      <Field
        commit={() => {
          setChanged(true);
          return core.api.usageSetRule({ backend: 'codex', rule: null });
        }}
      />
    );
  }
  render(<Editor />);
  type('Draft');
  act(() => {
    calls.push(flushDrafts());
  });
  try {
    await vi.waitFor(() => {
      expect(core.operations).not.toEqual([]);
    });
    expectOneOp(core, 'usage.setRule', { backend: 'codex', rule: null });
  } finally {
    core.change({ topic: 'usage', rev: 1, replace: { readings: [], rules: {} } });
    await Promise.all(calls);
    core.dispose();
  }
});

it('awaits an operation sent by a draft even when its UI callback returns void', async () => {
  const core = fakeCore();
  core.snapshot('usage', { readings: [], rules: {} });
  core.respond('usage.setRule', { revs: { usage: 1 } });
  let committed: Promise<unknown> | undefined;
  render(
    <Field
      commit={() => {
        committed = core.api.usageSetRule({ backend: 'codex', rule: null });
      }}
    />,
  );
  type('Draft');
  const called = core.api.linkOpen({ url: 'https://example.com' });
  try {
    await vi.waitFor(() => {
      expect(core.operations).not.toEqual([]);
    });
    expectOneOp(core, 'usage.setRule', { backend: 'codex', rule: null });
  } finally {
    core.change({ topic: 'usage', rev: 1, replace: { readings: [], rules: {} } });
    await Promise.all([committed, called]);
    core.dispose();
  }
});
