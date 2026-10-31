import { z } from 'zod';

import { ID_PATTERN } from '../adapter';
import { MAX_HANDOFF_BYTES } from '../api/limits';
import { MODEL_PATTERN } from '../session';
import { MAX_NODE_ID } from './canvas';

/*
 * An agent's handoff (B11a Design §12 C7, C10, C11): the exact text the agent replied when corrallm
 * asked it to write one, kept as its latest, with when, which CLI wrote it, the task it was on and
 * how long it is. Its text is as visible as the agent's transcript (session.handoff); views carry
 * when, how long and its state, never its text.
 */

/** Which CLI wrote a handoff: the agent's adapter, connection and model as its session reported. */
export const HandoffSourceSchema = z.strictObject({
  adapter: z.string().max(32).regex(ID_PATTERN),
  connection: z.string().max(32).regex(ID_PATTERN),
  model: z.string().max(200).regex(MODEL_PATTERN).optional(),
});
export type HandoffSource = z.infer<typeof HandoffSourceSchema>;

/** The run's task the agent was on as its context crossed its ask point: its owner and item. */
export const HandoffTaskSchema = z.strictObject({
  owner: z.string().min(1).max(MAX_NODE_ID),
  item: z.string().min(1).max(MAX_NODE_ID),
});
export type HandoffTask = z.infer<typeof HandoffTaskSchema>;

/** A handoff kept: its text exactly as accepted, at most MAX_HANDOFF_BYTES of UTF-8. */
export const HandoffSchema = z
  .strictObject({
    text: z.string().min(1),
    at: z.int().nonnegative(),
    source: HandoffSourceSchema,
    during: HandoffTaskSchema.optional(),
    bytes: z.int().min(1).max(MAX_HANDOFF_BYTES),
  })
  .refine(
    ({ text, bytes }) => new TextEncoder().encode(text).length === bytes,
    'A handoff’s size is its text’s, in bytes of UTF-8',
  );
export type Handoff = z.infer<typeof HandoffSchema>;

/**
 * The handoff's state as views show it (C11): `kept`, a handoff kept and nothing going on; `asking`,
 * corrallm's request waits or runs; `failed`, its requests this crossing weren't accepted (until
 * the agent re-arms); `unreported`, its connection or session reports no context, so it is never
 * asked; `off`, you turned it off.
 */
export const HANDOFF_STATES = ['kept', 'asking', 'failed', 'unreported', 'off'] as const;
export type HandoffState = (typeof HANDOFF_STATES)[number];

/**
 * An agent's handoff as views show it (C11): when its latest was kept and how long it is (null
 * while none is), and its state. No text, native id or path.
 */
export const HandoffViewSchema = z.strictObject({
  at: z.int().nonnegative().nullable(),
  bytes: z.int().min(1).max(MAX_HANDOFF_BYTES).nullable(),
  state: z.enum(HANDOFF_STATES),
});
export type HandoffView = z.infer<typeof HandoffViewSchema>;
