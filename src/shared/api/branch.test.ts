import { describe, expect, it } from 'vitest';

import {
  BRANCH_LIMITS,
  BranchDiffInput,
  BranchDiffOutput,
  BranchFile,
  BranchMergeInput,
  BranchMergeOutput,
  BranchStatus,
  WorktreeMerge,
  WorktreeMergeListing,
} from './branch';
import { idsIn } from './ids';
import { MAX_PAGE, MAX_PAGE_BYTES } from './limits';
import { OPS } from './registry';

const canvas = '11111111-1111-4111-8111-111111111111';
const workspace = '22222222-2222-4222-8222-222222222222';
const oid = 'a'.repeat(40);
const source = { ref: 'refs/heads/corrallm/p/w', oid };
const into = { ref: 'refs/heads/main', oid };
const request = '33333333-3333-4333-8333-333333333333';
const merge = { canvas, agent: 'builder', source, into, request };
const file = { section: 'committed', path: 'src/a.ts', status: 'modified' };
const diff = {
  agent: 'builder',
  workspace,
  shared: ['builder'],
  source: { ...source, onBranch: true },
  base: into,
  into,
  committed: { files: 1, complete: true },
  uncommitted: { changed: 0, untracked: 0, partlyStaged: 0, complete: true, digest: null },
  files: [file],
  next: null,
};

describe('prepared branch contracts', () => {
  it('prepares contracts without registering either operation or changing the live listing', () => {
    expect(OPS).not.toHaveProperty('branch.diff');
    expect(OPS).not.toHaveProperty('branch.merge');
    expect(OPS['worktree.list'].output.safeParse({ items: [], kept: [] }).success).toBe(true);
    expect(BranchDiffInput.parse({ agent: 'builder' })).toEqual({ agent: 'builder', limit: 50 });
  });

  it('brands only canvas and agent inputs: review pins and cursors confer no reach', () => {
    expect(idsIn(BranchMergeInput, BranchMergeInput.parse(merge))).toEqual([
      { brand: 'CanvasId', id: canvas, path: '.canvas' },
      { brand: 'AgentId', id: 'builder', path: '.agent' },
    ]);
    expect(
      idsIn(BranchDiffInput, BranchDiffInput.parse({ canvas, agent: 'builder', after: 'e30' })),
    ).toEqual(idsIn(BranchMergeInput, BranchMergeInput.parse(merge)));
  });

  it('bounds UTF-8, not just character counts, and refuses unknown keys at every level', () => {
    expect(
      BranchMergeInput.safeParse({ ...merge, source: { ref: 'é'.repeat(512), oid } }).success,
    ).toBe(true);
    for (const invalid of [
      { ...merge, source: { ref: 'é'.repeat(513), oid } },
      { ...merge, source: { ...source, force: true } },
      { ...merge, into: { ...into, path: '/picked' } },
      { ...merge, force: true },
      { ...merge, request: undefined },
      { ...merge, into: undefined },
      { ...merge, source: undefined },
      { ...merge, uncommitted: { choice: 'commit' } },
      { ...merge, uncommitted: { choice: 'commit', digest: oid } },
      { ...merge, uncommitted: { choice: 'leave', digest: 'b'.repeat(64) } },
      { ...merge, source: { ...source, oid: 'A'.repeat(40) } },
      { ...merge, into: { ...into, oid: null } },
    ])
      expect(BranchMergeInput.safeParse(invalid).success, JSON.stringify(invalid)).toBe(false);
    for (const invalid of [
      {},
      { agent: '' },
      { agent: 'builder', limit: 0 },
      { agent: 'builder', limit: 201 },
      { agent: 'builder', limit: 1.5 },
      { agent: 'builder', after: 'a'.repeat(513) },
      { agent: 'builder', after: 'e30=' },
      { agent: 'builder', after: '--' },
      { agent: 'builder', path: 'secret' },
    ])
      expect(BranchDiffInput.safeParse(invalid).success).toBe(false);
    for (const uncommitted of [{ choice: 'leave' }, { choice: 'commit', digest: 'b'.repeat(64) }])
      expect(BranchMergeInput.safeParse({ ...merge, uncommitted }).success).toBe(true);
    expect(
      BranchMergeInput.safeParse({
        ...merge,
        source: { ...source, oid: 'b'.repeat(64) },
        into: { ...into, oid: 'c'.repeat(64) },
      }).success,
    ).toBe(true);
    expect(
      BranchMergeInput.safeParse({ ...merge, into: { ...into, oid: 'b'.repeat(64) } }).success,
    ).toBe(false);
  });

  it('has the closed status set, strict file details and true-only marks', () => {
    expect(BranchStatus.options).toEqual([
      'added',
      'modified',
      'deleted',
      'renamed',
      'copied',
      'type-changed',
      'untracked',
    ]);
    expect(
      BranchFile.safeParse({
        ...file,
        oldPath: 'old.ts',
        mode: { old: '100644', new: '100755' },
        patch: '+new\n',
        cut: true,
      }).success,
    ).toBe(true);
    for (const invalid of [
      { ...file, status: 'conflicted' },
      { ...file, cut: false },
      { ...file, binary: false },
      { ...file, binary: true, patch: 'bytes' },
      { ...file, note: 'lossy-name', patch: 'bytes' },
      { ...file, note: 'unreadable', patch: 'bytes' },
      { ...file, mode: { old: '100644', new: 'anything' } },
      { ...file, path: 'é'.repeat(2049) },
      { ...file, patch: 'x'.repeat(MAX_PAGE_BYTES + 1) },
      { ...file, extra: true },
    ])
      expect(BranchFile.safeParse(invalid).success).toBe(false);
  });

  it('bounds the whole diff JSON including escaped paths, shared members and the cursor', () => {
    expect(BranchDiffOutput.safeParse(diff).success).toBe(true);
    expect(
      BranchDiffOutput.safeParse({
        ...diff,
        files: Array.from({ length: MAX_PAGE + 1 }, () => file),
      }).success,
    ).toBe(false);
    expect(
      BranchDiffOutput.safeParse({
        ...diff,
        files: [{ ...file, patch: '\n'.repeat(MAX_PAGE_BYTES / 2) }],
      }).success,
    ).toBe(false);
    expect(
      BranchDiffOutput.safeParse({
        ...diff,
        into: { ref: null, oid: null },
        base: { ref: null, oid },
      }).success,
    ).toBe(true);
    expect(
      BranchDiffOutput.safeParse({
        ...diff,
        committed: { files: Number.MAX_SAFE_INTEGER + 1, complete: false },
      }).success,
    ).toBe(false);
    expect(
      BranchDiffOutput.safeParse({ ...diff, source: { ...source, onBranch: true, path: '/tree' } })
        .success,
    ).toBe(false);
    expect(
      BranchDiffOutput.safeParse({
        ...diff,
        uncommitted: { ...diff.uncommitted, complete: false, digest: 'b'.repeat(64) },
      }).success,
    ).toBe(false);
  });

  it('uses the page byte budget for shared members rather than imposing a write-operation node cap', () => {
    const shared = Array.from({ length: 501 }, (_, i) => `member-${String(i)}`);
    expect(BranchDiffOutput.safeParse({ ...diff, shared }).success).toBe(true);
  });

  it('returns object merge outcomes with receipts, never an accepted job or proposal', () => {
    const result = {
      outcome: 'merged',
      source: oid,
      into: { ref: into.ref, before: oid, after: 'b'.repeat(40) },
      mergeCommit: 'b'.repeat(40),
      revs: {},
    };
    expect(BranchMergeOutput.safeParse(result).success).toBe(true);
    expect(BranchMergeOutput.safeParse({ ...result, checkpoint: oid }).success).toBe(true);
    expect(
      BranchMergeOutput.safeParse({
        outcome: 'already-merged',
        source: oid,
        into: { ref: into.ref, before: oid, after: oid },
        revs: {},
      }).success,
    ).toBe(true);
    for (const invalid of [
      { ...result, outcome: 'accepted' },
      { ...result, revs: undefined },
      { ...result, mergeCommit: oid },
      { proposed: 'proposal/x' },
      { ...result, outcome: 'already-merged', mergeCommit: undefined },
      { ...result, checkpoint: 'bad' },
      { ...result, revs: { x: -1 } },
    ])
      expect(BranchMergeOutput.safeParse(invalid).success).toBe(false);
  });

  it('prepares nullable worktree observations and bounded held sentences without inventing observations', () => {
    expect(WorktreeMerge.parse({ merged: null, uncommitted: null })).toEqual({
      merged: null,
      uncommitted: null,
    });
    expect(WorktreeMerge.safeParse({ merged: true, uncommitted: 0, job: 'merging' }).success).toBe(
      true,
    );
    expect(
      WorktreeMerge.safeParse({
        merged: false,
        uncommitted: 3,
        job: 'held',
        sentence: 'Check git status in your checkout.',
      }).success,
    ).toBe(true);
    expect(WorktreeMergeListing.safeParse({ into: null }).success).toBe(true);
    expect(WorktreeMergeListing.safeParse({ into: { ref: null, oid } }).success).toBe(true);
    for (const invalid of [
      { merged: true },
      { merged: true, uncommitted: -1 },
      { merged: false, uncommitted: 0, job: 'done' },
      { merged: false, uncommitted: null, sentence: 'not held' },
      {
        merged: false,
        uncommitted: null,
        job: 'held',
        sentence: 'x'.repeat(BRANCH_LIMITS.sentenceBytes + 1),
      },
    ])
      expect(WorktreeMerge.safeParse(invalid).success).toBe(false);
  });
});
