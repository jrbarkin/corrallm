import { z } from 'zod';

import { MAX_NEED_ID, MAX_PROMPT_CHOICE_LENGTH, MAX_PROMPT_QUESTIONS } from '../api/limits';
import { ChoiceHint, PromptId, PromptKind } from './prompts';
import type { PromptSubject } from './prompts';

/*
 * What a record of a native prompt's decision decided (B13 Design §9.2 C9), typed and value-free:
 * kept beside the record's words, in its message's `settled` (migration 7), for a decision that
 * reached a CLI. Its prompt's Needs item, id and kind, its subject's type where the protocol names
 * it, and what was chosen: a choice's value and hint, how many questions were answered, a form's
 * action; and whether an answer was secret. Never a label, a title, a summary, a reason, a
 * command, a path, a plan, feedback, an answer or a value given: labels are untrusted and can quote
 * a command. Withdrawn, answered in the terminal and dismissed are live outcomes, never records.
 *
 * Keep this module free of Node, Electron and DOM imports: it is compiled into every process.
 */

/** The subject types the protocol names (src/shared/model/prompts.ts): what a record may name. */
export const SUBJECT_TYPES = [
  'command',
  'fileChange',
  'mcpTool',
  'network',
  'permissions',
  'tool',
  'trust',
  'consent',
] as const;
export const SubjectType = z.enum(SUBJECT_TYPES);
export type SubjectType = z.infer<typeof SubjectType>;

/** A subject's type, if the protocol names it: an adapter's extension (`_…`) records none. */
export function subjectTypeOf(subject: PromptSubject | undefined): SubjectType | undefined {
  const parsed = SubjectType.safeParse(subject?.type);
  return parsed.success ? parsed.data : undefined;
}

/** What was chosen, without what was said: a choice's value and hint, a count, a form's action. */
export const SettledOutcome = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('choice'),
    value: z.string().min(1).max(MAX_PROMPT_CHOICE_LENGTH),
    hint: ChoiceHint,
  }),
  z.strictObject({ type: z.literal('answers'), count: z.int().min(1).max(MAX_PROMPT_QUESTIONS) }),
  z.strictObject({ type: z.literal('form'), action: z.enum(['accept', 'decline', 'cancel']) }),
]);
export type SettledOutcome = z.infer<typeof SettledOutcome>;

/** The outcome each kind of prompt settles with. */
const OUTCOME_OF: Readonly<Record<PromptKind, SettledOutcome['type']>> = {
  approval: 'choice',
  plan: 'choice',
  question: 'answers',
  form: 'form',
};

export const SettledDecision = z
  .strictObject({
    v: z.literal(1),
    /** Its prompt's Needs item: `prompt/<escaped agent>/<generation>/<PromptId>`. */
    need: z.string().max(MAX_NEED_ID),
    prompt: z.strictObject({
      id: PromptId,
      kind: PromptKind,
      subject: SubjectType.optional(),
    }),
    outcome: SettledOutcome,
    /** An answer to a secret question: never written, and its record says only so. */
    secret: z.literal(true).optional(),
  })
  .refine(
    ({ need, prompt }) =>
      /^prompt\/[^/]+\/\d+\/[^/]+$/.test(need) && need.endsWith(`/${prompt.id}`),
    'Its Needs item names its prompt',
  )
  .refine(
    ({ prompt, outcome, secret }) =>
      OUTCOME_OF[prompt.kind] === outcome.type &&
      (secret === undefined || prompt.kind === 'question'),
    'Its outcome is one its kind of prompt settles with',
  );
export type SettledDecision = z.infer<typeof SettledDecision>;
