import { z } from 'zod';

import { ID_PATTERN } from '../../adapter';
import {
  IMAGE_TYPES,
  imageBytes,
  TURN_REASONS,
  MODEL_PATTERN,
  EFFORT_PATTERN,
  MAX_MESSAGE_LENGTH,
} from '../../session';
import { PARTY_PATTERN } from '../../model/messages';
import { SessionContextSchema } from '../../model/fallback';
import { USAGE_WINDOWS } from '../../usage';
import { AgentId, ItemId, MessageId } from '../ids';
import {
  MAX_IMAGE_BYTES,
  MAX_IMAGE_TOTAL,
  MAX_IMAGES,
  MAX_LABEL,
  MAX_SESSION_REPLY_BYTES,
  MAX_MESSAGE_BYTES,
  MAX_SUGGESTION_BYTES,
  MAX_TERMINAL_ASKS,
} from '../limits';

/** Shared schema vocabulary for prepared B11 definitions; no entry here registers an operation. */
export const CatalogId = z.string().min(1).max(32).regex(ID_PATTERN);
export const Model = z.string().max(MAX_LABEL).regex(MODEL_PATTERN);
export const Effort = z.string().max(40).regex(EFFORT_PATTERN);
export const Body = z
  .string()
  .min(1)
  .max(MAX_MESSAGE_BYTES)
  .refine(
    (text) => new TextEncoder().encode(text).length <= MAX_MESSAGE_BYTES,
    `At most ${String(MAX_MESSAGE_BYTES)} bytes of UTF-8`,
  );
export const Image = z.strictObject({
  mediaType: z.enum(IMAGE_TYPES),
  data: z
    .string()
    .min(4)
    .max(4 * Math.ceil(MAX_IMAGE_BYTES / 3))
    .refine(
      (data) =>
        data.length % 4 === 0 &&
        /^[A-Za-z0-9+/]+={0,2}$/.test(data) &&
        imageBytes(data) <= MAX_IMAGE_BYTES,
      'A bounded base64 image',
    ),
});
export const Images = z
  .array(Image)
  .max(MAX_IMAGES)
  .refine(
    (images) =>
      images.reduce((bytes, image) => bytes + imageBytes(image.data), 0) <= MAX_IMAGE_TOTAL,
    'The pasted images exceed their total byte limit',
  )
  // Base64 needs no JSON escaping. Allow padding and media/object keys for each bounded image.
  .meta({ maxBytes: 4 * Math.ceil(MAX_IMAGE_TOTAL / 3) + MAX_IMAGES * 100 });
/**
 * Text your composer sends: at most its 200,000 characters (MAX_MESSAGE_LENGTH, B11 §16.6). What
 * anyone else sends is held to MAX_MESSAGE_BYTES by its op's `human-text` rule, never by cutting.
 */
export const ManualBody = z.string().max(MAX_MESSAGE_LENGTH);
/** Human-only Continue uses the composer's character bound (B11 §16.6). */
export const ManualText = z.strictObject({
  text: ManualBody.min(1),
  images: Images.optional(),
});
const Party = z.string().regex(PARTY_PATTERN);
const Outcome = z.enum(['succeeded', 'failed', 'cancelled', 'skipped', 'timedOut', 'stopped']);
const Problem = z.strictObject({
  kind: z.enum(['failed', 'uncertain', 'cancelled']),
  reason: z.string(),
  text: z.string(),
  agent: AgentId,
  conditionKey: z.string().optional(),
});
export const Attempt = z.strictObject({
  id: z.string(),
  retryOf: z.string().optional(),
  messageId: MessageId.optional(),
  startedAt: z.number(),
  endedAt: z.number().optional(),
  status: z.enum(['running', 'succeeded', 'failed', 'uncertain', 'cancelled']),
  reason: z.string().optional(),
  text: z.string().optional(),
  message: z.string().optional(),
});
const AgentRun = z.strictObject({
  pauses: z.array(Party).optional(),
  paused: z.boolean().optional(),
  problem: Problem.optional(),
  attempts: z.record(ItemId, z.array(Attempt)).optional(),
  current: ItemId.optional(),
  status: z.enum(['running', 'waiting', 'asking', 'stopped', 'done']),
  refused: z
    .strictObject({
      agent: AgentId,
      connection: CatalogId,
      text: z.string(),
      switchTo: CatalogId.optional(),
      kind: z.literal('unknown-action').optional(),
    })
    .optional(),
  until: z.number().optional(),
  outcomes: z.record(ItemId, Outcome),
  asExpected: z.record(ItemId, z.boolean()).optional(),
  rounds: z.record(ItemId, z.strictObject({ round: z.int(), more: z.int().optional() })).optional(),
  changes: z.record(ItemId, z.array(z.string())).optional(),
  usage: z
    .strictObject({
      backend: CatalogId,
      window: z.enum(USAGE_WINDOWS),
      percent: z.number(),
      used: z.number(),
      resetsAt: z.number().nullable(),
    })
    .optional(),
});
export const RunViewSchema = z.strictObject({
  running: z.boolean(),
  paused: z.boolean().optional(),
  groups: z.record(AgentId, z.strictObject({ pauses: z.array(Party) })),
  agents: z.record(AgentId, AgentRun),
  notices: z.array(
    z.strictObject({
      id: z.string(),
      level: z.enum(['info', 'warning', 'error']),
      text: z.string(),
      agent: AgentId.optional(),
    }),
  ),
  saveError: z.string().optional(),
});
export const TurnResultSchema = z.strictObject({
  status: z.enum(['completed', 'failed', 'cancelled']),
  reason: z.enum(TURN_REASONS),
  message: z.string().optional(),
  resetsAt: z.number().optional(),
});
export const EffortChoice = z.strictObject({
  value: z.string(),
  label: z.string(),
  description: z.string().optional(),
});
export const ModelChoice = z.strictObject({
  value: z.string(),
  label: z.string(),
  description: z.string().optional(),
  efforts: z.array(EffortChoice).optional(),
  defaultEffort: z.string().optional(),
});
const AskDetail = z.union([
  z.strictObject({
    kind: z.literal('diff'),
    added: z.number(),
    removed: z.number(),
    lines: z.array(z.strictObject({ kind: z.enum(['add', 'remove', 'same']), text: z.string() })),
  }),
  z.strictObject({ kind: z.literal('output'), text: z.string() }),
]);
const askCut = z.literal(true).optional();
/** What a terminal asks, as a summary carries it (shared/model/views.ts' askingView). */
export const AskViewSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('permission'),
    id: z.string(),
    tool: z.string(),
    summary: z.string(),
    detail: AskDetail.optional(),
    cut: askCut,
  }),
  z.strictObject({
    kind: z.literal('question'),
    id: z.string(),
    questions: z.array(
      z.strictObject({
        header: z.string(),
        text: z.string(),
        options: z.array(z.strictObject({ label: z.string(), description: z.string() })),
        multiple: z.boolean(),
      }),
    ),
    cut: askCut,
  }),
  z.strictObject({ kind: z.literal('plan'), id: z.string(), plan: z.string(), cut: askCut }),
  z.strictObject({ kind: z.literal('trust'), id: z.string(), cut: askCut }),
  z.strictObject({ kind: z.literal('other'), id: z.string(), text: z.string(), cut: askCut }),
]);
export const SessionSummarySchema = z.strictObject({
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
  mode: z.string().nullable(),
  model: z.string().nullable(),
  effort: z.string().nullable(),
  models: z.array(
    z.strictObject({
      value: z.string(),
      label: z.string(),
      description: z.string().optional(),
      efforts: z.array(EffortChoice).optional(),
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
      context: SessionContextSchema.nullable(),
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
  reply: z
    .string()
    .max(MAX_SESSION_REPLY_BYTES)
    .refine(
      (text) => new TextEncoder().encode(text).length <= MAX_SESSION_REPLY_BYTES,
      'A summary reply is at most 4 KiB of UTF-8',
    )
    .nullable(),
  replyCut: z.literal(true).optional(),
  // Yours alone (session.get's `varies`): your composer's suggestion and your Needs' detail.
  suggestion: z
    .string()
    .min(1)
    .max(MAX_SUGGESTION_BYTES)
    .refine(
      (text) => new TextEncoder().encode(text).length <= MAX_SUGGESTION_BYTES,
      'A suggestion is at most 2 KiB of UTF-8',
    )
    .optional(),
  asking: z.array(AskViewSchema).min(1).max(MAX_TERMINAL_ASKS).optional(),
});
