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
 * - `lead-copy` and `lead-notice` (B24): the host-built card a routed lead gets, and the one note when
  that prompt no longer waits for it, each carrying its Need item.
- `evidence`: the hand-off's reply, kept for its queue: a record from the recipient to the
 *   queue's agent, `replyTo` the hand-off, with its task and how the turn ended. Never a turn and
 *   never pending: the queue's item reads it, its agent is not sent it.
 *
 * Keep this module free of Node, Electron and DOM imports: it is compiled into every process.
 */

export const PURPOSE_TYPES = ['handoff', 'evidence', 'lead-copy', 'lead-notice'] as const;
export type PurposeType = (typeof PURPOSE_TYPES)[number];

/**
 * A message's purpose, as its `purpose` column keeps it. B24 C5's two carry the Needs item they
 * are about (`need`): a lead's copy of a routed prompt, and the one notice a lead gets when that
 * prompt no longer waits for it.
 */
export const Purpose = z.discriminatedUnion('type', [
  z.strictObject({ v: z.literal(1), type: z.literal('handoff') }),
  z.strictObject({ v: z.literal(1), type: z.literal('evidence') }),
  z.strictObject({
    v: z.literal(1),
    type: z.literal('lead-copy'),
    need: z.string().min(1).max(512),
  }),
  z.strictObject({
    v: z.literal(1),
    type: z.literal('lead-notice'),
    need: z.string().min(1).max(512),
  }),
]);
export type Purpose = z.infer<typeof Purpose>;

/** A queue hand-off's purpose. */
export const QUEUE_HANDOFF: Purpose = Object.freeze({ v: 1, type: 'handoff' });

/** A queue hand-off's evidence's purpose. */
export const HANDOFF_EVIDENCE: Purpose = Object.freeze({ v: 1, type: 'evidence' });

/** A lead's copy of a routed prompt (B24 C5), for the Needs item `need`. */
export function leadCopy(need: string): Purpose {
  return Object.freeze({ v: 1, type: 'lead-copy', need });
}

/** The one notice a lead gets when the prompt it was copied no longer waits for it. */
export function leadNotice(need: string): Purpose {
  return Object.freeze({ v: 1, type: 'lead-notice', need });
}
