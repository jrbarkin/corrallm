import { act, cleanup, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { newCanvasId } from '../../shared/canvas';
import type { ResultOf } from '../../shared/api/registry';
import { fakeCore, expectOneOp } from '../test-api';
import { events, renderReady } from '../test-render';
import { WorkspaceProvider, WorkspaceBadge, WorkspaceDetails, WorkspaceWait } from './Workspace';
import { KeptWorktrees } from './KeptWorktrees';

const canvas = newCanvasId();
const workspace = '11111111-1111-4111-8111-111111111111';
const cores: ReturnType<typeof fakeCore>[] = [];
afterEach(() => {
  cleanup();
  cores.splice(0).forEach((core) => {
    core.dispose();
  });
  vi.useRealTimers();
});
const pendingSetup = {
  state: 'pending',
  command: "printf 'a  b'",
  source: 'detected',
  exitCode: null,
} as const;
const item: ResultOf<'worktree.list'>['items'][number] = {
  agent: 'builder',
  mode: 'group',
  group: 'team',
  workspace,
  generation: 1,
  branch: 'corral/team/a-long-branch',
  base: { ref: 'main', oid: '123' },
  state: 'setup',
  location: '/repo/worktrees/team',
  need: `setup/${workspace}/1`,
  setup: { state: 'pending', command: "printf 'a  b'", source: 'detected', exitCode: null },
};
async function setup(next = item) {
  const core = fakeCore();
  cores.push(core);
  core.snapshot(`worktrees:${canvas}`, { items: [next], kept: [] });
  core.snapshot(`needs:${canvas}`, { items: [] });
  const onNeed = vi.fn();
  await renderReady(
    <WorkspaceProvider
      canvas={canvas}
      mirror={core.topics}
      client={core.api}
      nodes={[
        { id: 'team', type: 'frame', position: { x: 0, y: 0 }, data: { label: 'Review team' } },
      ]}
      onNeed={onNeed}
    >
      <WorkspaceBadge agent="builder" />
      <WorkspaceDetails agent="builder" />
      <WorkspaceWait agent="builder" />
    </WorkspaceProvider>,
  );
  await events.click(screen.getByText('Repository setup'));
  return { core, onNeed };
}

it('projects branch, sharing, location and setup hold, with direct navigation and no read operation', async () => {
  const { core, onNeed } = await setup();
  expect(screen.getAllByText('corral/team/a-long-branch')[0]?.title).toContain(item.branch);
  expect(screen.getByText('Shares Review team’s worktree')).toBeTruthy();
  expect(screen.getByText('/repo/worktrees/team')).toBeTruthy();
  expect(screen.getAllByText('Waiting for worktree setup')[0]).toBeTruthy();
  await events.click(
    within(screen.getByRole('region', { name: 'Works in' })).getByRole('button', {
      name: 'Review setup',
    }),
  );
  expect(onNeed).toHaveBeenCalledWith(item.need);
  expect(core.operations).toEqual([]);
  expect(core.subscriptions.has(`worktrees:${canvas}`)).toBe(true);
});

it('does not call a worktree failed while its setup card is still being prepared', async () => {
  // The core lists a tree in setup before it has offered the card (it copies local files and
  // detects the command first): no need, no setup record yet. That is not a failure.
  const { core } = await setup({ ...item, need: undefined, setup: undefined });
  const mark = document.querySelector('.workspace-badge');
  expect(mark?.textContent).not.toContain('Failed');
  expect(mark?.querySelector('button')).toBeNull();
  act(() => {
    core.change({ topic: `worktrees:${canvas}`, rev: 1, replace: { items: [item], kept: [] } });
  });
  expect(document.querySelector('.workspace-badge')?.textContent).toContain('Setup');
  act(() => {
    core.change({
      topic: `worktrees:${canvas}`,
      rev: 2,
      replace: {
        items: [
          { ...item, state: 'error', need: undefined, setup: undefined, error: 'git-timeout' },
        ],
        kept: [],
      },
    });
  });
  expect(document.querySelector('.workspace-badge')?.textContent).toContain('Failed');
});

it('replaces pushed workspace state and retries a missing workspace with exactly one op', async () => {
  const { core } = await setup();
  act(() => {
    core.change({
      topic: `worktrees:${canvas}`,
      rev: 1,
      replace: {
        items: [
          {
            ...item,
            state: 'missing',
            need: undefined,
            setup: undefined,
            error: 'Checkout disappeared',
          },
        ],
        kept: [],
      },
    });
  });
  expect(screen.queryByText('Waiting for worktree setup')).toBeNull();
  expect(screen.getByText('Checkout disappeared')).toBeTruthy();
  await events.click(
    within(screen.getByRole('region', { name: 'Works in' })).getByRole('button', {
      name: 'Retry worktree',
    }),
  );
  expectOneOp(core, 'worktree.retry', { canvas, agent: 'builder' });
});

it('shows setup completion briefly once per shared tree, never on an already-ready initial snapshot', async () => {
  const { core } = await setup();
  vi.useFakeTimers();
  act(() => {
    core.change({
      topic: `worktrees:${canvas}`,
      rev: 1,
      replace: {
        items: ['builder', 'reviewer'].map((agent) => ({
          ...item,
          agent,
          state: 'ready' as const,
          need: undefined,
          setup: {
            ...pendingSetup,
            state: 'done' as const,
          },
        })),
        kept: [],
      },
    });
  });
  expect(screen.getAllByText('Worktree setup finished.')).toHaveLength(1);
  act(() => {
    vi.advanceTimersByTime(6000);
  });
  expect(screen.queryByText('Worktree setup finished.')).toBeNull();
  expect(core.operations).toEqual([]);
});

it.each([
  ['save', 'Save setup command', 'project.setSetupCommand', { canvas, command: "printf 'a  b'" }],
  ['reset', 'Use detected command', 'project.setSetupCommand', { canvas, command: null }],
  ['clear', 'Ask before future setups', 'project.clearSetupApproval', { canvas }],
] as const)('offers the repository setup %s gesture as one op', async (action, label, op, args) => {
  const { core } = await setup({
    ...item,
    setup: {
      ...pendingSetup,
      source: 'configured',
    },
  });
  if (action === 'save')
    await events.change(screen.getByRole('textbox', { name: 'Setup command' }), {
      target: { value: "printf 'a  b'" },
    });
  await events.click(screen.getByRole('button', { name: label }));
  expectOneOp(core, op, args);
});

it.each(['echo\u200bno', 'echo\u2028no', 'é'.repeat(2049)])(
  'rejects invisible, multiline or oversized command input (%#)',
  async (command) => {
    const { core } = await setup();
    await events.change(screen.getByRole('textbox', { name: 'Setup command' }), {
      target: { value: command },
    });
    await events.click(screen.getByRole('button', { name: 'Save setup command' }));
    expect(screen.getByRole('alert').textContent).toContain('one visible line');
    expect(core.operations).toEqual([]);
  },
);

it('does not announce setup already complete when subscribing, or a skipped setup', async () => {
  const { core } = await setup({
    ...item,
    state: 'ready',
    need: undefined,
    setup: {
      ...pendingSetup,
      state: 'done',
    },
  });
  expect(screen.queryByText('Worktree setup finished.')).toBeNull();
  act(() => {
    core.change({ topic: `worktrees:${canvas}`, rev: 1, replace: { items: [item], kept: [] } });
  });
  act(() => {
    core.change({
      topic: `worktrees:${canvas}`,
      rev: 2,
      replace: {
        items: [
          {
            ...item,
            state: 'ready',
            need: undefined,
            setup: {
              ...pendingSetup,
              state: 'skipped',
            },
          },
        ],
        kept: [],
      },
    });
  });
  expect(screen.queryByText('Worktree setup finished.')).toBeNull();
});

it('names the active branch and the core’s destination while a switch waits', async () => {
  const { core, onNeed } = await setup({
    ...item,
    state: 'pending-change',
    need: 'rebind/group%2Fnext/2',
  });
  act(() => {
    core.change({
      topic: `needs:${canvas}`,
      rev: 1,
      replace: {
        items: [
          {
            id: 'rebind/group%2Fnext/2',
            canvas,
            kind: 'worktree',
            for: 'you',
            by: ['you'],
            answerIn: 'api',
            title: 'Move Builder to Next team’s worktree?',
            choices: [{ label: 'Switch', value: 'switch' }],
          },
        ],
      },
    });
  });
  const details = within(screen.getByRole('region', { name: 'Works in' }));
  expect(details.getByText('corral/team/a-long-branch')).toBeTruthy();
  expect(
    details.getByText(/The current worktree keeps its work.*Move Builder to Next team/),
  ).toBeTruthy();
  await events.click(details.getByRole('button', { name: 'Review workspace change' }));
  expect(onNeed).toHaveBeenCalledWith('rebind/group%2Fnext/2');
  expect(core.operations).toEqual([]);
});

it('reports a retry refusal in place and leaves the pushed failed state intact', async () => {
  const { core } = await setup({ ...item, state: 'error', need: undefined, error: 'git-failed' });
  core.reply('worktree.retry', {
    ok: false,
    error: { code: 'unavailable', sentence: 'Repository unavailable.' },
  });
  const details = within(screen.getByRole('region', { name: 'Works in' }));
  await events.click(details.getByRole('button', { name: 'Retry worktree' }));
  expect(details.getByText('Repository unavailable.')).toBeTruthy();
  expect(details.getByText('Worktree failed')).toBeTruthy();
  expectOneOp(core, 'worktree.retry', { canvas, agent: 'builder' });
});

it.each(['retained', 'removing'] as const)(
  'shows a closed canvas’s %s tree and uses its core confirmation without showing that canvas',
  async (state) => {
    const core = fakeCore();
    cores.push(core);
    const kept: ResultOf<'worktree.list'>['kept'][number] = {
      workspace,
      owner: 'group/team',
      name: 'Review team',
      branch: 'corral/team',
      base: { ref: 'main', oid: '123' },
      state,
      error: 'Has work',
      location: '/kept/tree',
      createdAt: 1,
    };
    core.snapshot(`worktrees:${canvas}`, { items: [], kept: [kept] });
    core.snapshot(`needs:${canvas}`, { items: [] });
    core.reply('worktree.remove', () => {
      core.change({
        topic: `needs:${canvas}`,
        rev: 1,
        replace: {
          items: [
            {
              id: 'proposal/remove',
              canvas,
              kind: 'proposal',
              for: 'you',
              by: ['you'],
              answerIn: 'api',
              title: 'Discard work in Review team?',
              choices: [
                { value: 'discard', label: 'Remove it and its branch' },
                { value: 'refuse', label: 'Cancel' },
              ],
            },
          ],
        },
      });
      return Promise.resolve({ ok: true, value: { proposed: 'proposal/remove', revs: {} } });
    });
    await renderReady(
      <KeptWorktrees canvas={canvas} name="Former canvas" mirror={core.topics} client={core.api} />,
    );
    expect(screen.getByText('Former canvas')).toBeTruthy();
    expect(screen.getByText('Review team')).toBeTruthy();
    expect(screen.getByText('corral/team')).toBeTruthy();
    await events.click(screen.getByRole('button', { name: 'Remove Review team worktree' }));
    expectOneOp(core, 'worktree.remove', { canvas, worktree: workspace });
    core.operations.length = 0;
    await events.click(
      await within(
        screen.getByRole('article', { name: 'Discard work in Review team?' }),
      ).findByRole('button', { name: 'Cancel' }),
    );
    expectOneOp(core, 'reply', { canvas, to: 'proposal/remove', answer: { choice: 'refuse' } });
  },
);
