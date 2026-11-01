import { z } from 'zod';

import { AgentId, OpCanvas, WorktreeId } from './ids';
import { DEFAULT_PAGE, MAX_EXPECT, MAX_PAGE, MAX_PAGE_BYTES } from './limits';

/** B9b wire contracts. Importing this file alone registers nothing. */
export const BRANCH_LIMITS = {
  refBytes: 1024,
  pathBytes: 4096,
  cursorBytes: 512,
  inventoryEntries: 10_000,
  untrackedBytes: 1024 * 1024,
  hashBytes: 1024 * 1024 * 1024,
  binaryProbeBytes: 8000,
  sentenceBytes: 2048,
  sentencePaths: 5,
  quotedPathBytes: 256,
} as const;

const utf8 = (text: string) => new TextEncoder().encode(text).length;
const text = (max: number) =>
  z
    .string()
    .max(max)
    .refine(
      (value) => value.isWellFormed() && utf8(value) <= max,
      `At most ${String(max)} bytes of UTF-8`,
    );

/** Compared review values, never identifiers resolved for reach or arguments passed to Git. */
export const BranchRef = text(BRANCH_LIMITS.refBytes)
  .min(1)
  .refine((value) => !value.includes('\0'));
export const BranchOid = z
  .string()
  .min(40)
  .max(64)
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
export const BranchDigest = z
  .string()
  .length(64)
  .regex(/^[0-9a-f]{64}$/);
export const BranchAfter = z
  .string()
  .min(2)
  .max(BRANCH_LIMITS.cursorBytes)
  .regex(/^[A-Za-z0-9_-]+$/)
  .refine((value) => {
    switch (value.length % 4) {
      case 0:
        return true;
      case 2:
        return /[AQgw]$/.test(value);
      case 3:
        return /[AEIMQUYcgkosw048]$/.test(value);
      default:
        return false;
    }
  }, 'Canonical unpadded base64url');
export const BranchLimit = z.int().min(1).max(MAX_PAGE).default(DEFAULT_PAGE);
const Count = z.int().min(0);
const Pin = z.strictObject({ ref: BranchRef, oid: BranchOid });
export const BranchInto = z.strictObject({ ref: BranchRef.nullable(), oid: BranchOid.nullable() });

export const BranchDiffInput = z.strictObject({
  canvas: OpCanvas,
  agent: AgentId,
  after: BranchAfter.optional(),
  limit: BranchLimit,
});
export type BranchDiffInput = z.infer<typeof BranchDiffInput>;

export const BranchStatus = z.enum([
  'added',
  'modified',
  'deleted',
  'renamed',
  'copied',
  'type-changed',
  'untracked',
]);
export type BranchStatus = z.infer<typeof BranchStatus>;
const Mode = z.enum(['000000', '100644', '100755', '120000', '160000', '040000']);
export const BranchFile = z
  .strictObject({
    section: z.enum(['committed', 'uncommitted']),
    path: text(BRANCH_LIMITS.pathBytes).min(1),
    oldPath: text(BRANCH_LIMITS.pathBytes).min(1).optional(),
    status: BranchStatus,
    mode: z.strictObject({ old: Mode.nullable(), new: Mode.nullable() }).optional(),
    staged: z.boolean().optional(),
    binary: z.literal(true).optional(),
    patch: text(MAX_PAGE_BYTES).optional(),
    cut: z.literal(true).optional(),
    note: z
      .enum(['symlink', 'gitlink', 'nested-repository', 'unreadable', 'too-large', 'lossy-name'])
      .optional(),
  })
  .refine(
    (file) =>
      file.patch === undefined ||
      (file.binary !== true &&
        !['gitlink', 'nested-repository', 'unreadable', 'lossy-name'].includes(file.note ?? '')),
    'A binary, unreadable or lossy entry has no patch',
  )
  .refine(
    (file) => !file.cut || !file.patch || file.patch.endsWith('\n'),
    'A cut patch ends at a line boundary',
  );
export type BranchFile = z.infer<typeof BranchFile>;

export const BranchDiffOutput = z
  .strictObject({
    agent: AgentId,
    workspace: WorktreeId,
    // A nonempty id needs at least four JSON bytes, including its quotes and separator.
    // The whole-result byte check is tighter; a write operation's node cap is unrelated.
    shared: z.array(AgentId).max(Math.floor(MAX_PAGE_BYTES / 4)),
    source: Pin.extend({ onBranch: z.boolean() }),
    base: z.strictObject({ ref: BranchRef.nullable(), oid: BranchOid }),
    into: BranchInto,
    committed: z.strictObject({ files: Count, complete: z.boolean() }),
    uncommitted: z
      .strictObject({
        changed: Count,
        untracked: Count,
        partlyStaged: Count,
        complete: z.boolean(),
        digest: BranchDigest.nullable(),
      })
      .refine(
        (value) => value.digest === null || (value.complete && value.partlyStaged === 0),
        'An incomplete or partly staged inventory has no digest',
      ),
    files: z.array(BranchFile).max(MAX_PAGE),
    next: BranchAfter.nullable(),
  })
  .refine(
    (value) =>
      [value.base.oid, value.into.oid].every(
        (oid) => oid === null || oid.length === value.source.oid.length,
      ),
    'One repository object format',
  )
  .refine(
    (value) => utf8(JSON.stringify(value)) <= MAX_PAGE_BYTES,
    'The entire result fits the page budget',
  )
  .meta({ maxBytes: MAX_PAGE_BYTES });
export type BranchDiffOutput = z.infer<typeof BranchDiffOutput>;

export const BranchMergeInput = z
  .strictObject({
    canvas: OpCanvas,
    agent: AgentId,
    source: Pin,
    into: Pin,
    uncommitted: z
      .discriminatedUnion('choice', [
        z.strictObject({ choice: z.literal('leave') }),
        z.strictObject({ choice: z.literal('commit'), digest: BranchDigest }),
      ])
      .optional(),
    request: z.uuid(),
  })
  .refine(
    (value) => value.source.oid.length === value.into.oid.length,
    'One repository object format',
  );
export type BranchMergeInput = z.infer<typeof BranchMergeInput>;

// The eventual core supplies receipts. These prepared outputs bound their keys and cardinality.
const Revs = z
  .record(text(512).min(1), Count)
  .refine((value) => Object.keys(value).length <= MAX_EXPECT)
  .meta({ maxProperties: MAX_EXPECT });
const IntoResult = z.strictObject({ ref: BranchRef, before: BranchOid, after: BranchOid });
export const BranchMergeOutput = z
  .discriminatedUnion('outcome', [
    z
      .strictObject({
        outcome: z.literal('merged'),
        source: BranchOid,
        into: IntoResult,
        mergeCommit: BranchOid,
        checkpoint: BranchOid.optional(),
        checkpointRecorded: z.literal(false).optional(),
        revs: Revs,
      })
      .refine(
        (value) =>
          value.mergeCommit === value.into.after &&
          (value.checkpoint === undefined || value.source === value.checkpoint) &&
          (value.checkpointRecorded === undefined || value.checkpoint !== undefined),
        'The result names the commits installed and merged',
      ),
    z
      .strictObject({
        outcome: z.literal('already-merged'),
        source: BranchOid,
        into: IntoResult,
        revs: Revs,
      })
      .refine((value) => value.into.before === value.into.after, 'Already merged moves no ref'),
  ])
  .refine(
    (value) =>
      [value.source, value.into.before].every((oid) => oid.length === value.into.after.length),
    'One repository object format',
  );
export type BranchMergeOutput = z.infer<typeof BranchMergeOutput>;

/**
 * worktree.list's and `worktrees:<c>`'s additive merge state (B9b Design §9 C12, built by C6): an
 * item's tree's, present when the item has a tree; and, at the top, your picked checkout's
 * branch and commit (`WorktreeMergeListing`).
 */
export const WorktreeMerge = z
  .strictObject({
    merged: z.boolean().nullable(),
    uncommitted: Count.nullable(),
    job: z.enum(['merging', 'held']).optional(),
    /** Yours alone: the selector omits it for every token. */
    sentence: text(BRANCH_LIMITS.sentenceBytes).min(1).optional(),
  })
  .refine(
    (value) => value.sentence === undefined || value.job === 'held',
    'Only a held job has a sentence',
  );
export type WorktreeMerge = z.infer<typeof WorktreeMerge>;
export const WorktreeMergeListing = z.strictObject({ into: BranchInto.nullable() });
export type WorktreeMergeListing = z.infer<typeof WorktreeMergeListing>;
