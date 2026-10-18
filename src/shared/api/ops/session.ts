import { z } from 'zod';

import { ELICITATION_ACTIONS } from '../../session';
import { define } from '../define';
import type { OpDef } from '../define';
import { AgentId, OpCanvas } from '../ids';
import { MAX_PAGE } from '../limits';
import type { OpName } from '../surface';
import { TurnResult } from './conversation';

/** Sessions (Core Server §4 G): an agent's session as it is, its transcript, and interrupting it. */

const canvas = OpCanvas;

const ToolDetail = z.union([
  z.strictObject({
    kind: z.literal('diff'),
    added: z.number(),
    removed: z.number(),
    lines: z.array(z.strictObject({ kind: z.enum(['add', 'remove', 'same']), text: z.string() })),
  }),
  z.strictObject({ kind: z.literal('output'), text: z.string() }),
]);

const Effort = z.strictObject({
  value: z.string(),
  label: z.string(),
  description: z.string().optional(),
});

const Question = z.strictObject({
  header: z.string(),
  text: z.string(),
  options: z.array(z.strictObject({ label: z.string(), description: z.string() })),
  multiple: z.boolean(),
  answer: z.string().optional(),
});

/** Whether an entry is withdrawn: a prompt the session stopped waiting for. */
const withdrawn = z.boolean().optional();

/**
 * Whether an entry was cut to fit its page (MAX_PAGE_BYTES): its text, plan, output or diff ends
 * early. The whole of it stays in the session.
 */
const cut = z.literal(true).optional();

/**
 * An entry of an agent's transcript, as its view shows it (src/shared/model/session.ts Entry). A
 * message's pasted images are only counted, and an entry too big for a page alone is `cut`.
 */
export const TranscriptEntry = z.discriminatedUnion('kind', [
  z.strictObject({
    id: z.string(),
    kind: z.literal('user'),
    text: z.string(),
    images: z.int().optional(),
    reached: z.literal(true).optional(),
    conversation: z.string().optional(),
  }),
  z.strictObject({
    id: z.string(),
    kind: z.literal('text'),
    text: z.string(),
    parent: z.string().optional(),
    cut,
  }),
  z.strictObject({
    id: z.string(),
    kind: z.literal('thinking'),
    text: z.string(),
    seconds: z.number(),
    parent: z.string().optional(),
    cut,
  }),
  z.strictObject({
    id: z.string(),
    kind: z.literal('tool'),
    tool: z.string(),
    summary: z.string(),
    status: z.enum(['running', 'done', 'failed', 'interrupted']),
    detail: ToolDetail.optional(),
    parent: z.string().optional(),
    progress: z
      .strictObject({
        seconds: z.number().optional(),
        doing: z.string().optional(),
        toolUses: z.number().optional(),
        tokens: z.number().optional(),
      })
      .optional(),
    cut,
  }),
  z.strictObject({
    id: z.string(),
    kind: z.literal('permission'),
    tool: z.string(),
    summary: z.string(),
    detail: ToolDetail.optional(),
    always: z.string().nullable().optional(),
    title: z.string().optional(),
    answer: z.enum(['once', 'always', 'deny']).optional(),
    feedback: z.string().optional(),
    withdrawn,
    cut,
  }),
  z.strictObject({
    id: z.string(),
    kind: z.literal('question'),
    questions: z.array(Question),
    withdrawn,
  }),
  z.strictObject({
    id: z.string(),
    kind: z.literal('plan'),
    plan: z.string(),
    answer: z
      .union([
        z.strictObject({ approve: z.literal(true), mode: z.string() }),
        z.strictObject({ approve: z.literal(false), feedback: z.string() }),
      ])
      .optional(),
    withdrawn,
    cut,
  }),
  z.strictObject({
    id: z.string(),
    kind: z.literal('todos'),
    items: z.array(
      z.strictObject({ text: z.string(), status: z.enum(['pending', 'active', 'done']) }),
    ),
  }),
  z.strictObject({
    id: z.string(),
    kind: z.literal('elicitation'),
    server: z.string(),
    message: z.string(),
    fields: z.array(z.record(z.string(), z.unknown())).optional(),
    url: z.string().optional(),
    answer: z.enum(ELICITATION_ACTIONS).optional(),
    withdrawn,
  }),
  z.strictObject({
    id: z.string(),
    kind: z.literal('notice'),
    level: z.enum(['info', 'warning', 'error']),
    text: z.string(),
    switchTo: z.string().optional(),
  }),
  z.strictObject({
    id: z.string(),
    kind: z.literal('cleared'),
    conversation: z.string().optional(),
  }),
  z.strictObject({
    id: z.string(),
    kind: z.literal('end'),
    seconds: z.number(),
    interrupted: z.boolean(),
    failed: z.boolean().optional(),
    result: TurnResult.optional(),
  }),
]);

export const sessionOps = {
  'session.get': define('session.get', {
    summary:
      'An agent’s session as it is now: whether it works, waits for the user or is idle, what ' +
      'is queued and asked, the model, mode and effort it runs, what it runs in the background, ' +
      'what it has used, and what it replied last.',
    input: z.strictObject({ canvas, agent: AgentId }),
    output: z.strictObject({
      agent: z.string(),
      connection: z.string(),
      status: z.enum(['idle', 'working', 'waiting']),
      paused: z.boolean(),
      queued: z.int(),
      prompts: z.int(),
      unheard: z.string().optional(),
      tasks: z.array(
        z.strictObject({
          id: z.string(),
          description: z.string(),
          kind: z.enum(['agent', 'command', 'other']),
          tool: z.string().optional(),
        }),
      ),
      commands: z.array(
        z.strictObject({ name: z.string(), description: z.string(), argumentHint: z.string() }),
      ),
      mode: z.string(),
      model: z.string().nullable(),
      effort: z.string().nullable(),
      models: z.array(
        z.strictObject({
          value: z.string(),
          label: z.string(),
          description: z.string().optional(),
          efforts: z.array(Effort).optional(),
          defaultEffort: z.string().optional(),
        }),
      ),
      modes: z.array(z.string()).optional(),
      running: z
        .strictObject({
          model: z.string().optional(),
          effort: z.string().optional(),
          mode: z.string().optional(),
          role: z.string().optional(),
        })
        .optional(),
      usage: z
        .strictObject({
          costUsd: z.number().nullable(),
          contextTokens: z.number().nullable(),
          contextWindow: z.number().nullable(),
          limits: z
            .array(
              z.strictObject({
                name: z.string(),
                usedPercent: z.number(),
                resetsAt: z.number().nullable(),
              }),
            )
            .optional(),
        })
        .optional(),
      reply: z.string().nullable(),
    }),
  }),
  'session.transcript': define('session.transcript', {
    summary:
      'An agent’s transcript, a page at a time, oldest first: pass the `next` a call returned as ' +
      '`after` to read on. A page ends early rather than grow too big for one result, and an ' +
      'entry too big alone comes cut, marked `cut`.',
    input: z.strictObject({
      canvas,
      agent: AgentId,
      after: z.string().min(1).max(512).optional(),
      limit: z.int().min(1).max(MAX_PAGE).optional(),
    }),
    output: z.strictObject({
      entries: z.array(TranscriptEntry),
      next: z.string().nullable(),
    }),
  }),
  'session.interrupt': define('session.interrupt', {
    summary:
      'Interrupts the turn an agent’s session is on, as Escape does in its CLI; what it asks ' +
      'the user then is withdrawn.',
    input: z.strictObject({ canvas, agent: AgentId }),
    output: z.strictObject({}),
  }),
} satisfies Partial<Record<OpName, OpDef>>;
