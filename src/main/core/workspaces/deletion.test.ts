import { existsSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { NeedsItem } from '../../../shared/model/needs';
import { CanvasMemory } from '../../memory';
import { CATALOG, DEFAULT_ADAPTER } from '../../sessions/adapters';
import { FakeConnector } from '../../sessions/fake';
import type { Caller, OutsideCaller } from '../caller';
import { Documents } from '../canvas/documents';
import { createCore } from '../core';
import type { Core } from '../core';
import { keepCanvases, onDisk } from '../store/test-store';
import { CALLERS, NO_DESKTOP } from '../test-registry';
import { WorkspaceCleanup } from './cleanup';
import { GitRunner } from './git';
import type { WorktreeRecord } from './store';
import { git } from './test-git';
import { CANVAS, testWorkspaces } from './test-workspace';
import type { TestWorkspaces } from './test-workspace';

/*
 * B9a C7, through core.call: deleting the last agent of a worktree that holds work asks you first
 * (yours too, through the same proposals as a token's R4 delete): Cancel changes nothing, Delete
 * keeps its work in Kept worktrees, Discard removes it and its branch, and only while it is still
 * what you were asked about. A clean, merged tree goes with its last agent without asking. A canvas
 * that owns a workspace is never forgotten.
 */

const ORCHESTRATOR: OutsideCaller = {
  kind: 'outside',
  token: 'write-token',
  name: 'orchestrator',
  access: 'write',
  canvases: [CANVAS],
};
const YOU = CALLERS.you;

let made: TestWorkspaces;
let core: Core | undefined;
let cleanup: WorkspaceCleanup | undefined;
/** Who else may be writing in a tree, as the composed resolver binds its sessions there. */
let writing: ((tree: WorktreeRecord) => readonly string[]) | undefined;

beforeEach(async () => {
  made = await testWorkspaces();
  core = undefined;
  cleanup = undefined;
  writing = undefined;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await core?.close().catch(() => undefined);
  rmSync(made.root, { recursive: true, force: true });
});

/** The canvas: Builder in a worktree of its own, Reviewer in another, both lone agents. */
function canvasText(): string {
  const agent = (id: string, label: string, x: number) => ({
    id,
    kind: 'agent',
    label,
    position: { x, y: 0 },
    adapter: 'claude-code',
    connection: 'claude-code.terminal',
  });
  return JSON.stringify({
    format: 'corrallm',
    version: 2,
    id: CANVAS,
    nodes: [agent('a', 'Builder', 0), agent('b', 'Reviewer', 300)],
    links: [],
  });
}

/**
 * Each agent's worktree made and bound to it, then the core started over the profile, with its
 * cleanup composed through the test override: `file` false makes the canvas a draft, its document in rows.
 */
async function start({ file = true }: { file?: boolean } = {}): Promise<{
  core: Core;
  trees: Record<'a' | 'b', WorktreeRecord>;
}> {
  const repository = await made.repository();
  const a = (await made.provision('agent/a')).tree;
  const b = (await made.provision('agent/b')).tree;
  await made.workspaces.write((w) => {
    w.bindCanvas(CANVAS, repository.id);
    w.bind(CANVAS, 'a', a.id);
    w.bind(CANVAS, 'b', b.id);
  });
  if (!file) {
    // A draft: its document kept in rows, as the core keeps one it was given.
    const memory = new CanvasMemory(made.store);
    const documents = new Documents({
      store: made.store,
      memory,
      catalog: CATALOG,
      defaultAdapter: DEFAULT_ADAPTER,
    });
    documents.create(CANVAS, 'you');
    await documents.change(CANVAS, {
      revision: { op: 'canvas.addAgent', by: 'you' },
      build: (document) => ({
        next: { ...documents.read(canvasText()), id: document.id },
        result: undefined,
      }),
      check: () => undefined,
      committing: () => undefined,
    });
    await memory.flush();
  }
  await made.store.close();
  const at = path.join(made.root, 'team.corral');
  if (file) writeFileSync(at, canvasText());
  await keepCanvases(made.profile, {
    [CANVAS]: { ...(file ? { file: at } : {}), project: made.app },
  });
  const terminal = new FakeConnector({ mode: 'acceptEdits' });
  core = await createCore(
    {
      profile: made.profile,
      app: { name: 'corrallm', version: '9.8.7' },
      check: true,
      distribution: 'local',
      sessions: {
        connectors: { 'claude-code.terminal': terminal },
        environment: () => Promise.resolve(made.env),
      },
      cleanup: (deps) => {
        cleanup = new WorkspaceCleanup({
          ...deps,
          writers: (tree) => [...deps.writers(tree), ...(writing?.(tree) ?? [])],
          git: new GitRunner(made.runnerDeps),
          settleMs: 2000,
        });
        return cleanup;
      },
      watchFolder: () => ({ close: () => undefined }),
    },
    NO_DESKTOP,
  );
  await core.engines.open(CANVAS);
  return { core, trees: { a, b } };
}

function call(on: Core, op: string, args: object, caller: Caller = YOU) {
  return on.call(op as never, { canvas: CANVAS, ...args }, caller);
}

async function ok(on: Core, op: string, args: object, caller: Caller = YOU): Promise<unknown> {
  const result = await call(on, op, args, caller);
  if (!result.ok) throw new Error(`${op}: ${result.error.code}: ${result.error.sentence}`);
  return result.value;
}

async function needOf(on: Core, id: string): Promise<NeedsItem | undefined> {
  return ((await ok(on, 'needs', {})) as { items: NeedsItem[] }).items.find(
    (item) => item.id === id,
  );
}

/** The workspace's state as the core's store has it on disk now: none once it is forgotten. */
function stateOf(id: string): string | undefined {
  const disk = onDisk(made.profile);
  try {
    return disk.prepare('SELECT state FROM worktree WHERE id = ?').get(id)?.state as
      string | undefined;
  } finally {
    disk.close();
  }
}

function branchAt(ref: string): string | undefined {
  try {
    return git(made.app, made.env, 'rev-parse', '--verify', '--quiet', ref).trim();
  } catch {
    return undefined;
  }
}

const agents = (on: Core) =>
  on.engines
    .canvas(CANVAS)
    ?.document.nodes.filter((node) => node.type === 'agent')
    .map(({ id }) => id);

describe('deleting the last agent of a worktree', { timeout: 60_000 }, () => {
  it('that holds work asks you first: Cancel changes nothing, Delete keeps its work', async () => {
    const { core: on, trees } = await start();
    writeFileSync(path.join(trees.a.path, 'notes.md'), 'draft\n');
    const asked = (await ok(on, 'canvas.delete', { nodes: ['a'] })) as { proposed: string };
    expect(asked.proposed).toMatch(/^proposal\//);
    // Nothing applied: the agent and its tree as they were.
    expect(agents(on)).toEqual(['a', 'b']);
    expect(stateOf(trees.a.id)).toBe('setup');
    const item = await needOf(on, asked.proposed);
    expect(item).toMatchObject({
      kind: 'proposal',
      by: ['you'],
      title: 'Delete Builder? Its worktree holds work.',
      detail: 'Its worktree has 1 untracked file (notes.md).',
      choices: [{ value: 'allow' }, { value: 'discard' }, { value: 'refuse' }],
    });
    expect(
      await ok(on, 'reply', { to: asked.proposed, answer: { choice: 'refuse' } }),
    ).toMatchObject({ outcome: 'refused' });
    expect(agents(on)).toEqual(['a', 'b']);
    // Asked again, and deleted keeping its work: the tree kept, as it was, in Kept worktrees.
    const again = (await ok(on, 'canvas.delete', { nodes: ['a'] })) as { proposed: string };
    expect(
      await ok(on, 'reply', { to: again.proposed, answer: { choice: 'allow' } }),
    ).toMatchObject({ outcome: 'allowed' });
    expect(agents(on)).toEqual(['b']);
    expect(stateOf(trees.a.id)).toBe('retained');
    expect(existsSync(path.join(trees.a.path, 'notes.md'))).toBe(true);
    expect(cleanup?.kept(CANVAS)).toEqual([
      // Named as it was: its agent is gone.
      expect.objectContaining({ workspace: trees.a.id, state: 'retained', name: 'Builder' }),
    ]);
    // The other agent's tree is untouched.
    expect(stateOf(trees.b.id)).toBe('setup');
  });

  it('removes it and its branch on Discard, and only while it still holds what you were asked about', async () => {
    const { core: on, trees } = await start();
    writeFileSync(path.join(trees.a.path, 'notes.md'), 'draft\n');
    const first = (await ok(on, 'canvas.delete', { nodes: ['a'] })) as { proposed: string };
    // Work added while you decided: the question is stale, and nothing is removed.
    writeFileSync(path.join(trees.a.path, 'later.md'), 'more\n');
    expect(
      await ok(on, 'reply', { to: first.proposed, answer: { choice: 'discard' } }),
    ).toMatchObject({ outcome: 'stale' });
    expect(agents(on)).toEqual(['a', 'b']);
    expect(existsSync(path.join(trees.a.path, 'later.md'))).toBe(true);
    const second = (await ok(on, 'canvas.delete', { nodes: ['a'] })) as { proposed: string };
    expect(
      await ok(on, 'reply', { to: second.proposed, answer: { choice: 'discard' } }),
    ).toMatchObject({ outcome: 'allowed' });
    expect(agents(on)).toEqual(['b']);
    await vi.waitFor(
      () => {
        expect(stateOf(trees.a.id)).toBeUndefined();
      },
      { timeout: 20_000, interval: 50 },
    );
    expect(existsSync(trees.a.path)).toBe(false);
    expect(branchAt(trees.a.branchRef)).toBeUndefined();
    expect(stateOf(trees.b.id)).toBe('setup');
  });

  it('removes it on Discard though its agent’s session ran there as you were asked', async () => {
    const { core: on, trees } = await start();
    // Builder's session runs in its tree for as long as Builder is on the canvas.
    writing = (tree) => (tree.id === trees.a.id && (agents(on) ?? []).includes('a') ? ['a'] : []);
    writeFileSync(path.join(trees.a.path, 'notes.md'), 'draft\n');
    const asked = (await ok(on, 'canvas.delete', { nodes: ['a'] })) as { proposed: string };
    expect((await needOf(on, asked.proposed))?.detail).toMatch(/Builder may still be writing/);
    expect(
      await ok(on, 'reply', { to: asked.proposed, answer: { choice: 'discard' } }),
    ).toMatchObject({ outcome: 'allowed' });
    expect(agents(on)).toEqual(['b']);
    // Its session ended with it, having written nothing more: removed, as you chose.
    await vi.waitFor(
      () => {
        expect(stateOf(trees.a.id)).toBeUndefined();
      },
      { timeout: 20_000, interval: 50 },
    );
    expect(existsSync(trees.a.path)).toBe(false);
    expect(branchAt(trees.a.branchRef)).toBeUndefined();
  });

  it('removes a clean, merged one with its last agent, without asking', async () => {
    const { core: on, trees } = await start();
    const deleted = (await ok(on, 'canvas.delete', { nodes: ['a'] })) as Record<string, unknown>;
    expect(deleted).not.toHaveProperty('proposed');
    expect(agents(on)).toEqual(['b']);
    await vi.waitFor(
      () => {
        expect(stateOf(trees.a.id)).toBeUndefined();
      },
      { timeout: 20_000, interval: 50 },
    );
    expect(existsSync(trees.a.path)).toBe(false);
    expect(branchAt(trees.a.branchRef)).toBeUndefined();
  });

  it('comes to you from a token as its R4 proposal, with what the worktree holds', async () => {
    const { core: on, trees } = await start();
    writeFileSync(path.join(trees.a.path, 'README.md'), 'changed\n');
    const asked = (await ok(on, 'canvas.delete', { nodes: ['a'] }, ORCHESTRATOR)) as {
      proposed: string;
    };
    const item = await needOf(on, asked.proposed);
    expect(item).toMatchObject({
      title: '"orchestrator" asks to delete Builder: nothing queued',
      detail: 'Its worktree has 1 changed file (README.md).',
      choices: [{ value: 'allow' }, { value: 'discard' }, { value: 'refuse' }],
    });
    // No token decides what becomes of it.
    for (const choice of ['allow', 'discard']) {
      expect(
        await call(on, 'reply', { to: asked.proposed, answer: { choice } }, ORCHESTRATOR),
      ).toMatchObject({ ok: false, error: { code: 'refused' } });
    }
    expect(
      await ok(on, 'reply', { to: asked.proposed, answer: { choice: 'allow' } }),
    ).toMatchObject({ outcome: 'allowed' });
    expect(stateOf(trees.a.id)).toBe('retained');
    expect(git(trees.a.path, made.env, 'status', '--porcelain')).toContain('README.md');
  });
});

describe('a kept worktree', { timeout: 60_000 }, () => {
  it('is removed once safe, or once you confirm discarding what it holds; yours alone', async () => {
    const { core: on, trees } = await start();
    for (const [agent, tree] of [
      ['a', trees.a],
      ['b', trees.b],
    ] as const) {
      writeFileSync(path.join(tree.path, 'notes.md'), 'draft\n');
      const asked = (await ok(on, 'canvas.delete', { nodes: [agent] })) as { proposed: string };
      await ok(on, 'reply', { to: asked.proposed, answer: { choice: 'allow' } });
    }
    expect([stateOf(trees.a.id), stateOf(trees.b.id)]).toEqual(['retained', 'retained']);
    // No token removes one.
    expect(await call(on, 'worktree.remove', { worktree: trees.a.id }, ORCHESTRATOR)).toMatchObject(
      { ok: false, error: { code: 'human-only' } },
    );
    // Holding work, it asks you first.
    const asked = (await ok(on, 'worktree.remove', { worktree: trees.a.id })) as {
      proposed: string;
    };
    expect(await needOf(on, asked.proposed)).toMatchObject({
      title: 'Remove Builder’s kept worktree? It holds work.',
      detail: 'Its worktree has 1 untracked file (notes.md).',
      choices: [{ value: 'discard' }, { value: 'refuse' }],
    });
    expect(stateOf(trees.a.id)).toBe('retained');
    expect(
      await ok(on, 'reply', { to: asked.proposed, answer: { choice: 'discard' } }),
    ).toMatchObject({ outcome: 'allowed' });
    expect(stateOf(trees.a.id)).toBeUndefined();
    expect(existsSync(trees.a.path)).toBe(false);
    expect(branchAt(trees.a.branchRef)).toBeUndefined();
    // Cleaned up meanwhile: removed at once, with nothing to confirm.
    rmSync(path.join(trees.b.path, 'notes.md'));
    expect(await ok(on, 'worktree.remove', { worktree: trees.b.id })).toMatchObject({
      removed: true,
    });
    expect(stateOf(trees.b.id)).toBeUndefined();
    expect(cleanup?.kept(CANVAS)).toEqual([]);
    // One the canvas doesn't keep is none of its to remove.
    expect(await call(on, 'worktree.remove', { worktree: trees.b.id })).toMatchObject({
      ok: false,
      error: { code: 'not-found' },
    });
  });
});

describe('a workspace change', { timeout: 60_000 }, () => {
  it('waits for your Switch, at the plan it shows, keeping the worktree left', async () => {
    // Answered through the live reply: a workspace change is the router's, registered or not.
    const { core: on, trees } = await start();
    await ok(on, 'canvas.group', { nodes: ['a', 'b'], kind: 'frame' });
    const pending = ((await ok(on, 'needs', {})) as { items: NeedsItem[] }).items.filter((item) =>
      item.id.startsWith('rebind/'),
    );
    expect(pending).toEqual([
      expect.objectContaining({
        kind: 'worktree',
        by: ['you'],
        title: expect.stringMatching(/^Move Reviewer to .+’s worktree\?$/) as string,
        choices: [expect.objectContaining({ value: 'switch' })],
      }),
    ]);
    const [card] = pending;
    if (card === undefined) throw new Error('no card');
    expect(card).not.toHaveProperty('agent');
    // No token sees it, nor answers it.
    expect(
      ((await ok(on, 'needs', {}, ORCHESTRATOR)) as { items: NeedsItem[] }).items,
    ).not.toContainEqual(expect.objectContaining({ id: card.id }));
    expect(
      await call(on, 'reply', { to: card.id, answer: { choice: 'switch' } }, ORCHESTRATOR),
    ).toMatchObject({ ok: false, error: { code: 'not-found' } });
    // A card of an earlier plan of the same change is stale: never switched for the one now.
    const [, owner, generation] = card.id.split('/');
    const earlier = `rebind/${String(owner)}/${String(Number(generation) - 1)}`;
    expect(await call(on, 'reply', { to: earlier, answer: { choice: 'switch' } })).toMatchObject({
      ok: false,
      error: { code: 'conflict' },
    });
    const now = card;
    const switched = (await ok(on, 'reply', { to: now.id, answer: { choice: 'switch' } })) as {
      outcome: string;
    };
    expect(switched.outcome).toBe('completed');
    const disk = onDisk(made.profile);
    try {
      expect(
        disk
          .prepare(
            'SELECT agent_id, workspace_id, desired_owner_key FROM agent_worktree ORDER BY agent_id',
          )
          .all(),
      ).toEqual([
        { agent_id: 'a', workspace_id: trees.a.id, desired_owner_key: null },
        { agent_id: 'b', workspace_id: trees.a.id, desired_owner_key: null },
      ]);
    } finally {
      disk.close();
    }
    // The tree Reviewer left is kept, with its branch.
    expect(stateOf(trees.b.id)).toBe('retained');
    expect(branchAt(trees.b.branchRef)).toBe(made.base);
    expect(
      ((await ok(on, 'needs', {})) as { items: NeedsItem[] }).items.some((item) =>
        item.id.startsWith('rebind/'),
      ),
    ).toBe(false);
    expect(await call(on, 'reply', { to: now.id, answer: { choice: 'switch' } })).toMatchObject({
      ok: false,
      error: {
        code: 'conflict',
        sentence: expect.stringMatching(/You switched Reviewer/) as string,
      },
    });
  });
});

describe('a canvas that owns a workspace', { timeout: 60_000 }, () => {
  it('is never forgotten, though discarded as a draft: its document and records stay', async () => {
    const { core: on, trees } = await start({ file: false });
    expect(await ok(on, 'canvas.close', { discard: true })).toEqual({ revs: {} });
    const disk = onDisk(made.profile);
    try {
      expect(disk.prepare('SELECT id FROM canvas WHERE id = ?').get(CANVAS)).toBeDefined();
      expect(
        disk.prepare('SELECT count(*) AS n FROM node WHERE canvas_id = ?').get(CANVAS)?.n,
      ).toBe(2);
    } finally {
      disk.close();
    }
    expect(stateOf(trees.a.id)).toBe('setup');
    expect(stateOf(trees.b.id)).toBe('setup');
  });
});
