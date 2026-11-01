import { describe, expect, it } from 'vitest';

import type { OpDef } from './define';
import { PROPOSING_RULES } from './define';
import { DEVIATIONS } from './deviations';
import { idsIn } from './ids';
import { OPS, opsFor } from './registry';
import { RULES } from './rules';
import { A, PARTIES, SURFACE, Y } from './surface';
import { CANVAS_TOPICS, TOPICS } from './topics';

const canvas = '11111111-1111-4111-8111-111111111111';
const worktree = '22222222-2222-4222-8222-222222222222';
const opOf = (name: string) => (OPS as Readonly<Record<string, OpDef>>)[name];

describe('the kept-worktree removal contract', () => {
  it('registers C7’s destructive command for the human alone, confirming work as workspace-safety', () => {
    expect(SURFACE).toHaveProperty('worktree.remove', {
      access: Y,
      kind: 'command',
      scope: 'canvas',
      rules: ['workspace-safety'],
      destructive: true,
    });
    for (const party of PARTIES)
      expect(opsFor(SURFACE, party).includes('worktree.remove')).toBe(party === 'you');
  });

  it('takes only bounded canvas and worktree ids, exposing both to reach', () => {
    const op = opOf('worktree.remove');
    expect(op).toBeDefined();
    if (op === undefined) return;
    const args = op.input.parse({ canvas, worktree });
    expect(idsIn(op.input, args)).toEqual([
      { brand: 'CanvasId', id: canvas, path: '.canvas' },
      { brand: 'WorktreeId', id: worktree, path: '.worktree' },
    ]);
    for (const invalid of [
      {},
      { canvas },
      { canvas, worktree: '/a/checkout' },
      { canvas, worktree: 'x'.repeat(4096) },
      { canvas: 'not-a-canvas', worktree },
      { canvas, worktree, force: true },
      { canvas, worktree, path: '/a/checkout' },
    ])
      expect(op.input.safeParse(invalid).success).toBe(false);
    expect(op.output.safeParse({ removed: true, revs: {} }).success).toBe(true);
    expect(op.output.safeParse({ removed: false, retained: true, revs: {} }).success).toBe(true);
    expect(op.output.safeParse(true).success).toBe(false);
  });
});

describe('the worktree list contract', () => {
  it('is everyone’s read of the agents each reaches, varying by caller, read through its topic', () => {
    expect(SURFACE).toHaveProperty('worktree.list', {
      access: A,
      kind: 'read',
      scope: 'none',
      reads: 'worktrees',
      self: 'allowed',
      varies: ['items', 'kept'],
    });
    for (const party of PARTIES) expect(opsFor(SURFACE, party)).toContain('worktree.list');
    // A canvas's replacement topic, GUI-only as every topic is (topics.subscribe is yours).
    expect(TOPICS).toContain('worktrees');
    expect(CANVAS_TOPICS).toContain('worktrees');
  });

  it('takes a canvas and, optionally, one agent: no path, no workspace, nothing else', () => {
    const op = opOf('worktree.list');
    expect(op).toBeDefined();
    if (op === undefined) return;
    expect(idsIn(op.input, op.input.parse({ canvas, agent: 'builder' }))).toEqual([
      { brand: 'CanvasId', id: canvas, path: '.canvas' },
      { brand: 'AgentId', id: 'builder', path: '.agent' },
    ]);
    for (const invalid of [
      { canvas, agent: '' },
      { canvas, agent: 'x'.repeat(4096) },
      { canvas, worktree },
      { canvas, path: '/a/checkout' },
      { canvas: 'nope' },
    ])
      expect(op.input.safeParse(invalid).success).toBe(false);
    // A token's item carries none of what is yours alone; yours may.
    const token = {
      agent: 'builder',
      mode: 'group',
      workspace: worktree,
      generation: 1,
      branch: `corrallm/p/${worktree}`,
      base: { ref: 'refs/heads/main', oid: 'a'.repeat(40) },
      state: 'setup',
      merge: { merged: null, uncommitted: null },
    };
    expect(op.output.safeParse({ items: [token], kept: [], into: null }).success).toBe(true);
    const yours = {
      ...token,
      need: `setup/${worktree}/1`,
      location: '/picked/.corral/worktrees/p/w',
      setup: { state: 'pending', command: 'npm ci', source: 'detected', exitCode: null },
    };
    expect(op.output.safeParse({ items: [yours], kept: [], into: null }).success).toBe(true);
    expect(
      op.output.safeParse({ items: [{ ...token, state: 'deleted' }], kept: [], into: null })
        .success,
    ).toBe(false);
    expect(op.output.safeParse({ items: [], into: null }).success).toBe(false);
  });

  it('says the merge state as additive fields: your checkout’s branch at the top, each tree’s on its agents', () => {
    const op = opOf('worktree.list');
    expect(op).toBeDefined();
    if (op === undefined) return;
    const oid = 'b'.repeat(40);
    const item = {
      agent: 'builder',
      mode: 'own',
      workspace: worktree,
      generation: 1,
      branch: `corrallm/p/${worktree}`,
      base: { ref: 'refs/heads/main', oid: 'a'.repeat(40) },
      state: 'ready',
    };
    const listed = (merge: unknown, into: unknown = { ref: 'refs/heads/main', oid }) =>
      op.output.safeParse({ items: [{ ...item, merge }], kept: [], into }).success;
    // Read, or not yet (null), as B9b Design §9 C12 freezes them; a held job's sentence is yours.
    expect(listed({ merged: true, uncommitted: 0 })).toBe(true);
    expect(listed({ merged: null, uncommitted: null })).toBe(true);
    expect(listed({ merged: false, uncommitted: 3, job: 'merging' })).toBe(true);
    expect(
      listed({ merged: null, uncommitted: null, job: 'held', sentence: 'Check git status.' }),
    ).toBe(true);
    expect(listed({ merged: true, uncommitted: 0 }, null)).toBe(true);
    expect(listed({ merged: true, uncommitted: 0 }, { ref: null, oid })).toBe(true);
    expect(listed({ merged: true, uncommitted: 0 }, { ref: null, oid: null })).toBe(true);
    // An item with no tree carries none.
    expect(
      op.output.safeParse({ items: [{ ...item, workspace: null }], kept: [], into: null }).success,
    ).toBe(true);
    for (const [merge, into] of [
      [{ merged: true }, undefined],
      [{ merged: true, uncommitted: -1 }, undefined],
      [{ merged: true, uncommitted: 0, job: 'done' }, undefined],
      [{ merged: true, uncommitted: 0, sentence: 'not held' }, undefined],
      [{ merged: true, uncommitted: 0, tip: oid }, undefined],
      [
        { merged: true, uncommitted: 0 },
        { ref: 'refs/heads/main', oid: 'nope' },
      ],
      [{ merged: true, uncommitted: 0 }, { ref: 'refs/heads/main' }],
    ] as const) {
      expect(listed(merge, into)).toBe(false);
    }
  });
});

describe('the worktree retry contract', () => {
  it('is yours alone, a canvas command that neither drains nor destroys, on the trust gate', () => {
    expect(SURFACE).toHaveProperty('worktree.retry', {
      access: Y,
      kind: 'command',
      scope: 'canvas',
    });
    expect(DEVIATIONS['worktree.retry']).toBe('trust-gate');
    for (const party of PARTIES)
      expect(opsFor(SURFACE, party).includes('worktree.retry')).toBe(party === 'you');
  });

  it('names an agent, never a directory, ref, workspace or force', () => {
    const op = opOf('worktree.retry');
    expect(op).toBeDefined();
    if (op === undefined) return;
    expect(idsIn(op.input, op.input.parse({ canvas, agent: 'builder' }))).toEqual([
      { brand: 'CanvasId', id: canvas, path: '.canvas' },
      { brand: 'AgentId', id: 'builder', path: '.agent' },
    ]);
    for (const invalid of [
      { canvas },
      { canvas, agent: 'builder', force: true },
      { canvas, agent: 'builder', worktree },
      { canvas, agent: 'builder', path: '/a/checkout' },
      { canvas, agent: 'builder', ref: 'refs/heads/main' },
    ])
      expect(op.input.safeParse(invalid).success).toBe(false);
    expect(op.output.safeParse({ state: 'creating', revs: {} }).success).toBe(true);
    expect(
      op.output.safeParse({ state: 'setup', need: `setup/${worktree}/2`, revs: {} }).success,
    ).toBe(true);
    expect(op.output.safeParse({ proposed: `proposal/${worktree}` }).success).toBe(false);
  });
});

describe('the workspace-safety rule', () => {
  it('is a change rule, one that makes a change a proposal, carried where one call meets it', () => {
    expect(RULES['workspace-safety'].kind).toBe('change');
    expect(PROPOSING_RULES).toContain('workspace-safety');
    for (const name of ['canvas.delete', 'canvas.batch', 'worktree.remove'] as const)
      expect(SURFACE[name].rules, name).toContain('workspace-safety');
  });
});
