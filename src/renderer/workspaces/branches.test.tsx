import { act, cleanup, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { BranchMergeInput } from '../../shared/api/branch';
import { newCanvasId } from '../../shared/canvas';
import type { CanvasId } from '../../shared/canvas';
import type { BranchDiffOutput, WorktreeMerge } from '../../shared/api/branch';
import type { MergeInto } from './state';
import type { ResultOf } from '../../shared/api/registry';
import type { FakeCanvas } from '../test-canvas';
import { expectOneOp, expectOneRead, fakeCore } from '../test-api';
import { GraphEditor } from '../test-graph';
import { events, renderReady } from '../test-render';
import { WorkspaceProvider } from './Workspace';
import { BranchControls } from './BranchReview';

vi.mock('../terminal/screen', async () => {
  const { fakeScreens } = await import('../terminal/test-screen');
  return { createScreen: fakeScreens.create };
});

afterEach(cleanup);
const isolatedCores: ReturnType<typeof fakeCore>[] = [];
afterEach(() => {
  for (const core of isolatedCores.splice(0)) core.dispose();
});
const source = { ref: 'refs/heads/corrallm/team', oid: 'a'.repeat(40) };
const into = { ref: 'refs/heads/main', oid: 'b'.repeat(40) };
const digest = 'd'.repeat(64);
const page: BranchDiffOutput = {
  agent: 'builder' as BranchDiffOutput['agent'],
  workspace: '11111111-1111-4111-8111-111111111111' as BranchDiffOutput['workspace'],
  shared: ['builder', 'reviewer'] as BranchDiffOutput['shared'],
  source: { ...source, onBranch: true },
  base: { ref: 'refs/heads/trunk', oid: 'c'.repeat(40) },
  into,
  committed: { files: 2, complete: true },
  uncommitted: { changed: 1, untracked: 1, partlyStaged: 0, complete: true, digest },
  files: [
    {
      section: 'committed',
      path: 'src/main.ts',
      status: 'modified',
      patch: '@@ -1 +1 @@\n-old\n+new\n',
      cut: true,
    },
    { section: 'committed', path: 'logo.png', status: 'added', binary: true },
    {
      section: 'uncommitted',
      path: '<img src=x>.txt',
      oldPath: 'old.txt',
      status: 'renamed',
      staged: true,
      note: 'symlink',
      mode: { old: '100644', new: '120000' },
      patch: '+target\n',
    },
  ],
  next: 'YQ',
};

async function isolatedReview() {
  const builder: ResultOf<'worktree.list'>['items'][number] = {
    agent: 'builder',
    workspace: page.workspace,
    mode: 'own',
    generation: 1,
    branch: source.ref.slice('refs/heads/'.length),
    base: page.base,
    state: 'ready',
  };
  const core = fakeCore();
  isolatedCores.push(core);
  const first = newCanvasId();
  const second = newCanvasId();
  for (const canvas of [first, second]) {
    core.snapshot(`worktrees:${canvas}`, { items: [builder], kept: [], into });
    core.snapshot(`needs:${canvas}`, { items: [] });
  }
  core.respond('branch.diff', page);
  const show = (canvas: CanvasId, inert = false) => (
    <WorkspaceProvider
      canvas={canvas}
      client={core.api}
      mirror={core.topics}
      nodes={[
        { id: 'builder', type: 'agent', position: { x: 0, y: 0 }, data: { label: 'Builder' } },
      ]}
      onNeed={() => undefined}
      inert={inert}
    >
      <BranchControls agent="builder" />
    </WorkspaceProvider>
  );
  const view = await renderReady(show(first));
  return { ...view, core, first, second, show };
}

it('offers the controls only to an agent whose worktree has a generated branch', async () => {
  const { core, first } = await isolatedReview();
  const topic = `worktrees:${first}` as const;
  const review = () => screen.queryByRole('button', { name: 'Review changes' });
  expect(review()).not.toBeNull();
  const publish = (items: ResultOf<'worktree.list'>['items']) => {
    act(() => {
      core.change({
        topic,
        rev: (core.state(topic)?.rev ?? 0) + 1,
        replace: { items, kept: [], into },
      });
    });
  };
  publish([]);
  expect(review()).toBeNull();
  publish([
    {
      agent: 'builder',
      workspace: null,
      mode: 'own',
      generation: 0,
      branch: null,
      base: null,
      state: 'pending-change',
    },
  ]);
  expect(review()).toBeNull();
});

it('ends a review when its canvas changes, including when returning before a pending read completes', async () => {
  const { core, first, second, rerender, show } = await isolatedReview();
  let resolve: ((value: { ok: true; value: BranchDiffOutput }) => void) | undefined;
  core.reply(
    'branch.diff',
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await events.click(screen.getByRole('button', { name: 'Review changes' }));
  expectOneRead(core, 'branch.diff', { canvas: first, agent: 'builder' });
  rerender(show(second));
  expect(screen.queryByRole('dialog', { name: 'Builder’s changes' })).toBeNull();
  core.reads.length = 0;
  rerender(show(first));
  expect(screen.queryByRole('dialog', { name: 'Builder’s changes' })).toBeNull();
  await act(async () => {
    resolve?.({ ok: true, value: page });
    await Promise.resolve();
  });
  expect(screen.queryByRole('dialog', { name: 'Builder’s changes' })).toBeNull();
  expect(core.reads).toEqual([]);
  expect(core.operations).toEqual([]);
});

it('shows filename and patch control characters as visible text while preserving ordinary diff layout', async () => {
  const { open } = await setup({
    review: {
      ...page,
      files: [
        {
          section: 'committed',
          path: 'new\n\u202efile.txt',
          oldPath: 'old\tname.txt',
          status: 'renamed',
          patch: '@@ -1 +1 @@\n-\told\n+\tnew\u202e text\n',
        },
      ],
      next: null,
    },
  });
  const review = await open();
  const heading = review.getByRole('heading', { name: /old.*name.txt/ });
  expect(heading.textContent).not.toMatch(/[\n\t\u202e]/);
  expect(heading.textContent).toContain('\\u202e');
  const patch = document.querySelector('.branch-review .agent-tool-detail');
  expect(patch?.textContent).not.toContain('\u202e');
  expect(patch?.textContent).toContain('+\tnew\\u202e text\n');
});

async function setup(
  options: { review?: BranchDiffOutput; into?: MergeInto | null; merge?: WorktreeMerge } = {},
) {
  let made: FakeCanvas | undefined;
  const view = await renderReady(
    <GraphEditor
      initialGraph={{
        nodes: [
          { id: 'team', type: 'frame', position: { x: 0, y: 0 }, data: { label: 'Review team' } },
          {
            id: 'builder',
            type: 'agent',
            parentId: 'team',
            position: { x: 20, y: 40 },
            data: { label: 'Builder' },
          },
          {
            id: 'reviewer',
            type: 'agent',
            parentId: 'team',
            position: { x: 250, y: 40 },
            data: { label: 'Reviewer' },
          },
        ],
        edges: [],
      }}
      onCanvas={(canvas) => {
        made = canvas;
      }}
    />,
  );
  if (!made) throw new Error('No canvas');
  const canvas = made;
  const core = canvas.core;
  const topic = `worktrees:${canvas.document.id}` as const;
  const items: ResultOf<'worktree.list'>['items'] = ['builder', 'reviewer'].map((agent) => ({
    agent,
    workspace: page.workspace,
    mode: 'group',
    group: 'team',
    generation: 1,
    branch: source.ref.slice('refs/heads/'.length),
    base: page.base,
    state: 'ready',
    merge: options.merge ?? { merged: false, uncommitted: 2 },
  }));
  const publish = (merge: WorktreeMerge, target: MergeInto | null = into) => {
    act(() => {
      core.change({
        topic,
        rev: (core.state(topic)?.rev ?? 0) + 1,
        replace: {
          items: items.map((item) => ({ ...item, merge })),
          kept: [],
          into: target,
        },
      });
    });
  };
  publish(
    options.merge ?? { merged: false, uncommitted: 2 },
    options.into === undefined ? into : options.into,
  );
  core.respond('branch.diff', options.review ?? page);
  core.respond('branch.merge', {
    outcome: 'merged',
    source: source.oid,
    into: { ref: into.ref, before: into.oid, after: 'e'.repeat(40) },
    mergeCommit: 'e'.repeat(40),
    revs: {},
  });
  const card = view.container.querySelector<HTMLElement>('.graph-card[data-agent]');
  if (!card) throw new Error('No card');
  const open = async (kind: 'review' | 'merge' = 'review') => {
    await events.mouseEnter(card);
    core.reads.length = 0;
    core.operations.length = 0;
    await events.click(
      screen.getByRole('button', {
        name: kind === 'review' ? 'Review changes' : 'Merge into main…',
      }),
    );
    return within(screen.getByRole('dialog', { name: /Builder.*changes|Merge Builder/ }));
  };
  return { ...view, canvas, core, card, publish, open };
}

it('reviews shared work in separate sections with patches, binary and cut marks, then pages once', async () => {
  const { core, canvas, open } = await setup();
  const review = await open();
  expectOneRead(core, 'branch.diff', { canvas: canvas.document.id, agent: 'builder' });
  expect(core.operations).toEqual([]);
  expect(review.getByText('Shares Review team’s worktree')).toBeTruthy();
  expect(review.getByRole('heading', { name: 'Committed' })).toBeTruthy();
  expect(review.getByRole('heading', { name: 'Uncommitted' })).toBeTruthy();
  expect(review.getByText(/trunk/).closest('p')?.textContent).toContain(page.base.oid);
  expect(review.getByText('Patch cut')).toBeTruthy();
  expect(review.getByText('Binary file')).toBeTruthy();
  expect(review.getByText('<img src=x>.txt')).toBeTruthy();
  expect(document.querySelector('img[src="x"]')).toBeNull();
  expect(review.getByText(/old.txt/)).toBeTruthy();
  expect(review.getByText(/Staged/)).toBeTruthy();
  expect(review.getByText(/120000/)).toBeTruthy();
  expect(document.querySelector('.branch-review [data-line="add"]')?.textContent).toBe('+new\n');
  core.reads.length = 0;
  core.respond('branch.diff', {
    ...page,
    files: [
      {
        section: 'uncommitted',
        path: 'next.txt',
        status: 'untracked',
        note: 'too-large',
        cut: true,
      },
    ],
    next: null,
  });
  await events.click(review.getByRole('button', { name: 'Load more changes' }));
  expectOneRead(core, 'branch.diff', {
    canvas: canvas.document.id,
    agent: 'builder',
    after: page.next,
  });
  expect(review.getByText('src/main.ts')).toBeTruthy();
  expect(review.getByText('next.txt')).toBeTruthy();
  expect(review.queryByRole('button', { name: 'Load more changes' })).toBeNull();
});

it.each(['session', 'lane'] as const)('opens the same review from the %s header', async (entry) => {
  const { container, core, canvas } = await setup();
  if (entry === 'session')
    await events.doubleClick(screen.getByText('Builder', { selector: '.graph-label' }));
  else await events.click(screen.getByRole('button', { name: 'Show all queues' }));
  const header = container.querySelector(
    entry === 'session'
      ? '.agent-header[data-agent-menu="builder"]'
      : '.queues-head[data-lane="builder"]',
  );
  if (!header) throw new Error('No header');
  core.reads.length = 0;
  core.operations.length = 0;
  await events.click(within(header as HTMLElement).getByRole('button', { name: 'Review changes' }));
  expectOneRead(core, 'branch.diff', { canvas: canvas.document.id, agent: 'builder' });
  expect(core.operations).toEqual([]);
  expect(screen.getByRole('dialog', { name: 'Builder’s changes' })).toBeTruthy();
});

it.each(['leave', 'commit'] as const)(
  'merges only after confirmation with the displayed pins and the %s choice',
  async (choice) => {
    const { core, canvas, card, open } = await setup();
    const review = await open('merge');
    expectOneRead(core, 'branch.diff', { canvas: canvas.document.id, agent: 'builder' });
    expect(core.operations).toEqual([]);
    await events.click(
      review.getByRole('radio', {
        name:
          choice === 'leave'
            ? /Merge commits without uncommitted work/
            : /Commit uncommitted work on its branch first/,
      }),
    );
    core.reads.length = 0;
    await events.click(review.getByRole('button', { name: 'Merge into main' }));
    expectOneOp(core, 'branch.merge', {
      canvas: canvas.document.id,
      agent: 'builder',
      source,
      into,
      uncommitted: choice === 'commit' ? { choice, digest } : { choice },
      request: BranchMergeInput.parse(core.operations[0]?.args).request,
    });
    expect(core.reads).toEqual([]);
    expect(review.getByRole('status').textContent).toContain('Merged');
    expect(card.textContent).not.toContain('· merged');
  },
);

it.each([null, { ref: null, oid: null }, { ref: into.ref, oid: null }])(
  'uses the review destination when the topic has no complete pin (%j)',
  async (target) => {
    const clean = {
      ...page,
      uncommitted: { changed: 0, untracked: 0, partlyStaged: 0, complete: true, digest: null },
      files: [],
      next: null,
    };
    const { core, canvas, open } = await setup({ into: target, review: clean });
    const review = await open();
    core.reads.length = 0;
    await events.click(review.getByRole('button', { name: 'Merge into main' }));
    expectOneOp(core, 'branch.merge', {
      canvas: canvas.document.id,
      agent: 'builder',
      source,
      into,
      request: BranchMergeInput.parse(core.operations[0]?.args).request,
    });
    expect(core.reads).toEqual([]);
  },
);

it('pins the destination the window showed, even when a newer review reports a different one', async () => {
  const { core, open } = await setup({
    review: { ...page, into: { ref: 'refs/heads/next', oid: 'f'.repeat(40) } },
  });
  const review = await open('merge');
  await events.click(review.getByRole('radio', { name: /Merge commits without uncommitted work/ }));
  await events.click(review.getByRole('button', { name: 'Merge into main' }));
  expect(core.operations[0]?.args).toMatchObject({ into });
});

it('does not offer a checkpoint without a digest, and explains incomplete and partly staged work', async () => {
  const { open } = await setup({
    review: {
      ...page,
      committed: { files: 10001, complete: false },
      uncommitted: { ...page.uncommitted, complete: false, partlyStaged: 1, digest: null },
    },
  });
  const review = await open('merge');
  expect(
    review.getByRole<HTMLInputElement>('radio', {
      name: /Commit uncommitted work on its branch first/,
    }).disabled,
  ).toBe(true);
  expect(review.getByText(/partly staged/i)).toBeTruthy();
  expect(review.getAllByText(/inventory is incomplete/i).length).toBeGreaterThan(0);
  expect(review.getByRole<HTMLButtonElement>('button', { name: 'Merge into main' }).disabled).toBe(
    true,
  );
});

it.each([
  ['refused', 'Filtered file "large.bin": run git merge --no-ff corrallm/team yourself.'],
  [
    'unavailable',
    'A merge into main was interrupted; your checkout may be partly merged: check git status there.',
  ],
  ['conflict', 'main moved since you looked.'],
] as const)(
  'shows the core’s %s sentence unchanged, without another read or a success badge',
  async (code, sentence) => {
    const { core, open, card } = await setup();
    const review = await open('merge');
    await events.click(
      review.getByRole('radio', { name: /Merge commits without uncommitted work/ }),
    );
    core.reply('branch.merge', { ok: false, error: { code, sentence } });
    core.reads.length = 0;
    await events.click(review.getByRole('button', { name: 'Merge into main' }));
    expect(review.getByRole('alert').textContent).toBe(sentence);
    expect(core.operations).toHaveLength(1);
    expect(core.reads).toEqual([]);
    expect(card.textContent).not.toContain('· merged');
  },
);

it('keeps a stale page for inspection and requires an explicit refresh before merging', async () => {
  const { core, canvas, open } = await setup();
  const review = await open();
  const sentence = 'The work changed since you looked: review it again.';
  core.reply('branch.diff', { ok: false, error: { code: 'conflict', sentence } });
  await events.click(review.getByRole('button', { name: 'Load more changes' }));
  expect(review.getByRole('alert').textContent).toBe(sentence);
  expect(review.getByText('src/main.ts')).toBeTruthy();
  expect(review.getByRole<HTMLButtonElement>('button', { name: 'Merge into main' }).disabled).toBe(
    true,
  );
  core.respond('branch.diff', { ...page, files: [], next: null });
  core.reads.length = 0;
  await events.click(review.getByRole('button', { name: 'Refresh review' }));
  expectOneRead(core, 'branch.diff', { canvas: canvas.document.id, agent: 'builder' });
  expect(review.queryByText('src/main.ts')).toBeNull();
});

it('shows an initial read refusal at the gesture, then refreshes without a write', async () => {
  const { core, canvas, open } = await setup();
  core.reply('branch.diff', {
    ok: false,
    error: { code: 'unavailable', sentence: 'Choose a Git project folder first.' },
  });
  const review = await open();
  expect(review.getByRole('alert').textContent).toBe('Choose a Git project folder first.');
  core.respond('branch.diff', { ...page, files: [], next: null });
  core.reads.length = 0;
  await events.click(review.getByRole('button', { name: 'Refresh review' }));
  expectOneRead(core, 'branch.diff', { canvas: canvas.document.id, agent: 'builder' });
  expect(core.operations).toEqual([]);
});

it.each([
  [{ merged: true, uncommitted: 0 }, '· merged'],
  [{ merged: true, uncommitted: 1 }, '· commits merged'],
  [{ merged: true, uncommitted: null }, '· commits merged'],
  [{ merged: false, uncommitted: 0 }, ''],
  [{ merged: null, uncommitted: null }, ''],
  [{ merged: false, uncommitted: 0, job: 'merging' }, 'merging…'],
  [
    { merged: false, uncommitted: null, job: 'held', sentence: 'Check your checkout.' },
    'Merge held',
  ],
] as const)('shows only the core’s observed merge state (%j)', async (merge, word) => {
  const { card, core, publish } = await setup({ merge });
  const badge = card.querySelector('.workspace-badge');
  expect(badge?.textContent).toContain(word);
  if (word && badge)
    expect(within(badge as HTMLElement).getByText(word, { exact: true })).toBeTruthy();
  if (!word) expect(badge?.textContent).not.toMatch(/merged|merging|held/i);
  if (merge.merged)
    expect(badge?.getAttribute('title')).toContain('its commits are in main’s history');
  if ('job' in merge && merge.job === 'held')
    expect(badge?.getAttribute('title')).toContain('Check your checkout.');
  publish({ merged: true, uncommitted: 0 }, { ref: null, oid: into.oid });
  expect(card.querySelector('.workspace-badge')?.getAttribute('title')).toContain(
    'its commits are in your checkout’s history',
  );
  expect(core.operations).toEqual([]);
});

it('closes a pending review without writing and ignores its late result', async () => {
  const { core, card } = await setup();
  let resolve: ((value: { ok: true; value: BranchDiffOutput }) => void) | undefined;
  core.reply(
    'branch.diff',
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await events.mouseEnter(card);
  await events.click(screen.getByRole('button', { name: 'Review changes' }));
  await events.keyDown(screen.getByRole('dialog', { name: 'Builder’s changes' }), {
    key: 'Escape',
  });
  await act(async () => {
    resolve?.({ ok: true, value: page });
    await Promise.resolve();
  });
  expect(screen.queryByRole('dialog', { name: 'Builder’s changes' })).toBeNull();
  expect(core.operations).toEqual([]);
});
