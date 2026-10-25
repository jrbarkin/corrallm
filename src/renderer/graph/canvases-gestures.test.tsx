import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { newCanvasId } from '../../shared/canvas';
import type { CanvasDocument } from '../../shared/model/canvas';
import type { NeedsItem } from '../../shared/model/needs';
import { automaticBackend } from '../../shared/engine/test-backend';
import { fakeCanvas } from '../test-canvas';
import { expectOneOp } from '../test-api';
import { events } from '../test-render';
import { GraphEditor } from './GraphEditor';
vi.mock('../terminal/screen', async () => ({
  createScreen: (await import('../terminal/test-screen')).fakeScreens.create,
}));

const stops: (() => void)[] = [];
afterEach(() => {
  cleanup();
  stops.splice(0).forEach((stop) => {
    stop();
  });
});
const document = (label: string): CanvasDocument => ({
  id: newCanvasId(),
  arrange: false,
  nodes: [{ id: label, type: 'agent', position: { x: 0, y: 0 }, data: { label } }],
  links: [],
});

async function switchingView(needs: NeedsItem[] = []) {
  const first = document('Before');
  first.nodes = [
    {
      id: 'Before',
      type: 'agent',
      position: { x: 0, y: 0 },
      data: { label: 'Before', adapter: 'claude-code', connection: 'claude-code.sdk' },
    },
  ];
  const next = document('After');
  const fake = automaticBackend();
  const canvas = fakeCanvas(first, fake.backend);
  stops.push(() => {
    canvas.core.dispose();
  });
  canvas.open(next);
  canvas.open(first);
  canvas.core.snapshot('canvases', {
    items: [first, next].map((doc) => ({
      canvas: doc.id,
      name: doc === first ? 'before.corral' : 'after.corral',
      edited: false,
      running: false,
      open: true,
      project: null,
      shownIn: doc === first ? [1] : [],
    })),
  });
  canvas.core.snapshot(`needs:${first.id}`, {
    items: needs.map((item) => ({ ...item, canvas: first.id })),
  });
  const view = render(
    <GraphEditor
      canvas={first.id}
      client={canvas.core.api}
      mirror={canvas.core.topics}
      files
      sessionQueries={{ ...fake.backend, manual: canvas.manual, presentation: canvas.presentation }}
    />,
  );
  await waitFor(() => {
    expect(view.container.querySelector('.graph-editor')?.hasAttribute('inert')).toBe(false);
  });
  return { ...view, first, next, canvas, fake };
}

const proposal: NeedsItem = {
  id: 'proposal/11111111-1111-4111-8111-111111111111',
  canvas: newCanvasId(),
  kind: 'proposal',
  for: 'you',
  by: ['you'],
  title: 'Close this canvas',
  choices: [{ value: 'allow', label: 'Allow' }],
  answerIn: 'api',
};

it('keeps live sessions and the core runtime when Open returns the shown canvas', async () => {
  const { canvas, first, fake, container } = await switchingView();
  const node = container.querySelector('.react-flow__node[data-id="Before"]');
  if (!node) throw new Error('No Before node');
  await events.doubleClick(node);
  canvas.core.operations.length = 0;
  const composer = await screen.findByRole('textbox', { name: 'Message Before' });
  await events.change(composer, { target: { value: 'Keep this manual work' } });
  await events.keyDown(composer, { key: 'Enter' });
  await waitFor(() => {
    expect(fake.backend.send).toHaveBeenCalledOnce();
  });
  await events.click(screen.getByRole('button', { name: 'Back to the canvas' }));
  canvas.core.respond('canvas.open', { canvas: first.id, revs: {} });
  await events.keyDown(window.document.body, { key: 'o', ctrlKey: true });
  await waitFor(() => {
    expectOneOp(canvas.core, 'canvas.open', {});
    expect(container.querySelector('.graph-editor')?.getAttribute('aria-busy')).toBe('false');
  });
  expect(fake.backend.close).not.toHaveBeenCalled();
  expect(canvas.document.id).toBe(first.id);
  await events.doubleClick(node);
  canvas.core.operations.length = 0;
  expect(screen.getAllByText('Keep this manual work').length).toBeGreaterThan(0);
  expect(canvas.engine.sessions.of('Before').submissions?.at(-1)?.text).toBe(
    'Keep this manual work',
  );
});

it('closes All queues opened from an agent when the window switches to another canvas', async () => {
  const { canvas, next, container } = await switchingView();
  const node = container.querySelector('.react-flow__node[data-id="Before"]');
  if (!node) throw new Error('No Before node');
  await events.doubleClick(node);
  canvas.core.operations.length = 0;
  await screen.findByRole('dialog', { name: 'Before' });
  await events.click(screen.getByRole('button', { name: 'Show all queues' }));
  expect(screen.getByRole('dialog', { name: 'All queues' })).toBeTruthy();
  canvas.core.reply('window.show', () => {
    canvas.open(next);
    return Promise.resolve({ ok: true, value: { revs: {} } });
  });
  await events.click(screen.getByRole('button', { name: 'Canvas menu' }));
  await events.click(screen.getByRole('button', { name: 'Canvases' }));
  await events.click(await screen.findByRole('button', { name: 'Show after.corral' }));
  await waitFor(() => {
    expect(container.querySelector('.react-flow__node[data-id="After"]')).not.toBeNull();
    expect(container.querySelector('.graph-editor')?.getAttribute('aria-busy')).toBe('false');
  });
  expectOneOp(canvas.core, 'window.show', { canvas: next.id });
  expect(screen.queryByRole('dialog', { name: 'All queues' })).toBeNull();
  expect(container.querySelector('.graph-editor')?.getAttribute('data-canvas-view')).toBe('graph');
});
it.each(['show', 'close', 'allow'] as const)(
  'shows recovery when the %s switch cannot read the replacement run',
  async (action) => {
    const { canvas, first, next } = await switchingView(action === 'allow' ? [proposal] : []);
    vi.spyOn(canvas.core.topics, 'failure').mockImplementation((topic) =>
      topic === `run:${next.id}` ? 'The replacement run cannot be read' : undefined,
    );
    const revision = canvas.core.topics.revision.bind(canvas.core.topics);
    vi.spyOn(canvas.core.topics, 'revision').mockImplementation((topic) =>
      topic === `run:${next.id}` ? undefined : revision(topic),
    );
    const op = action === 'show' ? 'window.show' : action === 'close' ? 'canvas.close' : 'reply';
    canvas.core.reply(op, () => {
      canvas.open(next);
      return Promise.resolve({
        ok: true,
        value: {
          ...(action === 'show' ? {} : { canvas: next.id }),
          ...(action === 'allow' ? { outcome: 'allowed' } : {}),
          revs: {},
        },
      });
    });
    if (action === 'allow') {
      await events.click(screen.getByRole('button', { name: 'Needs you' }));
      await events.click(await screen.findByRole('button', { name: 'Allow' }));
    } else {
      await events.click(screen.getByRole('button', { name: 'Canvas menu' }));
      await events.click(screen.getByRole('button', { name: 'Canvases' }));
      await events.click(
        await screen.findByRole('button', {
          name: action === 'show' ? 'Show after.corral' : 'Close before.corral',
        }),
      );
    }
    expect(await screen.findByRole('toolbar', { name: 'Canvas recovery' })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('The replacement run cannot be read');
    expectOneOp(
      canvas.core,
      op,
      action === 'show'
        ? { canvas: next.id }
        : action === 'close'
          ? { canvas: first.id }
          : { canvas: first.id, to: proposal.id, answer: { choice: 'allow' } },
    );
  },
);

it.each([
  ['stalled/Before', 'interrupt', 'Interrupt'],
  ['file/22222222-2222-4222-8222-222222222222', 'keep', 'Keep'],
  [proposal.id, 'refuse', 'Refuse'],
] as const)(
  'keeps other sends usable while %s awaits its non-moving reply',
  async (id, choice, label) => {
    const item: NeedsItem = {
      ...proposal,
      id,
      kind: id.startsWith('file/') ? 'file' : id.startsWith('stalled/') ? 'prompt' : 'proposal',
      choices: [{ value: choice, label }],
    };
    const { canvas, first, fake, container } = await switchingView([item]);
    const pending = Promise.withResolvers<{ ok: true; value: { revs: Record<string, number> } }>();
    canvas.core.reply('reply', () => pending.promise);
    try {
      await events.click(screen.getByRole('button', { name: 'Needs you' }));
      await events.click(await screen.findByRole('button', { name: label }));
      expectOneOp(canvas.core, 'reply', { canvas: first.id, to: id, answer: { choice } });
      expect(container.querySelector('.graph-editor')?.hasAttribute('inert')).toBe(false);
      const node = container.querySelector('.react-flow__node[data-id="Before"]');
      if (!node) throw new Error('No Before node');
      await events.doubleClick(node);
      canvas.core.operations.length = 0;
      const composer = await screen.findByRole('textbox', { name: 'Message Before' });
      await events.change(composer, { target: { value: 'Independent manual work' } });
      await events.keyDown(composer, { key: 'Enter' });
      await waitFor(() => {
        expect(fake.backend.send).toHaveBeenCalledOnce();
      });
    } finally {
      await act(() => {
        pending.resolve({ ok: true, value: { revs: {} } });
        return Promise.resolve();
      });
    }
  },
);
it.each(['show', 'close', 'allow'] as const)(
  '%s is one operation, binding all replacement snapshots without saving or resetting a run',
  async (action) => {
    const first = document('Before'),
      next = document('After');
    const fake = automaticBackend();
    const canvas = fakeCanvas(first, fake.backend);
    stops.push(() => {
      canvas.core.dispose();
    });
    canvas.open(next);
    canvas.open(first);
    canvas.core.snapshot('canvases', {
      items: [first, next].map((doc) => ({
        canvas: doc.id,
        name: doc === first ? 'before.corral' : 'after.corral',
        edited: true,
        running: false,
        open: true,
        project: null,
        shownIn: doc === first ? [1] : [],
      })),
    });
    const proposal = 'proposal/11111111-1111-4111-8111-111111111111';
    if (action === 'allow')
      canvas.core.snapshot(`needs:${first.id}`, {
        items: [
          {
            id: proposal,
            canvas: first.id,
            kind: 'proposal',
            for: 'you',
            by: ['you'],
            title: 'Close this canvas',
            choices: [{ value: 'allow', label: 'Allow' }],
            answerIn: 'api',
          },
        ],
      });
    const order: string[] = [];
    const op = action === 'show' ? 'window.show' : action === 'close' ? 'canvas.close' : 'reply';
    canvas.core.reply(op, () => {
      order.push('op');
      canvas.open(next);
      return Promise.resolve({
        ok: true,
        value: {
          ...(action === 'show' ? {} : { canvas: next.id }),
          ...(action === 'allow' ? { outcome: 'allowed' } : {}),
          revs: {},
        },
      });
    });
    const view = render(
      <GraphEditor
        canvas={first.id}
        client={canvas.core.api}
        mirror={canvas.core.topics}
        files
        sessionQueries={{
          ...canvas.queries,
          manual: canvas.manual,
          presentation: canvas.presentation,
        }}
      />,
    );
    await waitFor(() => {
      expect(view.container.querySelector('.graph-editor')?.hasAttribute('inert')).toBe(false);
    });
    order.length = 0;
    if (action === 'allow') {
      await events.click(screen.getByRole('button', { name: 'Needs you' }));
      await events.click(await screen.findByRole('button', { name: 'Allow' }));
    } else {
      await events.click(screen.getByRole('button', { name: 'Canvas menu' }));
      await events.click(screen.getByRole('button', { name: 'Canvases' }));
      await events.click(
        await screen.findByRole('button', {
          name: action === 'show' ? 'Show after.corral' : 'Close before.corral',
        }),
      );
    }
    await waitFor(() => {
      expect(screen.queryByText('Before')).toBeNull();
    });
    expect(await screen.findByText('After')).toBeTruthy();
    await waitFor(() => {
      expect(view.container.querySelector('.graph-editor')?.hasAttribute('inert')).toBe(false);
    });
    expectOneOp(
      canvas.core,
      op,
      action === 'show'
        ? { canvas: next.id }
        : action === 'close'
          ? { canvas: first.id }
          : { canvas: first.id, to: proposal, answer: { choice: 'allow' } },
    );
    expect(order).toEqual(['op']);
    for (const topic of ['canvas', 'run', 'needs', 'sessions', 'messages'])
      expect(canvas.core.subscriptions.has(`${topic}:${next.id}` as never)).toBe(true);
    if (action === 'close') expect(screen.queryByText(/stays open/)).toBeNull();
    if (action === 'allow')
      expect((await screen.findByRole('status')).textContent).toContain('allowed');
  },
);
