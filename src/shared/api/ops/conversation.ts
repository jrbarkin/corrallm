import { z } from 'zod';

import { MESSAGE_KINDS, MESSAGE_STATES, PARTY_PATTERN } from '../../model/messages';
import { NEED_KINDS } from '../../model/needs';
import { TURN_REASONS } from '../../session';
import { define } from '../define';
import type { OpDef } from '../define';
import { AgentId, CanvasId, MessageId } from '../ids';
import { MAX_MESSAGE_BYTES, MAX_PAGE } from '../limits';
import type { OpName } from '../surface';

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
  task: z.strictObject({ agent: z.string(), item: z.string(), attempt: z.string() }).optional(),
  turn: TurnResult.optional(),
  state: z.enum(MESSAGE_STATES),
  delivery: z.strictObject({ at: z.number(), as: z.string(), attempt: z.int() }).optional(),
  by: Party.optional(),
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
  choices: z.array(
    z.strictObject({
      value: z.string(),
      label: z.string(),
      description: z.string().optional(),
      humanOnly: z.string().optional(),
    }),
  ),
  text: z.strictObject({ placeholder: z.string() }).optional(),
  questions: z
    .array(
      z.strictObject({
        id: z.string(),
        header: z.string(),
        text: z.string(),
        options: z.array(z.strictObject({ label: z.string(), description: z.string().optional() })),
        multiple: z.boolean(),
        other: z.boolean(),
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
});

/** How an agent is now: waiting for you, working, paused (its queue held), or idle. */
export const AGENT_STATES = ['waiting', 'working', 'paused', 'idle'] as const;

/** The canvas: left out by a caller with exactly one (an agent's own, a token's only one). */
const canvas = CanvasId.optional();

/** At most MAX_MESSAGE_BYTES of UTF-8. */
const Body = z
  .string()
  .min(1)
  .max(MAX_MESSAGE_BYTES)
  .refine((body) => new TextEncoder().encode(body).length <= MAX_MESSAGE_BYTES, {
    message: `Too long: a message is at most ${String(MAX_MESSAGE_BYTES / 1024)} KB.`,
  });

export const conversationOps = {
  agents: define('agents', {
    summary:
      'The agents you reach on the canvas: each one’s id, name, adapter and connection, how it is ' +
      'now, how many prompts of its own wait for an answer, and the agents it is linked to.',
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
      'once, with the message’s id.',
    input: z.strictObject({ canvas, to: AgentId, body: Body, replyTo: MessageId.optional() }),
    output: z.strictObject({ id: z.uuid() }),
  }),
  withdraw: define('withdraw', {
    summary:
      'Takes back a message you sent: off its agent’s queue if it is still waiting, or ' +
      'interrupting its turn if that is going on. The message says which canvas it is on, so ' +
      '`canvas` may be left out.',
    input: z.strictObject({ canvas, id: MessageId }),
    output: z.strictObject({}),
  }),
} satisfies Partial<Record<OpName, OpDef>>;
