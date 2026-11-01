import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { newCanvasId } from '../../shared/canvas';
import { AgentId } from '../../shared/api/ids';
import type { CanvasDocument } from '../../shared/model/canvas';
import type { NeedsItem } from '../../shared/model/needs';
import { NEW_SESSION } from '../../shared/model/session';
import { sessionView } from '../../shared/model/views';
import { expectOneOp } from '../test-api';
import { fakeCanvas } from '../test-canvas';
import { events } from '../test-render';
import { useDraft } from '../useDraft';
import { GraphEditor } from './GraphEditor';

vi.mock('../terminal/screen', async () => ({
  createScreen: (await import('../terminal/test-screen')).fakeScreens.create,
}));

const cores: ReturnType<typeof fakeCanvas>['core'][] = [];
const releases: (() => void)[] = [];
afterEach(async () => {
  await act(() => {
    releases.splice(0).forEach((release) => {
      release();
    });
    return Promise.resolve();
  });
  cleanup();
  cores.splice(0).forEach((core) => {
    core.dispose();
  });
});

function document(label: string): CanvasDocument {
  return {
    id: newCanvasId(),
    arrange: false,
    nodes: [{ id: label, type: 'agent', position: { x: 0, y: 0 }, data: { label } }],
    links: [],
  };
}
function setup() {
  const first = document('Before'),
    next = document('After');
  const canvas = fakeCanvas(first);
  cores.push(canvas.core);
  canvas.open(next);
  canvas.open(first);
  canvas.core.respond('window.show', { revs: {} });
  const need: NeedsItem = {
    id: 'file/11111111-1111-4111-8111-111111111111',
    canvas: next.id,
    kind: 'file',
    for: 'you',
    by: ['you'],
    title: 'Review the changed file',
    choices: [{ value: 'keep', label: 'Keep' }],
    answerIn: 'api',
  };
  canvas.core.snapshot(`needs:${next.id}`, { items: [need] });
  return { first, next, canvas, need };
}
function Draft({ commit }: { commit: (text: string) => Promise<void> }) {
  const { problem, ...field } = useDraft('Saved', commit);
  return <input aria-label="Pending text" {...field} aria-description={problem} />;
}
async function bound(container: HTMLElement) {
  await waitFor(() => {
    expect(container.querySelector('.graph-editor')).toHaveProperty('ariaBusy', 'false');
  });
}

it('flushes drafts, shows once and binds every topic before focusing the current Need', async () => {
  const { first, next, canvas, need } = setup();
  const draft = Promise.withResolvers<undefined>();
  const snapshot = Promise.withResolvers<undefined>();
  releases.push(() => {
    draft.resolve(undefined);
    snapshot.resolve(undefined);
  });
  const commit = vi.fn(() => draft.promise);
  const whenAt = canvas.core.topics.whenAt.bind(canvas.core.topics);
  vi.spyOn(canvas.core.topics, 'whenAt').mockImplementation((topic, rev) =>
    topic === `messages:${next.id}` ? snapshot.promise : whenAt(topic, rev),
  );
  const view = render(
    <>
      <Draft commit={commit} />
      <GraphEditor canvas={first.id} client={canvas.core.api} mirror={canvas.core.topics} />
    </>,
  );
  await bound(view.container);
  const field = screen.getByRole('textbox', { name: 'Pending text' });
  await events.focus(field);
  await events.change(field, { target: { value: 'Finish this draft' } });
  // The destination is the entire instruction; other fields never become operations or input.
  const target = { canvas: next.id, need: need.id, answer: { choice: 'keep' }, body: 'Run this' };
  act(() => {
    canvas.core.show(target);
  });
  await waitFor(() => {
    expect(commit).toHaveBeenCalledExactlyOnceWith('Finish this draft');
  });
  expect(canvas.core.operations).toEqual([]);
  expect(view.container.querySelector('.graph-editor')).toHaveProperty('ariaBusy', 'true');
  await act(() => {
    draft.resolve(undefined);
    return Promise.resolve();
  });
  await waitFor(() => {
    expectOneOp(canvas.core, 'window.show', { canvas: next.id });
  });
  for (const topic of ['canvas', 'run', 'needs', 'sessions', 'messages'])
    expect(canvas.core.subscriptions.has(`${topic}:${next.id}` as never)).toBe(true);
  expect(screen.queryByRole('dialog', { name: 'Needs you' })).toBeNull();
  expect(view.container.querySelector('.graph-editor')).toHaveProperty('ariaBusy', 'true');
  await act(() => {
    snapshot.resolve(undefined);
    return Promise.resolve();
  });
  await bound(view.container);
  const card = await screen.findByRole('article', { name: need.title });
  await waitFor(() => {
    expect(window.document.activeElement).toBe(card);
  });
  expect(view.container.querySelector('.react-flow__node[data-id="After"]')).not.toBeNull();
  expectOneOp(canvas.core, 'window.show', { canvas: next.id });
});

it('retains a show received while the initial window binding is loading', async () => {
  const { first, next, canvas, need } = setup();
  const opening = Promise.withResolvers<{ ok: true; value: { canvas: string } }>();
  canvas.core.reply('window.get', () => opening.promise);
  render(<GraphEditor client={canvas.core.api} mirror={canvas.core.topics} />);
  act(() => {
    canvas.core.show({ canvas: next.id, need: need.id });
  });
  await act(() => {
    opening.resolve({ ok: true, value: { canvas: first.id } });
    return Promise.resolve();
  });
  const card = await screen.findByRole('article', { name: need.title });
  await waitFor(() => {
    expect(window.document.activeElement).toBe(card);
  });
  expectOneOp(canvas.core, 'window.show', { canvas: next.id });
});

it('shows the same canvas once and refocuses a current Need after it was dismissed', async () => {
  const { first, canvas, need } = setup();
  canvas.core.snapshot(`needs:${first.id}`, { items: [{ ...need, canvas: first.id }] });
  const view = render(
    <GraphEditor canvas={first.id} client={canvas.core.api} mirror={canvas.core.topics} />,
  );
  await bound(view.container);
  for (let click = 0; click < 2; click++) {
    canvas.core.operations.length = 0;
    act(() => {
      canvas.core.show({ canvas: first.id, need: need.id });
    });
    const card = await screen.findByRole('article', { name: need.title });
    await waitFor(() => {
      expect(window.document.activeElement).toBe(card);
    });
    expectOneOp(canvas.core, 'window.show', { canvas: first.id });
    await events.keyDown(card, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Needs you' })).toBeNull();
  }
});

it.each([undefined, 'file/no-longer-current'])('shows only the canvas for Need %s', async (id) => {
  const { first, next, canvas, need } = setup();
  const view = render(
    <GraphEditor canvas={first.id} client={canvas.core.api} mirror={canvas.core.topics} />,
  );
  await bound(view.container);
  act(() => {
    canvas.core.show({ canvas: next.id, ...(id ? { need: id } : {}) });
  });
  await waitFor(() => {
    expect(view.container.querySelector('.react-flow__node[data-id="After"]')).not.toBeNull();
  });
  await bound(view.container);
  expectOneOp(canvas.core, 'window.show', { canvas: next.id });
  expect(screen.queryByRole('dialog', { name: 'Needs you' })).toBeNull();
  if (id) {
    act(() => {
      canvas.core.change({
        topic: `needs:${next.id}`,
        rev: 1,
        replace: { items: [{ ...need, id }] },
      });
    });
    expect(screen.queryByRole('dialog', { name: 'Needs you' })).toBeNull();
  }
});

it('keeps the previous binding and reports a refused show without focusing a Need', async () => {
  const { first, next, canvas, need } = setup();
  canvas.core.reply('window.show', {
    ok: false,
    error: { code: 'not-found', sentence: 'That canvas is closed.' },
  });
  const view = render(
    <GraphEditor canvas={first.id} client={canvas.core.api} mirror={canvas.core.topics} />,
  );
  await bound(view.container);
  act(() => {
    canvas.core.show({ canvas: next.id, need: need.id });
  });
  expect((await screen.findByRole('alert')).textContent).toContain('That canvas is closed.');
  await bound(view.container);
  expect(view.container.querySelector('.react-flow__node[data-id="Before"]')).not.toBeNull();
  expect(screen.queryByRole('dialog', { name: 'Needs you' })).toBeNull();
  expectOneOp(canvas.core, 'window.show', { canvas: next.id });
});

it('listens once through StrictMode and removes its show listener on unmount', async () => {
  const { first, canvas } = setup();
  const view = render(
    <StrictMode>
      <GraphEditor canvas={first.id} client={canvas.core.api} mirror={canvas.core.topics} />
    </StrictMode>,
  );
  await bound(view.container);
  act(() => {
    canvas.core.show({ canvas: first.id });
  });
  await waitFor(() => {
    expectOneOp(canvas.core, 'window.show', { canvas: first.id });
  });
  await bound(view.container);
  view.unmount();
  canvas.core.operations.length = 0;
  act(() => {
    canvas.core.show({ canvas: first.id });
  });
  expect(canvas.core.operations).toEqual([]);
});

it('focuses the current native Terminal Need without sending or opening its session', async () => {
  const { first, next, canvas, need } = setup();
  const id = AgentId.parse('After');
  const prompt = {
    ...need,
    id: 'prompt/After/0/native',
    agent: 'After',
    kind: 'prompt' as const,
    answerIn: 'terminal' as const,
    choices: [],
  };
  canvas.core.snapshot(`needs:${next.id}`, { items: [prompt] });
  canvas.core.snapshot(`sessions:${next.id}`, {
    agents: {
      [id]: sessionView(id, 'claude-code.terminal', {
        ...NEW_SESSION,
        asking: [{ kind: 'trust', id: 'native' }],
      }).summary,
    },
  });
  const view = render(
    <GraphEditor canvas={first.id} client={canvas.core.api} mirror={canvas.core.topics} />,
  );
  await bound(view.container);
  act(() => {
    canvas.core.show({ canvas: next.id, need: prompt.id });
  });
  const card = await screen.findByRole('group', { name: 'After asks, in its terminal' });
  await waitFor(() => {
    expect(window.document.activeElement).toBe(card);
  });
  expectOneOp(canvas.core, 'window.show', { canvas: next.id });
  expect(screen.queryByRole('dialog', { name: 'After' })).toBeNull();
});
