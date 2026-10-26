import { z } from 'zod';

import { AgentId } from '../api/ids';
import {
  MAX_ANSWER_LENGTH,
  MAX_DETAIL_LINES,
  MAX_FORM_FIELDS,
  MAX_ID_LENGTH,
  MAX_LINK_LENGTH,
  MAX_MESSAGE_LENGTH,
  MAX_PROMPT_BYTES,
  MAX_PROMPT_CHOICES,
  MAX_PROMPT_CHOICE_LENGTH,
  MAX_PROMPT_COMMAND_BYTES,
  MAX_PROMPT_DIFF_BYTES,
  MAX_PROMPT_EXTENSION_BYTES,
  MAX_PROMPT_EXTENSION_DEPTH,
  MAX_PROMPT_INPUT_BYTES,
  MAX_PROMPT_INPUT_DEPTH,
  MAX_PROMPT_LABEL_LENGTH,
  MAX_PROMPT_OPTIONS,
  MAX_PROMPT_PATH_LENGTH,
  MAX_PROMPT_PATHS,
  MAX_PROMPT_QUESTIONS,
  MAX_PROMPT_RULE_LENGTH,
  MAX_PROMPT_RULES,
  MAX_PROMPT_TEXT_LENGTH,
  MAX_REPLY_ANSWER_BYTES,
} from '../api/limits';
import { FlatFormSchema, formContent, parseForm } from './prompt-forms';
import { boundedPromptJson, promptJsonBytes, promptRecord } from './prompt-data';
import type { PromptJson } from './prompt-data';

export { FlatFormSchema, formContent, formFields, parseForm } from './prompt-forms';
export type { ParsedForm } from './prompt-forms';

/** Prepared, pure B13 protocol: no registration, native dispatch or authority classification. */
export const PromptKind = z.enum(['approval', 'question', 'plan', 'form']);
export type PromptKind = z.infer<typeof PromptKind>;
export const AnswerIn = z.enum(['api', 'terminal', 'both']);
export type AnswerIn = z.infer<typeof AnswerIn>;
export const PromptId = z.uuid().brand<'PromptId'>();
export type PromptId = z.infer<typeof PromptId>;
const Capability = z.enum(['none', 'seen', 'answerable']);
export const PromptCapabilities = z.strictObject({
  approval: Capability,
  question: Capability,
  plan: Capability,
  form: Capability,
});
export type PromptCapabilities = z.infer<typeof PromptCapabilities>;
/** Connection declarations are evidence of support, never a grant to a caller. */
export const PromptDescriptor = z.strictObject({
  prompts: PromptCapabilities,
  signals: z.boolean(),
});

const Id = z.string().min(1).max(MAX_ID_LENGTH);
const Label = z.string().min(1).max(MAX_PROMPT_LABEL_LENGTH);
const Text = z.string().max(MAX_PROMPT_TEXT_LENGTH);
const AnswerText = z.string().max(MAX_ANSWER_LENGTH);
const Path = z.string().min(1).max(MAX_PROMPT_PATH_LENGTH);
const Paths = z.array(Path).max(MAX_PROMPT_PATHS);
const Count = z.int().min(0);
const utf8 = (text: string) => new TextEncoder().encode(text).length;
const bytes = (limit: number) =>
  z
    .string()
    .max(limit)
    .refine((value) => utf8(value) <= limit, `At most ${String(limit)} UTF-8 bytes`);

export const ChoiceEffects = z.strictObject({
  rules: z
    .array(
      z.strictObject({
        behavior: z.enum(['allow', 'deny', 'ask']),
        rule: z.string().min(1).max(MAX_PROMPT_RULE_LENGTH),
        scope: z.enum(['session', 'project', 'user']),
      }),
    )
    .max(MAX_PROMPT_RULES)
    .optional(),
  mode: Id.optional(),
  directories: Paths.optional(),
  network: z
    .strictObject({
      host: Path,
      allow: z.boolean(),
      scope: z.enum(['turn', 'session', 'project', 'user']),
    })
    .optional(),
});
export type ChoiceEffects = z.infer<typeof ChoiceEffects>;
export const Choice = z.strictObject({
  value: z.string().min(1).max(MAX_PROMPT_CHOICE_LENGTH),
  label: Label,
  description: Text.optional(),
  hint: z.enum(['allow_once', 'allow_always', 'reject_once', 'reject_always']),
  effects: ChoiceEffects.optional(),
  feedback: z.enum(['none', 'optional', 'required']).optional(),
  endsTurn: z.boolean().optional(),
});
export type Choice = z.infer<typeof Choice>;
export const CoreChoice = Choice.extend({ humanOnly: Text.optional() });
export type CoreChoice = z.infer<typeof CoreChoice>;
export const PromptSignals = z.strictObject({
  askRule: z.literal(true).optional(),
  safetyCheck: z.literal(true).optional(),
  requiresUser: z.literal(true).optional(),
});
export type PromptSignals = z.infer<typeof PromptSignals>;

export const Question = z
  .strictObject({
    id: Id,
    header: z.string().max(MAX_ID_LENGTH),
    text: AnswerText,
    options: z
      .array(
        z.strictObject({
          label: Label,
          description: Text.optional(),
          preview: AnswerText.optional(),
        }),
      )
      .max(MAX_PROMPT_OPTIONS),
    multiple: z.boolean(),
    other: z.boolean(),
    secret: z.boolean().optional(),
  })
  .refine(
    (question) =>
      unique(question.options.map((option) => option.label)) &&
      (question.other || question.options.length > 0),
    'Distinct offered labels or an own-words answer',
  );
export type Question = z.infer<typeof Question>;
export const Questions = z
  .array(Question)
  .max(MAX_PROMPT_QUESTIONS)
  .refine(
    (questions) => unique(questions.map((question) => question.id)),
    'Question ids are unique within the prompt',
  );
export type Questions = z.infer<typeof Questions>;

/** JSON data only, with a bounded traversal before serialization (no cycles, getters or toJSON). */
const Input = z.custom<PromptJson>(
  (value) => boundedPromptJson(value, MAX_PROMPT_INPUT_BYTES, MAX_PROMPT_INPUT_DEPTH),
  { message: 'Bounded JSON tool input', abort: true },
);
const Extension = z
  .looseObject({
    type: z.templateLiteral([
      '_',
      z
        .string()
        .min(1)
        .max(MAX_ID_LENGTH - 1),
    ]),
  })
  .refine(
    (value): boolean =>
      boundedPromptJson(value, MAX_PROMPT_EXTENSION_BYTES, MAX_PROMPT_EXTENSION_DEPTH),
    { message: 'Bounded extension subject', abort: true },
  );
export const PromptSubject = z.union([
  z.strictObject({
    type: z.literal('command'),
    command: bytes(MAX_PROMPT_COMMAND_BYTES),
    cwd: Path,
  }),
  z.strictObject({
    type: z.literal('fileChange'),
    files: z
      .array(z.strictObject({ path: Path, diff: bytes(MAX_PROMPT_DIFF_BYTES).optional() }))
      .max(MAX_PROMPT_PATHS),
  }),
  z.strictObject({ type: z.literal('mcpTool'), server: Id, tool: Id, input: Input }),
  z.strictObject({
    type: z.literal('network'),
    host: Path,
    port: z.int().min(1).max(65535).optional(),
    protocol: Id.optional(),
  }),
  z.strictObject({
    type: z.literal('permissions'),
    network: z.boolean().optional(),
    read: Paths.optional(),
    write: Paths.optional(),
  }),
  z.strictObject({ type: z.literal('tool'), tool: Id, input: Input }),
  z.strictObject({ type: z.literal('trust') }),
  z.strictObject({ type: z.literal('consent'), key: Id, text: z.string().max(MAX_MESSAGE_LENGTH) }),
  Extension,
]);
export type PromptSubject = z.infer<typeof PromptSubject>;

const Detail = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('diff'),
    added: Count,
    removed: Count,
    lines: z
      .array(
        z.strictObject({
          kind: z.enum(['add', 'remove', 'same']),
          text: bytes(MAX_PROMPT_DIFF_BYTES),
        }),
      )
      .max(MAX_DETAIL_LINES),
  }),
  z.strictObject({
    kind: z.literal('output'),
    text: bytes(MAX_PROMPT_BYTES).refine(
      (text) => text.split('\n').length <= MAX_DETAIL_LINES,
      'At most twelve detail lines',
    ),
  }),
]);
const Form = z.union([
  z.strictObject({ schema: FlatFormSchema }),
  z.strictObject({ url: z.string().min(1).max(MAX_LINK_LENGTH) }),
]);
const envelope = {
  title: Text,
  summary: Text.optional(),
  reason: Text.optional(),
  detail: Detail.optional(),
  answerIn: AnswerIn,
  cut: z.literal(true).optional(),
};

function kinds<C extends typeof Choice | typeof CoreChoice, S extends z.core.$ZodShape>(
  choice: C,
  extra: S,
) {
  const common = { ...envelope, ...extra };
  const choices = z
    .array(choice)
    .max(MAX_PROMPT_CHOICES)
    .refine(
      (choices) => unique(choices.map((choice) => choice.value)),
      'Choice values are unique within the prompt',
    );
  return [
    z.strictObject({
      ...common,
      kind: z.literal('approval'),
      subject: PromptSubject.optional(),
      choices,
    }),
    z.strictObject({
      ...common,
      kind: z.literal('plan'),
      plan: z.string().min(1).max(MAX_MESSAGE_LENGTH),
      choices,
    }),
    z.strictObject({ ...common, kind: z.literal('question'), questions: Questions }),
    z.strictObject({ ...common, kind: z.literal('form'), form: Form }),
  ] as const;
}

export const AdapterPrompt = z
  .discriminatedUnion('kind', kinds(Choice, { signals: PromptSignals.optional() }))
  .superRefine(promptBounds);
export type AdapterPrompt = z.infer<typeof AdapterPrompt>;
export const PromptEvent = z.strictObject({
  type: z.literal('prompt'),
  key: z.uuid(),
  prompt: AdapterPrompt,
});
export type PromptEvent = z.infer<typeof PromptEvent>;
export const PromptEnded = z.strictObject({
  type: z.literal('prompt-ended'),
  key: z.uuid(),
  reason: z.enum(['withdrawn', 'answered-natively']),
});
export type PromptEnded = z.infer<typeof PromptEnded>;
export const Prompt = z
  .discriminatedUnion(
    'kind',
    kinds(CoreChoice, { id: PromptId, agent: AgentId, raised: Count, humanOnly: Text.optional() }),
  )
  .superRefine(promptBounds);
export type Prompt = z.infer<typeof Prompt>;

/** Prepared nested Needs metadata. Generic choices/questions/form/answerIn stay on the item. */
const needEnvelope = {
  id: PromptId,
  raised: Count,
  summary: Text.optional(),
  reason: Text.optional(),
  cut: z.literal(true).optional(),
  humanOnly: Text.optional(),
};
export const PromptNeedView = z
  .discriminatedUnion('kind', [
    z.strictObject({
      ...needEnvelope,
      kind: z.literal('approval'),
      subject: PromptSubject.optional(),
    }),
    z.strictObject({
      ...needEnvelope,
      kind: z.literal('plan'),
      plan: z
        .string()
        .max(MAX_MESSAGE_LENGTH)
        .refine(
          (text) => text.split('\n').length <= MAX_DETAIL_LINES,
          'At most twelve preview lines',
        )
        .optional(),
    }),
    z.strictObject({ ...needEnvelope, kind: z.literal('question') }),
    z.strictObject({ ...needEnvelope, kind: z.literal('form') }),
  ])
  .refine((view) => jsonBytes(view) <= MAX_PROMPT_BYTES, 'A bounded Needs preview');
export type PromptNeedView = z.infer<typeof PromptNeedView>;

/** Neither this schema nor an answer checker decides who may answer; the core owns that check. */
export const QuestionAnswer = z.union([
  z.strictObject({
    picked: z.array(Label).min(1).max(MAX_PROMPT_OPTIONS).refine(unique, 'Distinct picks'),
  }),
  z.strictObject({
    text: AnswerText.refine((value) => value.trim() !== '', 'An own-words answer is not blank'),
  }),
]);
export type QuestionAnswer = z.infer<typeof QuestionAnswer>;
export const QuestionAnswers = promptRecord(QuestionAnswer, MAX_PROMPT_QUESTIONS);
export type QuestionAnswers = z.infer<typeof QuestionAnswers>;
const FormValue = z.union([
  AnswerText,
  z.number(),
  z.boolean(),
  z.array(AnswerText).max(MAX_FORM_FIELDS),
]);
const Values = promptRecord(FormValue, MAX_FORM_FIELDS);
const formAnswer = { action: z.enum(['accept', 'decline', 'cancel']), values: Values.optional() };
const decider = {
  decider: z
    .strictObject({ party: z.string().min(1).max(512), name: z.string().min(1).max(MAX_ID_LENGTH) })
    .optional(),
};
export const PromptAnswer = z
  .discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('choice'),
      value: z.string().min(1).max(MAX_PROMPT_CHOICE_LENGTH),
      feedback: AnswerText.optional(),
      ...decider,
    }),
    z.strictObject({ kind: z.literal('questions'), answers: QuestionAnswers, ...decider }),
    z.strictObject({ kind: z.literal('form'), ...formAnswer, ...decider }),
  ])
  .refine((answer) => jsonBytes(answer) <= MAX_REPLY_ANSWER_BYTES, 'A bounded answer');
export type PromptAnswer = z.infer<typeof PromptAnswer>;
export const PromptReplyAnswer = z
  .union([
    z.strictObject({
      choice: z.string().min(1).max(MAX_PROMPT_CHOICE_LENGTH),
      feedback: AnswerText.optional(),
    }),
    z.strictObject({ answers: QuestionAnswers }),
    z.strictObject({ form: z.strictObject(formAnswer) }),
  ])
  .refine((answer) => jsonBytes(answer) <= MAX_REPLY_ANSWER_BYTES, 'A bounded reply');
export type PromptReplyAnswer = z.infer<typeof PromptReplyAnswer>;

export function checkQuestionAnswers(
  questions: readonly Question[],
  value: unknown,
): QuestionAnswers {
  const checked = Questions.parse(questions);
  const answers = QuestionAnswers.parse(value);
  if (
    Object.keys(answers).length !== checked.length ||
    Object.keys(answers).some((id) => !checked.some((question) => question.id === id))
  )
    throw new Error('Answer every question by its exact id.');
  for (const question of checked) {
    const answer = answers[question.id];
    if (!answer) throw new Error(`Answer question ${question.id}.`);
    if ('text' in answer) {
      if (!question.other) throw new Error(`Question ${question.id} takes only an offered choice.`);
    } else if (
      (!question.multiple && answer.picked.length !== 1) ||
      answer.picked.some((label) => !question.options.some((option) => option.label === label))
    )
      throw new Error(`Choose only the labels offered for question ${question.id}.`);
  }
  return answers;
}

export function checkPromptAnswer(prompt: AdapterPrompt | Prompt, value: unknown): PromptAnswer {
  const answer = PromptAnswer.parse(value);
  if (prompt.answerIn === 'terminal') throw new Error('Answer this prompt in its terminal.');
  switch (prompt.kind) {
    case 'approval':
    case 'plan': {
      if (answer.kind !== 'choice') throw new Error('Choose an offered decision.');
      const choice = prompt.choices.find((choice) => choice.value === answer.value);
      if (!choice) throw new Error('That decision is not offered by this prompt.');
      if (
        (choice.feedback === undefined || choice.feedback === 'none') &&
        answer.feedback !== undefined
      )
        throw new Error('That decision takes no feedback.');
      if (choice.feedback === 'required' && !answer.feedback?.trim())
        throw new Error('That decision requires feedback.');
      return answer;
    }
    case 'question':
      if (answer.kind !== 'questions') throw new Error('Answer the questions by id.');
      return { ...answer, answers: checkQuestionAnswers(prompt.questions, answer.answers) };
    case 'form': {
      if (answer.kind !== 'form') throw new Error('Answer the form.');
      if (answer.action !== 'accept' || 'url' in prompt.form) {
        if (answer.values !== undefined) throw new Error('This form action takes no values.');
        return answer;
      }
      const parsed = parseForm(prompt.form.schema);
      if (!parsed) throw new Error('This form is unsupported.');
      return { ...answer, values: formContent(parsed.fields, answer.values ?? {}) };
    }
  }
}

/** P4's reply shapes mapped to the adapter's answer, with no identity supplied by the reply. */
export function checkPromptReply(prompt: AdapterPrompt | Prompt, value: unknown): PromptAnswer {
  const reply = PromptReplyAnswer.parse(value);
  if ('choice' in reply)
    return checkPromptAnswer(prompt, {
      kind: 'choice',
      value: reply.choice,
      ...(reply.feedback === undefined ? {} : { feedback: reply.feedback }),
    });
  if ('answers' in reply)
    return checkPromptAnswer(prompt, { kind: 'questions', answers: reply.answers });
  return checkPromptAnswer(prompt, { kind: 'form', ...reply.form });
}

function promptBounds(
  prompt: {
    kind: PromptKind;
    answerIn: AnswerIn;
    choices?: readonly Choice[] | undefined;
    questions?: readonly Question[] | undefined;
    subject?: PromptSubject | undefined;
    detail?: z.infer<typeof Detail> | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  if (
    prompt.answerIn !== 'terminal' &&
    (prompt.kind === 'approval' || prompt.kind === 'plan') &&
    !prompt.choices?.some((choice) => choice.hint.startsWith('reject_'))
  )
    ctx.addIssue({ code: 'custom', message: 'An API decision must offer a rejection.' });
  if (
    prompt.answerIn !== 'terminal' &&
    prompt.kind === 'question' &&
    prompt.questions?.length === 0
  )
    ctx.addIssue({ code: 'custom', message: 'An API question prompt has questions.' });
  let diffs =
    prompt.detail?.kind === 'diff'
      ? prompt.detail.lines.reduce((size, line) => size + utf8(line.text), 0)
      : 0;
  if (prompt.subject?.type === 'fileChange') {
    for (const file of prompt.subject.files) diffs += utf8(file.diff ?? '');
  }
  if (diffs > MAX_PROMPT_DIFF_BYTES)
    ctx.addIssue({ code: 'custom', message: 'The diffs exceed their combined byte budget.' });
  if (jsonBytes(prompt) > MAX_PROMPT_BYTES)
    ctx.addIssue({
      code: 'custom',
      message: 'The whole normalized prompt exceeds its byte budget.',
    });
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}
function jsonBytes(value: unknown): number {
  return promptJsonBytes(value);
}
