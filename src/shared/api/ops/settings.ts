import { z } from 'zod';

import { ID_PATTERN } from '../../adapter';
import { define } from '../define';
import type { OpDef } from '../define';
import { MAX_LINK_LENGTH, MAX_REMEMBERED_SITES } from '../limits';
import type { OpName } from '../surface';

const Port = z.int().min(1).max(65_535);

/**
 * corrallm's MCP server (B11 Design §16.6): the port it keeps, and whether it listens there now
 * (at `url`, on 127.0.0.1), can't (the port taken, said in `sentence`, never a dialog), or is
 * stopped (before it starts, or once it has closed).
 */
export const ApiStatus = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('listening'), port: Port, url: z.string().max(64) }),
  z.strictObject({
    state: z.literal('unavailable'),
    port: Port.nullable(),
    sentence: z.string().min(1).max(1000),
  }),
  z.strictObject({ state: z.literal('stopped'), port: Port.nullable() }),
]);
export type ApiStatus = z.infer<typeof ApiStatus>;

/** A catalog id: an adapter's, as ID_PATTERN shapes it (never a leading dash), at most 32. */
const CatalogId = z.string().min(1).max(32).regex(ID_PATTERN);

/**
 * A site, by its origin (`scheme://host[:port]`), at most MAX_LINK_LENGTH: a comparison key, never
 * a URL to open. The core takes one only exactly as it keeps it (canonical: url-policy.ts).
 */
const Origin = z.string().min(1).max(MAX_LINK_LENGTH);

/** How the last OS notification went (B14 C9), without values. */
export const NotificationDelivery = z.enum(['shown', 'failed', 'unsupported', 'suppressed']);

/**
 * Yours alone (B14 C11, B22a C2): whether OS notifications are on, and how the last one corrallm
 * tried went since it started (null: none yet). An attempt's outcome, never a permission state.
 */
const NotificationsView = z.strictObject({
  enabled: z.boolean(),
  lastDelivery: NotificationDelivery.nullable(),
});

/**
 * Yours alone (B22a C2, C5): the sites you said to open without asking, oldest first, and the
 * product's own (fixed, not yours to take back); or, when they can't be read, a fixed sentence.
 */
export const LinksView = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('ready'),
    sites: z.array(Origin).max(MAX_REMEMBERED_SITES),
    builtIn: z.array(Origin).max(MAX_REMEMBERED_SITES),
  }),
  z.strictObject({ state: z.literal('unavailable'), sentence: z.string().min(1).max(1000) }),
]);
export type LinksView = z.infer<typeof LinksView>;

/**
 * What a call takes back (B22a C1): one adapter's consent, by the key it is kept by, or one site
 * remembered to open without asking. Never a grant: only your answer to the prompt grants.
 */
export const ConsentTarget = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('adapter'), adapter: CatalogId, key: CatalogId }),
  z.strictObject({ kind: z.literal('site'), origin: Origin }),
]);
export type ConsentTarget = z.infer<typeof ConsentTarget>;

/** settings.set's intents: exactly one per call (B22a C1). */
const INTENTS = ['defaultAdapter', 'notifications', 'consent'] as const;

/** The app's settings (Core Server §4 A). */
export const settingsOps = {
  'settings.get': define('settings.get', {
    summary:
      'The agent corrallm adds when the user adds one (null: it asks each time; an id this build lacks counts as none), the consents the user has given for good, by adapter and key, and whether corrallm’s MCP server listens, and where.',
    input: z.strictObject({}),
    // `notifications` and `links` are yours alone (`varies`): absent from every token's read.
    output: z.strictObject({
      defaultAdapter: CatalogId.nullable(),
      consents: z.record(
        z.string().regex(ID_PATTERN),
        z.record(z.string().regex(ID_PATTERN), z.literal(true)),
      ),
      api: ApiStatus,
      notifications: NotificationsView.optional(),
      links: LinksView.optional(),
    }),
  }),
  // B12 C2, B22a C1: yours alone (the consent deviation, Core Server D8). One intent a call, each
  // written first, then published; a write that fails changes nothing.
  'settings.set': define('settings.set', {
    summary:
      'Sets one app setting: the agent corrallm adds when you add one (or null to be asked each time), whether OS notifications are on, or takes back one consent or one site remembered to open without asking. Yours alone.',
    input: z
      .strictObject({
        defaultAdapter: CatalogId.nullable().optional(),
        notifications: z.strictObject({ enabled: z.boolean() }).optional(),
        consent: ConsentTarget.optional(),
      })
      .refine(
        (args) => INTENTS.filter((intent) => args[intent] !== undefined).length === 1,
        'Name exactly one setting: defaultAdapter, notifications or consent.',
      ),
    output: z.strictObject({
      defaultAdapter: CatalogId.nullable().optional(),
      notifications: z.strictObject({ enabled: z.boolean() }).optional(),
      consent: z.strictObject({ target: ConsentTarget, changed: z.boolean() }).optional(),
    }),
  }),
} satisfies Partial<Record<OpName, OpDef>>;
