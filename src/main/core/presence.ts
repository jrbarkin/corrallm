import { z } from 'zod';

import {
  MAX_PAUSE_SENTENCE_BYTES,
  MAX_PAUSE_UNSAVED,
  MAX_PRESENCE_COUNT,
} from '../../shared/api/limits';

export { MAX_PAUSE_UNSAVED, MAX_PRESENCE_COUNT };

/** Private host protocol bounds (B14 §9); no operation or token reads these snapshots. */
export const MAX_NOTIFICATION_TITLE_BYTES = 32;
export const MAX_NOTIFICATION_BODY_BYTES = 160;
const count = z.int().min(0).max(MAX_PRESENCE_COUNT);
const bytes = (max: number) =>
  z
    .string()
    .max(max)
    .refine((text) => Buffer.byteLength(text, 'utf8') <= max);

/** A whole snapshot, versioned within one core process. Producers cap counts before sending. */
export const Presence = z
  .strictObject({
    revision: z.int().nonnegative(),
    working: count,
    runs: count,
    jobs: count,
    needs: count,
    busy: z.boolean(),
    awake: z.boolean(),
  })
  .refine((p) => p.busy === p.working + p.runs + p.jobs > 0);
export type Presence = z.infer<typeof Presence>;

/** Only presentation text and an opaque click handle cross to the native notification host. */
export const NotificationRequest = z.strictObject({
  handle: z.uuid(),
  title: bytes(MAX_NOTIFICATION_TITLE_BYTES),
  body: bytes(MAX_NOTIFICATION_BODY_BYTES),
});
export type NotificationRequest = z.infer<typeof NotificationRequest>;
export const NotificationResult = z.enum(['shown', 'failed', 'unsupported', 'suppressed']);
export type NotificationResult = z.infer<typeof NotificationResult>;

export const ShutdownOptions = z.strictObject({ ifIdle: z.literal(true).optional() });
export type ShutdownOptions = z.infer<typeof ShutdownOptions>;

/** The native Pause all acknowledgement; C3 implements the operation behind this shape. */
export const PauseAllResult = z.strictObject({
  agents: count,
  canvases: count,
  unsaved: z
    .array(z.strictObject({ canvas: z.uuid(), sentence: bytes(MAX_PAUSE_SENTENCE_BYTES) }))
    .max(MAX_PAUSE_UNSAVED),
});
export type PauseAllResult = z.infer<typeof PauseAllResult>;
