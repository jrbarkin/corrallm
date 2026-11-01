import { z } from 'zod';

import { FallbackViewSchema } from '../../model/fallback';
import { MESSAGE_KINDS, MESSAGE_STATES, PARTY_PATTERN } from '../../model/messages';
import { NEED_KINDS } from '../../model/needs';
import { Choice, PromptNeedView } from '../../model/prompts';
import { SettledDecision } from '../../model/settled';
import { TURN_REASONS } from '../../session';
import { define } from '../define';
import type { OpDef } from '../define';
import { AgentId, MessageId, NeedId, OpCanvas } from '../ids';
import { MAX_PAGE, MAX_WAIT_SECONDS } from '../limits';
import type { OpName } from '../surface';
import { Body as B11Body, Images, ManualBody } from './b11-data';
import {
  MAX_ANSWER_LENGTH,
  MAX_FORM_FIELDS,
  MAX_ID_LENGTH,
  MAX_QUESTIONS,
  PLAN_MODES,
  ELICITATION_ACTIONS,
} from '../../session';
import { MAX_REPLY_ANSWER_BYTES } from '../limits';

/**
 * Conversation (Core Server §4 H; API Spec §7.2): what parties send agents, what waits for whom,
 * and who reaches what.
 */

/** A party: you, corrallm, an agent (`agent:<id>`) or an outside orchestrator (`outside:<name>`). */
const Party = z.string().regex(PARTY_PATTERN);

/** Where to read from: opaque, minted by the store's order; it survives restarts. */
export const Cursor = z.string().min(1).max(4096);

export const TurnResult = z.strictObject({
  status: z.enum(['completed', 'failed', 'cancelled']),
  reason: z.enum(TURN_REASONS),
  message: z.string().optional(),
  resetsAt: z.number().optional(),
});

export const Message = z.strictObject({
  id: z.uuid(),
  canvas: z.uuid(),
  from: Party,
  to: Party,
  kind: z.enum(MESSAGE_KINDS),
  body: z.string(),
  replyTo: z.uuid().optional(),
  resendOf: z.uuid().optional(),
  task: z.strictObject({ agent: z.string(), item: z.string(), attempt: z.string() }).optional(),
  turn: TurnResult.optional(),
  state: z.enum(MESSAGE_STATES),
  delivery: z.strictObject({ at: z.number(), as: z.string(), attempt: z.int() }).optional(),
  by: Party.optional(),
  /** A record of a native prompt's decision: what was decided, value-free. Yours alone. */
  settled: SettledDecision.optional(),
  at: z.number(),
});

export const NeedsItem = z.strictObject({
  id: z.string(),
  canvas: z.uuid(),
  agent: z.string().optional(),
  kind: z.enum(NEED_KINDS),
  for: Party,
  by: z.array(Party),
  title: z.string(),
  detail: z.string().optional(),
  until: z.number().optional(),
  /** A prompt's choices also say what its CLI does with each (B13 C1): yours alone (C11). */
  choices: z.array(
    z.strictObject({
      value: z.string(),
      label: z.string(),
      description: z.string().optional(),
      humanOnly: z.string().optional(),
      hint: Choice.shape.hint.optional(),
      effects: Choice.shape.effects,
      feedback: Choice.shape.feedback,
      endsTurn: Choice.shape.endsTurn,
    }),
  ),
  text: z.strictObject({ placeholder: z.string() }).optional(),
  questions: z
    .array(
      z.strictObject({
        id: z.string(),
        header: z.string(),
        text: z.string(),
        options: z.array(
          z.strictObject({
            label: z.string(),
            description: z.string().optional(),
            preview: z.string().optional(),
          }),
        ),
        multiple: z.boolean(),
        other: z.boolean(),
        secret: z.boolean().optional(),
      }),
    )
    .optional(),
  form: z
    .union([
      z.strictObject({ schema: z.record(z.string(), z.unknown()) }),
      z.strictObject({ url: z.string() }),
    ])
    .optional(),
  answerIn: z.enum(['api', 'terminal', 'both']),
  /**
   * A prompt the core's prompt owner holds (B13 C1): its id, kind, when it was raised, its words,
   * subject and a plan's first lines, as the caller may read them (C11).
   */
  prompt: PromptNeedView.optional(),
});

/** How an agent is now: waiting for you, working, paused (its queue held), or idle. */
export const AGENT_STATES = ['waiting', 'working', 'paused', 'limited', 'idle'] as const;

const canvas = OpCanvas;

export const conversationOps = {
  agents: define('agents', {
    summary:
      'The agents you reach on the canvas: each one’s id, name, adapter and connection, how it is ' +
      'now, how many prompts of its own wait for an answer, the agents it is linked to, and ' +
      'where it is in its fallback chain.',
    input: z.strictObject({ canvas }),
    output: z.strictObject({
      agents: z.array(
        z.strictObject({
          id: z.string(),
          name: z.string(),
          adapter: z.string(),
          connection: z.string(),
          state: z.enum(AGENT_STATES),
          prompts: z.int(),
          linked: z.array(z.string()),
          api: z.boolean(),
          fallback: FallbackViewSchema.nullable(),
        }),
      ),
    }),
  }),
  status: define('status', {
    summary:
      'How the agents you reach are now (their state, the message whose turn is going, model ' +
      'and effort), what waits for the user on them, and a cursor at the end of your messages.',
    input: z.strictObject({ canvas }),
    output: z.strictObject({
      agents: z.array(
        z.strictObject({
          id: z.string(),
          state: z.enum(AGENT_STATES),
          message: z.uuid().nullable(),
          model: z.string().nullable(),
          effort: z.string().nullable(),
          fallback: FallbackViewSchema.nullable(),
        }),
      ),
      waitingForYou: z.array(NeedsItem),
      next: Cursor,
    }),
  }),
  needs: define('needs', {
    summary:
      'What waits for an answer on the agents you reach: holds of the run and prompts of their ' +
      'sessions. What only the user may answer is listed without its choices.',
    input: z.strictObject({ canvas }),
    output: z.strictObject({ items: z.array(NeedsItem) }),
  }),
  messages: define('messages', {
    summary:
      'Your messages on the canvas, oldest first: what you sent and what was sent to you, ' +
      'replies and corrallm’s notices included. `with` keeps those with one party; `after` (a ' +
      'cursor) reads on from where a call left off, and `next` is where this one did. A page ' +
      'ends early rather than grow too big for one result.',
    input: z.strictObject({
      canvas,
      with: Party.max(300).optional(),
      after: Cursor.optional(),
      limit: z.int().min(1).max(MAX_PAGE).optional(),
    }),
    output: z.strictObject({ items: z.array(Message), next: Cursor }),
  }),
  message: define('message', {
    summary:
      'Sends an agent a message, delivered as soon as it is idle and nothing holds it, with a ' +
      'first line saying who it is from. Its reply comes back to you as a message. Returns at ' +
      'once, with the message’s id. Yours is at most 16 KB of text: only the user’s own ' +
      'messages are longer, or carry images.',
    input: z
      .strictObject({
        canvas,
        to: AgentId,
        body: ManualBody,
        images: Images.optional(),
        replyTo: MessageId.optional(),
      })
      .refine(
        ({ body, images }) => body.trim() !== '' || (images?.length ?? 0) > 0,
        'A message has text, or images',
      ),
    output: z.strictObject({ id: z.uuid() }),
  }),
  wait: define('wait', {
    summary:
      'Returns the messages addressed to you on your canvases (replies, corrallm’s notices) after ' +
      '`after`, oldest first, or waits up to timeoutSeconds for the next. Without `after`, it ' +
      'starts where your last wait without `for` ended; `for` keeps those about one message. ' +
      'A wait with `for` never moves the read position, so a later wait without `after` may ' +
      'return messages a `for` wait already returned. `next` is where to read on. Keep waits ' +
      'under 2 minutes here; for longer, run `corrallm wait` in a background command.',
    input: z.strictObject({
      after: Cursor.optional(),
      for: MessageId.optional(),
      timeoutSeconds: z.int().min(0).max(MAX_WAIT_SECONDS),
    }),
    output: z.strictObject({ messages: z.array(Message), next: Cursor }),
  }),
  reply: define('reply', {
    summary:
      'Answers something waiting for an answer (an item `needs` lists, by its id) with one of ' +
      'its choices. So far that is a proposal (a token’s delete, waiting for the user) or the ' +
      'review of a canvas file changed on disk, which only the user answers. A proposal: Allow ' +
      'applies it as the user, unless what it touched changed since (then it is settled stale and ' +
      'nothing changes), and Refuse changes nothing; its proposer gets a record either way, whose ' +
      'id this returns. A review: Apply makes the file’s canvas the user’s change, unless the ' +
      'file changed again since (then it is superseded by a review of what is there now, which ' +
      'this names as `raised`), and Keep keeps the canvas as corrallm has it, for its next save ' +
      'to write over the file. A stalled session offers Interrupt or Interrupt and resend: only the user ' +
      'chooses them, and a resend starts a new attempt only after that turn ends cancelled. A ' +
      'worktree’s setup card (only the user’s) offers Run, Always, Skip, Stop or Run again: Run ' +
      'returns once it has started, not when it is done. A workspace change (only the user’s) ' +
      'offers Switch, which moves its agents to the worktree it names, keeping the ones they ' +
      'leave. Returns how it was settled.',
    input: z.strictObject({
      canvas,
      to: NeedId,
      answer: z.strictObject({ choice: z.string().min(1).max(64) }),
    }),
    output: z.strictObject({
      id: z.uuid().optional(),
      canvas: z
        .uuid()
        .optional()
        .meta({ description: 'The calling window’s replacement canvas, when Allow moved it.' }),
      outcome: z
        .enum([
          'allowed',
          'refused',
          'stale',
          'applied',
          'kept',
          'superseded',
          'started',
          'skipped',
          'stopped',
          'completed',
        ])
        .optional(),
      raised: NeedId.optional(),
    }),
  }),
  withdraw: define('withdraw', {
    summary:
      'Takes back a message you sent: off its agent’s queue if it is still waiting, or ' +
      'interrupting its turn if that is going on. Returns once that is asked for, without ' +
      'waiting for the turn to end: whether it reached the agent, and so whether its turn is ' +
      'being interrupted; the message is withdrawn once its turn ends. Work already done ' +
      'stays, and the agent’s history keeps the message; the agent is told of the withdrawal ' +
      'with its next message. The message says which canvas it is on, so `canvas` may be ' +
      'left out.',
    input: z.strictObject({ canvas, id: MessageId }),
    output: z.strictObject({ reached: z.boolean(), interrupted: z.boolean() }),
  }),
} satisfies Partial<Record<OpName, OpDef>>;

const AnswerText = z.string().max(MAX_ANSWER_LENGTH);
const FieldName = z.string().min(1).max(MAX_ID_LENGTH);
const FormValue = z.union([
  AnswerText,
  z.number(),
  z.boolean(),
  z.array(AnswerText).max(MAX_FORM_FIELDS),
]);
const FormValues = z
  .record(FieldName, FormValue)
  .refine((values) => Object.keys(values).length <= MAX_FORM_FIELDS, 'Too many form fields')
  .meta({ maxProperties: MAX_FORM_FIELDS });
const QuestionAnswers = z
  .record(FieldName, z.union([AnswerText, z.array(AnswerText).max(MAX_FORM_FIELDS)]))
  .refine(
    (answers) => Object.keys(answers).length > 0 && Object.keys(answers).length <= MAX_QUESTIONS,
    'Answer the bounded set of questions',
  )
  .meta({ minProperties: 1, maxProperties: MAX_QUESTIONS });
const PermissionAnswer = z
  .strictObject({ permission: z.enum(['once', 'always', 'deny']), feedback: AnswerText.optional() })
  .refine(
    (answer) => answer.feedback === undefined || answer.permission === 'deny',
    'Feedback accompanies a denial',
  );
/** Strict disjoint answer forms; C7 checks that a live Need offers the particular answer. */
export const ReplyAnswer = z
  .union([
    z
      .strictObject({
        choice: z.string().min(1).max(64),
        text: B11Body.optional(),
        images: Images.optional(),
      })
      .refine(
        (answer) => answer.images === undefined || answer.text !== undefined,
        'Images accompany typed text',
      ),
    z.strictObject({ text: B11Body, images: Images.optional() }),
    z.strictObject({ answers: QuestionAnswers }),
    PermissionAnswer,
    z.strictObject({
      plan: z.union([
        z.strictObject({ approve: z.literal(true), mode: z.enum(PLAN_MODES) }),
        z.strictObject({ approve: z.literal(false), feedback: AnswerText }),
      ]),
    }),
    z.strictObject({
      form: z.strictObject({ action: z.enum(ELICITATION_ACTIONS), values: FormValues.optional() }),
    }),
  ])
  .refine(
    (answer) => new TextEncoder().encode(JSON.stringify(answer)).length <= MAX_REPLY_ANSWER_BYTES,
    'The answer exceeds the request byte budget',
  )
  .meta({ maxBytes: MAX_REPLY_ANSWER_BYTES });

/** B11's typed reply (registered as `reply`). */
export const b11ConversationOps = {
  reply: define(
    { kind: 'command' },
    {
      summary: 'Answers the current run hold or native prompt with a bounded typed answer.',
      input: z.strictObject({ canvas, to: NeedId, answer: ReplyAnswer }),
      output: z.strictObject({
        id: z.uuid().optional(),
        canvas: z.uuid().optional(),
        outcome: z
          .enum([
            'allowed',
            'refused',
            'stale',
            'applied',
            'kept',
            'superseded',
            'answered',
            'started',
            'skipped',
            'stopped',
            'completed',
            'retained',
          ])
          .optional(),
        raised: NeedId.optional(),
      }),
    },
  ),
};
