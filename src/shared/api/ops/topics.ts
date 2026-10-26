import { z } from 'zod';
import { TOPICS, RUNTIME_TOPICS } from '../topics';
import { define } from '../define';
import type { OpDef } from '../define';
import { AgentId, OpCanvas } from '../ids';
import { MAX_TOPIC_FRAME } from '../limits';
import { MAX_NODE_ID } from '../../model/canvas';
import { MESSAGE_ORIGINS } from '../../model/messages';
import type { OpName } from '../surface';
import { canvasOps } from './canvas';
import { conversationOps, Message } from './conversation';
import { b9aWorktreeOps } from './project';
import { settingsOps } from './settings';
import { usageOps } from './usage';
import { RunViewSchema, SessionSummarySchema } from './b11-data';
import { TranscriptEntry } from './session';

/** A strict structured request; a canvas may be filled from the caller's sole canvas. */
const Topic = z
  .strictObject({
    topic: z.enum([...TOPICS, ...RUNTIME_TOPICS]),
    canvas: OpCanvas,
    agent: AgentId.optional(),
  })
  .refine(
    (value) =>
      value.topic === 'session' ? value.agent?.isWellFormed() === true : value.agent === undefined,
    'Only a session topic names an agent, using well-formed Unicode',
  );
const State = z.union([
  usageOps['usage.get'].output,
  settingsOps['settings.get'].output,
  canvasOps['canvas.list'].output,
  conversationOps.needs.output,
  b9aWorktreeOps['worktree.list'].output,
  z.record(z.string(), z.looseObject({ rev: z.int().min(0), by: z.string() })),
  RunViewSchema,
  z.strictObject({ agents: z.record(AgentId, SessionSummarySchema) }),
  z.strictObject({
    summary: SessionSummarySchema,
    entries: z.record(z.string(), TranscriptEntry),
    order: z.array(z.string()),
  }),
  z.strictObject({
    items: z.record(
      z.string(),
      Message.extend({
        origin: z.enum(MESSAGE_ORIGINS),
        display: z
          .strictObject({
            after: z.string().optional(),
            text: z.string().optional(),
            images: z.int().min(0).optional(),
            requiresImages: z.literal(true).optional(),
          })
          .optional(),
      }),
    ),
    order: z.array(z.string()),
    next: z.string(),
  }),
]);
/** One object envelope, refined into whole snapshot or begin; write envelopes retain this check. */
const Snapshot = z
  .strictObject({
    epoch: z.uuid(),
    rev: z.int().min(0).optional(),
    state: State.optional(),
    kind: z.literal('begin').optional(),
    topic: z
      .string()
      .max(MAX_NODE_ID * 9 + 100)
      .optional(),
    snapshot: z.uuid().optional(),
    summary: z.unknown().optional(),
    count: z.int().min(0).optional(),
  })
  .refine(
    (value) =>
      value.kind === 'begin'
        ? value.topic !== undefined &&
          value.snapshot !== undefined &&
          value.count !== undefined &&
          Object.hasOwn(value, 'summary') &&
          value.rev === undefined &&
          value.state === undefined
        : value.rev !== undefined &&
          value.state !== undefined &&
          value.topic === undefined &&
          value.snapshot === undefined &&
          value.count === undefined &&
          !Object.hasOwn(value, 'summary'),
    'A subscription answers one complete snapshot or one begin frame',
  )
  .refine(
    (value) => new TextEncoder().encode(JSON.stringify(value)).length <= MAX_TOPIC_FRAME - 4096,
    'An oversized snapshot must use a bounded begin frame',
  );

export const topicsOps = {
  'topics.subscribe': define('topics.subscribe', {
    summary:
      'Subscribes this window to a topic, returning its current snapshot or the begin of a chunked transfer.',
    input: Topic,
    output: Snapshot,
  }),
  'topics.unsubscribe': define('topics.unsubscribe', {
    summary: 'Stops this window receiving changes to a topic.',
    input: Topic,
    output: z.strictObject({}),
  }),
} satisfies Partial<Record<OpName, OpDef>>;
