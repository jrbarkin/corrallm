import { z } from 'zod';

import {
  MAX_ASK_BYTES,
  MAX_ASK_QUESTIONS,
  MAX_MESSAGE_BYTES,
  MAX_PROMPT_OPTIONS,
} from '../api/limits';
import { promptJsonBytes } from './prompt-data';
import { Question, QuestionAnswers, Questions } from './prompts';

/*
 * Durable asks (B21 Design §9.2 C6): a question one party asks another on a canvas is a message of
 * kind `prompt`, from the asker to its recipient, whose `ask` column (migration 9) keeps the
 * questions and their deadline; its answer is a message back, whose `ask` column keeps the answers;
 * and how it ended is a value-free settlement on the ask's own row (`settled`), the counts only.
 * There is no ask table: the mailbox keeps delivery, withdrawal and settlement once.
 *
 * Keep this module free of Node, Electron and DOM imports: it is compiled into every process.
 */

/** A question an ask asks: B13's, with no preview and never secret (logins belong to the CLI). */
export const AskQuestion = Question.safeExtend({
  options: z.array(Question.shape.options.element.omit({ preview: true })).max(MAX_PROMPT_OPTIONS),
  secret: z
    .literal(false, { error: "Logins and secrets belong to the agent's CLI; ask without them." })
    .optional(),
});
export type AskQuestion = z.infer<typeof AskQuestion>;

/** One to MAX_ASK_QUESTIONS questions, their ids unique within the ask. */
export const AskQuestions = z
  .array(AskQuestion)
  .min(1)
  .max(MAX_ASK_QUESTIONS)
  .refine(
    (questions) => Questions.safeParse(questions).success,
    'Question ids are unique within the ask',
  );
export type AskQuestions = z.infer<typeof AskQuestions>;

/** The queue task an ask made during one of its attempt's own turns belongs to (C7: C5 sets it). */
const AskTask = z.strictObject({
  owner: z.string().min(1),
  item: z.string().min(1),
  attempt: z.uuid(),
});

const utf8 = (text: string) => new TextEncoder().encode(text).length;

/**
 * A message's `ask` column: on an ask's row, its questions, its deadline (epoch ms), whether it was
 * addressed to the asker's manager, and its task; on an answer's row, the ask it answers (`of`) and
 * the answers by question id, or the recipient's reply text where it gave no structured answer.
 */
export const AskColumn = z.union([
  z.strictObject({
    v: z.literal(1),
    type: z.literal('question'),
    questions: AskQuestions,
    deadline: z.int().min(0),
    via: z.literal('manager').optional(),
    task: AskTask.optional(),
  }),
  z.strictObject({
    v: z.literal(1),
    type: z.literal('answer'),
    of: z.uuid(),
    answers: QuestionAnswers.refine(
      (answers) => promptJsonBytes(answers) <= MAX_ASK_BYTES,
      'The answers are at most 16 KiB of JSON.',
    ),
  }),
  z.strictObject({
    v: z.literal(1),
    type: z.literal('answer'),
    of: z.uuid(),
    text: z
      .string()
      .max(MAX_MESSAGE_BYTES)
      .refine((text) => utf8(text) <= MAX_MESSAGE_BYTES, 'At most 16 KiB of UTF-8'),
  }),
]);
export type AskColumn = z.infer<typeof AskColumn>;
export type AskQuestionColumn = Extract<AskColumn, { type: 'question' }>;
export type AskAnswerColumn = Extract<AskColumn, { type: 'answer' }>;

/** Why an ask was withdrawn: its asker or its recipient left, its task ended, its canvas closed. */
export const ASK_WITHDRAWALS = ['asker', 'recipient', 'stopped', 'completed', 'closed'] as const;
export type AskWithdrawal = (typeof ASK_WITHDRAWALS)[number];

/** How an ask ended, value-free: how many were answered, never a label or an answer. */
export const AskOutcome = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('answers'), count: z.int().min(1).max(MAX_ASK_QUESTIONS) }),
  z.strictObject({ type: z.literal('text') }),
  z.strictObject({ type: z.literal('expired') }),
  z.strictObject({ type: z.literal('dismissed') }),
  z.strictObject({ type: z.literal('withdrawn'), why: z.enum(ASK_WITHDRAWALS) }),
]);
export type AskOutcome = z.infer<typeof AskOutcome>;

/**
 * An ask's settlement (C6), kept on its row in `settled` as it ends, and on the record its asker is
 * sent where no answer is: how many questions it asked and how it ended, never what was said.
 */
export const AskSettlement = z.strictObject({
  v: z.literal(1),
  ask: z.strictObject({ questions: z.int().min(1).max(MAX_ASK_QUESTIONS) }),
  outcome: AskOutcome,
});
export type AskSettlement = z.infer<typeof AskSettlement>;

/** The row state an ask's settlement leaves it in. */
export function askStateOf(outcome: AskOutcome): 'answered' | 'expired' | 'withdrawn' {
  switch (outcome.type) {
    case 'answers':
    case 'text':
    case 'dismissed':
      return 'answered';
    case 'expired':
      return 'expired';
    case 'withdrawn':
      return 'withdrawn';
  }
}
