import { z } from 'zod';

import { ID_PATTERN } from '../../adapter';
import { MAX_ROUNDS, MAX_SECONDS } from '../../model/queue';
import { USAGE_WINDOWS } from '../../usage';
import { define } from '../define';
import type { OpDef } from '../define';
import { AgentId, ItemId, OpCanvas } from '../ids';
import { MAX_INITIAL_QUEUE_ITEMS, MAX_LABEL, MAX_MESSAGE_BYTES, MAX_OP_NODES } from '../limits';
import type { OpName } from '../surface';

const CatalogId = z.string().min(1).max(32).regex(ID_PATTERN);
const Text = z
  .string()
  .max(MAX_MESSAGE_BYTES)
  .refine(
    (text) => new TextEncoder().encode(text).length <= MAX_MESSAGE_BYTES,
    `At most ${String(MAX_MESSAGE_BYTES)} bytes of UTF-8`,
  )
  .meta({ contentMediaType: 'text/plain' });
const Action = z.string().min(1).max(MAX_LABEL);
const TextConditions = [
  z.strictObject({ kind: z.literal('succeeded') }),
  z.strictObject({ kind: z.literal('failed') }),
  z.strictObject({
    kind: z.literal('outputContains'),
    text: Text,
    wholeLine: z.boolean().optional(),
  }),
  z.strictObject({ kind: z.literal('freeText'), text: Text }),
] as const;
const Condition = z.discriminatedUnion('kind', [
  ...TextConditions,
  z.strictObject({ kind: z.literal('timedOut') }),
  z.strictObject({
    kind: z.literal('usageAbove'),
    backend: CatalogId,
    window: z.enum(USAGE_WINDOWS),
    percent: z.int().min(1).max(99),
  }),
]);
const Until = z.discriminatedUnion('kind', [
  ...TextConditions,
  z.strictObject({ kind: z.literal('repeatEnds'), agent: AgentId, item: ItemId }),
]);
const Time = z.union([
  z.strictObject({ seconds: z.int().min(1).max(MAX_SECONDS) }),
  z.strictObject({
    at: z
      .string()
      .max(5)
      .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  }),
  z.strictObject({ resets: z.enum(USAGE_WINDOWS), backend: CatalogId }),
]);
const Targets = z
  .array(z.strictObject({ agent: AgentId, item: ItemId.optional() }))
  .min(1)
  .max(MAX_OP_NODES);
const Step = z.strictObject({
  action: Action,
  target: AgentId.optional(),
  instruction: Text.optional(),
  expect: z.literal('fails').optional(),
});
const Message = z.strictObject({ message: Text, target: AgentId.optional() });
const Wait = z.strictObject({ waitFor: Targets, timeout: Time.optional() });
const Delay = z.strictObject({ delay: Time });
const Rounds = z.int().min(1).max(MAX_ROUNDS);
const Otherwise = z.enum(['ask', 'goOn']);

// A full MAX_OP_NODES × MAX_OP_NODES tree would exceed the request bound. Grow larger
// containers with queue.add {into}; each initial container stays within T1's worst-case bound.
const Entry = z.union([
  Step,
  Message,
  Wait,
  Delay,
  z.strictObject({ approve: Text }),
  z.strictObject({
    if: Condition,
    then: z.array(z.union([Step, Message])).max(MAX_INITIAL_QUEUE_ITEMS),
  }),
  z.strictObject({
    repeat: z.array(z.union([Step, Message, Wait, Delay])).max(MAX_INITIAL_QUEUE_ITEMS),
    until: Until,
    rounds: Rounds,
    otherwise: Otherwise,
  }),
]);
const Change = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('message'), message: Text }),
  z.strictObject({ kind: z.literal('action'), action: Action }),
  z.strictObject({ kind: z.literal('instruction'), instruction: Text.nullable() }),
  z.strictObject({ kind: z.literal('expect'), expect: z.literal('fails').nullable() }),
  z.strictObject({ kind: z.literal('target'), target: AgentId.nullable() }),
  z.strictObject({ kind: z.literal('condition'), condition: Condition }),
  z.strictObject({ kind: z.literal('waitFor'), waitFor: Targets }),
  z.strictObject({ kind: z.literal('time'), time: Time.nullable() }),
  z.strictObject({ kind: z.literal('approve'), approve: Text }),
  z.strictObject({
    kind: z.literal('repeat'),
    until: Until.optional(),
    rounds: Rounds.optional(),
    otherwise: Otherwise.optional(),
  }),
]);

export const queueOps = {
  'queue.add': define('queue.add', {
    summary:
      'Adds an authored queue item, optionally into an If or repeat, and returns its new id. Initial containers hold at most 16 children; add further children with into.',
    input: z.strictObject({
      canvas: OpCanvas,
      agent: AgentId,
      entry: Entry,
      into: ItemId.optional(),
    }),
    output: z.strictObject({ id: ItemId }),
  }),
  'queue.remove': define('queue.remove', {
    summary: 'Removes an existing queue item, including one inside an If or repeat.',
    input: z.strictObject({ canvas: OpCanvas, agent: AgentId, item: ItemId }),
    output: z.strictObject({}),
  }),
  'queue.move': define('queue.move', {
    summary:
      'Moves within the item’s own list. Name exactly one before or after neighbour; null puts it at the end.',
    input: z.strictObject({
      canvas: OpCanvas,
      agent: AgentId,
      item: ItemId,
      before: ItemId.nullable().optional(),
      after: ItemId.nullable().optional(),
    }),
    output: z.strictObject({}),
  }),
  'queue.update': define('queue.update', {
    summary: 'Changes one queue field, recording the caller as author when its text changes.',
    input: z.strictObject({ canvas: OpCanvas, agent: AgentId, item: ItemId, change: Change }),
    output: z.strictObject({}),
  }),
} satisfies Partial<Record<OpName, OpDef>>;
