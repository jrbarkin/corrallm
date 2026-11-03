import { z } from 'zod';

import { AskQuestions } from '../model/asks';
import { promptJsonBytes } from '../model/prompt-data';
import { define } from './define';
import { AttemptId, MessageId, OpCanvas, Target } from './ids';
import { MAX_ASK_BYTES, MAX_ASK_SECONDS, MAX_SUMMARY_BYTES, MIN_ASK_SECONDS } from './limits';

/** Pure B21 contracts. Importing these schemas registers no operation or authority. */
export { AskQuestions } from '../model/asks';

const ask = define(
  { kind: 'command' },
  {
    summary:
      'Asks an agent you reach, the user ({ party: "you" }) or your manager ({ party: "manager" }; ' +
      'the user, for now) one to four questions, each with options to pick or room for words. ' +
      'Returns at once with the question’s id, once it is kept: the answer comes later, as a ' +
      'message to you (the answers, or a record that it expired, was dismissed or withdrawn). ' +
      'If you can do no more without the answer, end your turn now. One open question per ' +
      'recipient; it expires after deadlineSeconds (a day unless you say). Never ask for logins ' +
      'or secrets: they belong to your CLI.',
    input: z
      .strictObject({
        canvas: OpCanvas,
        to: Target,
        questions: AskQuestions,
        deadlineSeconds: z.int().min(MIN_ASK_SECONDS).max(MAX_ASK_SECONDS).default(MAX_ASK_SECONDS),
      })
      .refine(
        (value) => promptJsonBytes(value) <= MAX_ASK_BYTES,
        'The whole normalized ask is at most 16 KiB of JSON.',
      ),
    output: z.strictObject({ id: MessageId }),
  },
);

const complete = define(
  { kind: 'command' },
  {
    summary:
      'Reports the outcome and bounded summary of the caller’s own running tool-step attempt.',
    input: z.strictObject({
      canvas: OpCanvas,
      task: AttemptId,
      outcome: z.enum(['succeeded', 'failed']),
      summary: z
        .string()
        .max(MAX_SUMMARY_BYTES)
        .refine(
          (text) => new TextEncoder().encode(text).length <= MAX_SUMMARY_BYTES,
          'A completion summary is at most 4 KiB of UTF-8.',
        ),
    }),
    output: z.strictObject({}),
  },
);

export const AskInput = ask.input;
export type AskInput = z.infer<typeof AskInput>;
export const AskOutput = ask.output;
export type AskOutput = z.infer<typeof AskOutput>;
export const CompleteInput = complete.input;
export type CompleteInput = z.infer<typeof CompleteInput>;
export const CompleteOutput = complete.output;
export type CompleteOutput = z.infer<typeof CompleteOutput>;

/** Enveloped definitions, prepared for their later core-owned registrations. */
export const agentApiOps = { ask, complete };
