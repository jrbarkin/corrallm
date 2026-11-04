import { z } from 'zod';

/*
 * A message's purpose (B19 C1): what the core made a message for, where that is neither a party's
 * nor the run's own direct send. Typed, versioned and core-minted: no caller gives one, and nothing
 * reads one from a message's task, parties, origin or state. Kept in a message's `purpose` column
 * (migration 12), written with its row and never changed after. A message without one keeps the
 * meaning it had before migration 12.
 *
 * - `handoff`: a queue hand-off, one queue's Message item for another agent: the queue's agent's
 *   pending message to that agent, carrying the item's attempt as its task, which delivery delivers
 *   once, at its recipient's delivery point.
 * - `evidence`: the hand-off's reply, kept for its queue: a record from the recipient to the
 *   queue's agent, `replyTo` the hand-off, with its task and how the turn ended. Never a turn and
 *   never pending: the queue's item reads it, its agent is not sent it.
 *
 * Keep this module free of Node, Electron and DOM imports: it is compiled into every process.
 */

export const PURPOSE_TYPES = ['handoff', 'evidence'] as const;
export type PurposeType = (typeof PURPOSE_TYPES)[number];

/** A message's purpose, as its `purpose` column keeps it. */
export const Purpose = z.strictObject({
  v: z.literal(1),
  type: z.enum(PURPOSE_TYPES),
});
export type Purpose = z.infer<typeof Purpose>;

/** A queue hand-off's purpose. */
export const QUEUE_HANDOFF: Purpose = Object.freeze({ v: 1, type: 'handoff' });

/** A queue hand-off's evidence's purpose. */
export const HANDOFF_EVIDENCE: Purpose = Object.freeze({ v: 1, type: 'evidence' });
