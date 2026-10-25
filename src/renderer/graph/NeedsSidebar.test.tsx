import { cleanup, render, screen, waitFor, act, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import type { NeedsItem } from '../../shared/model/needs';
import type { CanvasNode } from '../../shared/model/canvas';
import { newCanvasId } from '../../shared/canvas';
import { fakeCore, expectOneOp } from '../test-api';
import { events } from '../test-render';
import { NeedsSidebar } from './NeedsSidebar';
import css from './GraphEditor.css?raw';
const cores: ReturnType<typeof fakeCore>[] = [];
const detailStyle = document.createElement('style');
afterEach(() => {
  detailStyle.remove();
  cleanup();
  cores.splice(0).forEach((core) => {
    core.dispose();
  });
});
const canvas = newCanvasId();
const proposal: NeedsItem = {
  id: 'proposal/11111111-1111-4111-8111-111111111111',
  canvas,
  kind: 'proposal',
  for: 'you',
  by: ['you'],
  title: 'Orchestrator asks to delete Reviewer',
  detail: '3 queued tasks and its conversation',
  choices: [
    { value: 'allow', label: 'Allow' },
    { value: 'refuse', label: 'Refuse' },
  ],
  answerIn: 'api',
};
const file: NeedsItem = {
  ...proposal,
  id: 'file/22222222-2222-4222-8222-222222222222',
  kind: 'file',
  title: 'team.corral changed on disk',
  detail: 'Reviewer’s queue changed',
  choices: [
    { value: 'apply', label: 'Apply' },
    { value: 'keep', label: 'Keep' },
  ],
};

it('preserves the exact command’s spaces and the setup preview’s separate lines', async () => {
  const detail = `Runs: printf 'a  b'\nIn: /a project/checkout`;
  const rule = /\n\.graph-question-detail \{([^}]+)\}/.exec(css)?.[1] ?? '';
  detailStyle.textContent = `.graph-question-detail { ${rule} }`;
  document.head.append(detailStyle);
  await setup([{ ...proposal, kind: 'worktree', detail }]);
  const preview = screen.getByText((_, node) => node?.textContent === detail);
  expect(preview.textContent).toBe(detail);
  expect(getComputedStyle(preview).whiteSpace).toBe('pre-wrap');
});

it('keeps a setup’s live Stop and Retry choices after its Run reply returns started', async () => {
  const item: NeedsItem = {
    ...proposal,
    id: 'setup/11111111-1111-4111-8111-111111111111/1',
    kind: 'worktree',
    title: 'Set up Builder’s worktree?',
    choices: [
      { value: 'run', label: 'Run' },
      { value: 'skip', label: 'Skip' },
    ],
  };
  const core = await setup([item]);
  core.reply('reply', () => {
    core.change({
      topic: `needs:${canvas}`,
      rev: 1,
      replace: {
        items: [
          {
            ...item,
            title: 'Setting up Builder’s worktree',
            choices: [{ value: 'stop', label: 'Stop' }],
          },
        ],
      },
    });
    return Promise.resolve({ ok: true, value: { outcome: 'started', revs: {} } });
  });
  await events.click(screen.getByRole('button', { name: 'Run' }));
  expectOneOp(core, 'reply', { canvas, to: item.id, answer: { choice: 'run' } });
  expect(await screen.findByRole('button', { name: 'Stop' })).toBeTruthy();
  act(() => {
    core.change({
      topic: `needs:${canvas}`,
      rev: 2,
      replace: {
        items: [
          {
            ...item,
            title: 'Setup failed in Builder’s worktree',
            choices: [
              { value: 'retry', label: 'Run again' },
              { value: 'skip', label: 'Skip' },
            ],
          },
        ],
      },
    });
  });
  expect(await screen.findByRole('button', { name: 'Run again' })).toBeTruthy();
});

it('shows the core’s persistent oversized-run warning without offering an answer', async () => {
  const problem: NeedsItem = {
    ...proposal,
    id: `unsaved/${canvas}`,
    kind: 'hold',
    by: [],
    title: 'Run progress is too large to save',
    detail: 'Messages are still recorded and delivered.',
    choices: [],
  };
  await setup([problem]);
  const card = screen.getByRole('article', { name: problem.title });
  expect(within(card).getByText(problem.detail ?? '')).toBeTruthy();
  expect(within(card).queryAllByRole('button')).toHaveLength(0);
});
async function setup(items: NeedsItem[], nodes: CanvasNode[] = []) {
  const core = fakeCore();
  cores.push(core);
  core.snapshot(`needs:${canvas}`, { items });
  render(
    <NeedsSidebar
      canvas={canvas}
      mirror={core.topics}
      nodes={nodes}
      onOpen={() => undefined}
      onReply={(to, answer) => core.api.reply({ canvas, to, answer })}
    />,
  );
  if (items.length > 0) {
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Needs you' })).not.toHaveProperty(
        'disabled',
        true,
      );
    });
    await events.click(screen.getByRole('button', { name: 'Needs you' }));
  }
  return core;
}
it.each([
  ['allow', 'Allow', 'allowed'],
  ['refuse', 'Refuse', 'refused'],
  ['allow', 'Allow', 'stale'],
  ['apply', 'Apply', 'applied'],
  ['keep', 'Keep', 'kept'],
  ['apply', 'Apply', 'superseded'],
] as const)(
  'answers %s with one reply and keeps the %s outcome after topic removal',
  async (choice, label, outcome) => {
    const item = choice === 'apply' || choice === 'keep' ? file : proposal;
    const core = await setup([item]);
    core.reply('reply', () => {
      core.change({ topic: `needs:${canvas}`, rev: 1, replace: { items: [] } });
      return Promise.resolve({ ok: true, value: { outcome, revs: {} } });
    });
    expect(await screen.findByText(item.title)).toBeTruthy();
    expect(screen.getByText(item.detail ?? '')).toBeTruthy();
    await events.click(await screen.findByRole('button', { name: label }));
    await waitFor(() => {
      expectOneOp(core, 'reply', { canvas, to: item.id, answer: { choice } });
    });
    expect((await screen.findByRole('status')).textContent.toLowerCase()).toContain(outcome);
    expect(screen.queryByRole('button', { name: label })).toBeNull();
    await events.click(screen.getByRole('button', { name: `Dismiss ${item.title}` }));
    expect(screen.queryByRole('complementary', { name: 'Needs you' })).toBeNull();
  },
);
it('shows one current review from pushed state and Keep alone for an invalid file', async () => {
  const core = await setup([]);
  expect(screen.queryByRole('complementary')).toBeNull();
  act(() => {
    core.change({
      topic: `needs:${canvas}`,
      rev: 1,
      replace: { items: [{ ...file, choices: [{ value: 'keep', label: 'Keep' }] }] },
    });
  });
  await waitFor(() => {
    expect(screen.getByRole('button', { name: 'Needs you' })).not.toHaveProperty('disabled', true);
  });
  await events.click(screen.getByRole('button', { name: 'Needs you' }));
  const sidebar = await screen.findByRole('complementary', { name: 'Needs you' });
  expect(within(sidebar).getAllByText(file.title)).toHaveLength(1);
  expect(within(sidebar).queryByRole('button', { name: 'Apply' })).toBeNull();
  expect(within(sidebar).getByRole('button', { name: 'Keep' })).toBeTruthy();
});

it('shows a stalled session with an Interrupt choice answered through one reply', async () => {
  const item: NeedsItem = {
    ...proposal,
    id: 'stalled/builder',
    agent: 'builder',
    kind: 'prompt',
    title: 'No activity from Codex for 20 minutes: its connection may have dropped.',
    choices: [{ value: 'interrupt', label: 'Interrupt' }],
  };
  const core = await setup(
    [item],
    [{ id: 'builder', type: 'agent', position: { x: 0, y: 0 }, data: { label: 'Builder' } }],
  );
  expect(await screen.findByText('Silent session: Builder')).toBeTruthy();
  core.reply('reply', () => Promise.resolve({ ok: true, value: { revs: {} } }));
  await events.click(await screen.findByRole('button', { name: 'Interrupt' }));
  expectOneOp(core, 'reply', { canvas, to: item.id, answer: { choice: 'interrupt' } });
});
it('drops an answered card when its stalled id leaves and is raised again, with live buttons and a badge', async () => {
  const item: NeedsItem = {
    ...proposal,
    id: 'stalled/builder',
    agent: 'builder',
    kind: 'prompt',
    title: 'No activity from Codex for 20 minutes: its connection may have dropped.',
    choices: [{ value: 'interrupt', label: 'Interrupt' }],
  };
  const core = await setup(
    [item],
    [{ id: 'builder', type: 'agent', position: { x: 0, y: 0 }, data: { label: 'Builder' } }],
  );
  core.reply('reply', () => {
    core.change({ topic: `needs:${canvas}`, rev: 1, replace: { items: [] } });
    return Promise.resolve({ ok: true, value: { revs: {} } });
  });
  await events.click(await screen.findByRole('button', { name: 'Interrupt' }));
  expect((await screen.findByRole('status')).textContent).toBe('Answered.');
  const bell = screen.getByRole('button', { name: 'Needs you' });
  expect(bell.querySelector('.float-needs-count')).toBeNull();
  // The agent's next turn goes silent too: the core raises the same id again.
  act(() => {
    core.change({ topic: `needs:${canvas}`, rev: 2, replace: { items: [item] } });
  });
  expect(await screen.findByRole('button', { name: 'Interrupt' })).toHaveProperty(
    'disabled',
    false,
  );
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.queryByRole('button', { name: `Dismiss ${item.title}` })).toBeNull();
  expect(bell.querySelector('.float-needs-count')?.textContent).toBe('1');
});
it('keeps a refused reply at its card and lets it be retried', async () => {
  const core = await setup([proposal]);
  core.reply('reply', { ok: false, error: { code: 'unavailable', sentence: 'Not saved' } });
  await events.click(await screen.findByRole('button', { name: 'Allow' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Not saved');
  expect(screen.getByRole('button', { name: 'Allow' })).not.toHaveProperty('disabled', true);
});

it.each(['before', 'after'] as const)(
  'removes a failed reply card and its badge when the topic removes it %s the refusal',
  async (when) => {
    const core = await setup([proposal]);
    const reply = Promise.withResolvers<{
      ok: false;
      error: { code: 'not-found'; sentence: string };
    }>();
    core.reply('reply', () => reply.promise);
    await events.click(screen.getByRole('button', { name: 'Allow' }));
    const remove = () => {
      core.change({ topic: `needs:${canvas}`, rev: 1, replace: { items: [] } });
    };
    if (when === 'before') act(remove);
    await act(() => {
      reply.resolve({ ok: false, error: { code: 'not-found', sentence: 'No longer waiting' } });
      return Promise.resolve();
    });
    if (when === 'after') {
      expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'No longer waiting');
      act(remove);
    }
    await waitFor(() => {
      expect(screen.queryByRole('article', { name: proposal.title })).toBeNull();
    });
    const bell = screen.getByRole('button', { name: 'Needs you' });
    expect(bell).toHaveProperty('disabled', true);
    expect(bell.querySelector('.float-needs-count')).toBeNull();
    // A later prompt may reuse an id (stalled/<agent> does): it starts without the old error.
    act(() => {
      core.change({ topic: `needs:${canvas}`, rev: 2, replace: { items: [proposal] } });
    });
    await events.click(screen.getByRole('button', { name: 'Needs you' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Allow' })).toHaveProperty('disabled', false);
  },
);
