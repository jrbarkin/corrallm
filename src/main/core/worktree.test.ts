import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { CanvasMemory } from '../memory';
import { CATALOG, DEFAULT_ADAPTER } from '../sessions/adapters';
import { Documents } from './canvas/documents';
import { createCore } from './core';
import type { Core } from './core';
import { keepCanvases, openTestStore } from './store/test-store';
import { CALLERS, CANVAS, NO_DESKTOP, OTHER_CANVAS } from './test-registry';
import { WorkspaceCleanup } from './workspaces/cleanup';
import type { TreeState } from './workspaces/cleanup';
import { GitRunner } from './workspaces/git';
import { WorkspaceStore } from './workspaces/store';

// Real core.call and C7's removeKept; only Git assessment/removal are replaced. These records
// have no checkouts, so no process, Git operation or native CLI runs in these registry tests.
const TREE = '22222222-2222-4222-8222-222222222222';
const ACTIVE = '33333333-3333-4333-8333-333333333333';
const FOREIGN = '44444444-4444-4444-8444-444444444444';
const ABSENT = '55555555-5555-4555-8555-555555555555';
const REQUEST = '66666666-6666-4666-8666-666666666666';
const OID = 'a'.repeat(40);
let profile: string;
let core: Core;
let workspaces: WorkspaceStore;
let state: TreeState;
const assess = vi.fn<WorkspaceCleanup['assess']>();
const remove = vi.fn<WorkspaceCleanup['remove']>();

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-worktree-op-'));
  await keepCanvases(profile, { [CANVAS]: {}, [OTHER_CANVAS]: {} });
  const store = await openTestStore(profile);
  try {
    const memory = new CanvasMemory(store);
    const documents = new Documents({
      store,
      memory,
      catalog: CATALOG,
      defaultAdapter: DEFAULT_ADAPTER,
    });
    documents.create(CANVAS, 'you');
    await documents.keep(CANVAS);
    const records = new WorkspaceStore({ store });
    const root = path.join(profile, 'project');
    await records.write((w) => {
      w.addRepository({
        id: TREE,
        pickedRoot: root,
        realRoot: root,
        commonDir: path.join(root, '.git'),
        identity: 'test repository',
        rootKind: 'project',
        ownedRoot: path.join(root, '.corral/worktrees/profile'),
      });
      for (const [id, canvas] of [
        [TREE, CANVAS],
        [ACTIVE, CANVAS],
        [FOREIGN, OTHER_CANVAS],
      ] as const) {
        w.createWorktree({
          id,
          canvas,
          repository: TREE,
          owner: `agent/${id}`,
          path: path.join(root, '.corral/worktrees/profile', id),
          branchRef: `refs/heads/corrallm/profile/${id}`,
          baseCheckout: root,
          baseRef: 'refs/heads/main',
          baseOid: OID,
          forkedFrom: null,
        });
        if (id !== ACTIVE) w.retain(id);
      }
    });
  } finally {
    await store.close();
  }
  state = {
    workspace: TREE,
    head: OID,
    tip: OID,
    changed: 0,
    untracked: 0,
    paths: [],
    merged: true,
    writers: [],
    setup: false,
    status: '',
  };
  assess.mockReset().mockImplementation(() => Promise.resolve(state));
  remove.mockReset().mockResolvedValue('removed');
  core = await createCore(
    {
      profile,
      app: { name: 'corrallm', version: '1.0.0' },
      check: true,
      distribution: 'local',
      sessions: { connectors: {}, environment: () => Promise.resolve({}) },
      cleanup: (deps) => {
        workspaces = deps.workspaces;
        const cleanup = new WorkspaceCleanup({
          ...deps,
          git: new GitRunner({
            environment: () => Promise.resolve({}),
            hooks: path.join(profile, 'hooks'),
          }),
        });
        vi.spyOn(cleanup, 'assess').mockImplementation(assess);
        vi.spyOn(cleanup, 'remove').mockImplementation(remove);
        return cleanup;
      },
    },
    NO_DESKTOP,
  );
});

afterEach(async () => {
  await core.close();
  vi.restoreAllMocks();
  await rm(profile, { recursive: true, force: true });
});

it('removes a safe kept tree through the live registry, once per request', async () => {
  const args = { canvas: CANVAS, worktree: TREE, request: REQUEST };
  const first = await core.call('worktree.remove', args, CALLERS.you);
  expect(first).toMatchObject({ ok: true, value: { removed: true, revs: {} } });
  expect(await core.call('worktree.remove', args, CALLERS.you)).toEqual(first);
  expect(assess).toHaveBeenCalledTimes(1);
  expect(remove).toHaveBeenCalledExactlyOnceWith(TREE);
  expect(workspaces.worktree(TREE)?.state).toBe('removing');
});

it('keeps C7’s retained result when work changes while removal goes on', async () => {
  remove.mockResolvedValue('retained');
  expect(
    await core.call('worktree.remove', { canvas: CANVAS, worktree: TREE }, CALLERS.you),
  ).toMatchObject({ ok: true, value: { removed: false, retained: true } });
});

it('refuses tokens before parsing or reading workspaces, and humans cannot remove a foreign or active tree', async () => {
  for (const [party, caller] of Object.entries(CALLERS)) {
    if (party === 'you') continue;
    for (const args of [null, { canvas: CANVAS, worktree: TREE }])
      expect(await core.call('worktree.remove', args, caller)).toMatchObject({
        ok: false,
        error: { code: 'human-only' },
      });
  }
  for (const worktree of [ACTIVE, FOREIGN, ABSENT])
    expect(
      await core.call('worktree.remove', { canvas: CANVAS, worktree }, CALLERS.you),
    ).toMatchObject({ ok: false, error: { code: 'not-found' } });
  expect(assess).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
});

it('raises C7’s discard proposal for work, leaves it on refusal, and binds approval to its fingerprint', async () => {
  state = { ...state, changed: 1, paths: ['notes.md'] };
  const proposed = await core.call(
    'worktree.remove',
    { canvas: CANVAS, worktree: TREE },
    CALLERS.you,
  );
  expect(proposed.ok, JSON.stringify(proposed)).toBe(true);
  if (!proposed.ok || !('proposed' in proposed.value)) throw new Error('Expected a proposal');
  const need = proposed.value.proposed;
  expect(remove).not.toHaveBeenCalled();
  expect(workspaces.worktree(TREE)?.state).toBe('retained');
  expect(
    await core.call(
      'reply',
      { canvas: CANVAS, to: need, answer: { choice: 'refuse' } },
      CALLERS.you,
    ),
  ).toMatchObject({ ok: true });
  expect(remove).not.toHaveBeenCalled();
  const again = await core.call('worktree.remove', { canvas: CANVAS, worktree: TREE }, CALLERS.you);
  if (!again.ok || !('proposed' in again.value)) throw new Error('Expected another proposal');
  // Replay through the normal reply router must preserve C7's fingerprint guard.
  state = { ...state, changed: 2 };
  expect(
    await core.call(
      'reply',
      {
        canvas: CANVAS,
        to: again.value.proposed,
        answer: { choice: 'discard' },
      },
      CALLERS.you,
    ),
  ).toMatchObject({ ok: true, value: { outcome: 'stale' } });
  expect(remove).not.toHaveBeenCalled();
});
