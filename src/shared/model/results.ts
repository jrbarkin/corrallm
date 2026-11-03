import { z } from 'zod';

import { MAX_SUMMARY_BYTES } from '../api/limits';

/*
 * A task's reported result (B21 Design §9.2 C8): what an agent reports of its own tool step's
 * attempt with `complete`, kept on a message of kind `result` from the agent to corrallm (its
 * `task` the attempt, its `replyTo` the turn it was reported in), in that message's `verdict`
 * column (migration 10): the outcome, and a bounded summary in the agent's own words. The run reads
 * the outcome as that turn ends; the summary is never a condition's evidence, a Needs title, a
 * notification or a log line.
 *
 * Keep this module free of Node, Electron and DOM imports: it is compiled into every process.
 */

const utf8 = (text: string) => new TextEncoder().encode(text).length;

/**
 * A completion's summary: at most MAX_SUMMARY_BYTES of UTF-8, saying something (at least one
 * character that isn't a space), as the agent gave it: never trimmed or cut.
 */
export const Summary = z
  .string()
  .max(MAX_SUMMARY_BYTES)
  .regex(/\S/, 'A completion summary says what was done: give at least one word.')
  .refine(
    (text) => utf8(text) <= MAX_SUMMARY_BYTES,
    'A completion summary is at most 4 KiB of UTF-8.',
  );

/** How a task's step went, as its agent reported it with `complete`. */
export const REPORTED_OUTCOMES = ['succeeded', 'failed'] as const;
export type ReportedOutcome = (typeof REPORTED_OUTCOMES)[number];

/** A `result` record's verdict: the outcome its agent reported, and its summary. */
export const Verdict = z.strictObject({
  v: z.literal(1),
  outcome: z.enum(REPORTED_OUTCOMES),
  summary: Summary,
});
export type Verdict = z.infer<typeof Verdict>;
