import { z } from 'zod';

import { Question, Questions } from '../model/prompts';
import { promptJsonBytes } from '../model/prompt-data';
import { define } from './define';
import { AttemptId, MessageId, OpCanvas, Target } from './ids';
import {
  MAX_ASK_BYTES,
  MAX_ASK_QUESTIONS,
  MAX_ASK_SECONDS,
  MAX_PROMPT_OPTIONS,
  MAX_SUMMARY_BYTES,
  MIN_ASK_SECONDS,
} from './limits';

/** Pure B21 contracts. Importing these schemas registers no operation or authority. */
const AskQuestion = Question.safeExtend({
  options: z.array(Question.shape.options.element.omit({ preview: true })).max(MAX_PROMPT_OPTIONS),
  secret: z
    .literal(false, { error: "Logins and secrets belong to the agent's CLI; ask without them." })
    .optional(),
});
export const AskQuestions = z
  .array(AskQuestion)
  .min(1)
  .max(MAX_ASK_QUESTIONS)
  .refine(
    (questions) => Questions.safeParse(questions).success,
    'Question ids are unique within the ask',
  );
export type AskQuestions = z.infer<typeof AskQuestions>;

const ask = define(
  { kind: 'command' },
  {
    summary: 'Asks a reached agent or a named party bounded, non-secret questions.',
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
