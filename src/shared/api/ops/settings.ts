import { z } from 'zod';

import { ID_PATTERN } from '../../adapter';
import { define } from '../define';
import type { OpDef } from '../define';
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

/** The app's settings (Core Server §4 A). */
export const settingsOps = {
  'settings.get': define('settings.get', {
    summary:
      'The agent corrallm adds when the user adds one (null: it asks each time; an id this build lacks counts as none), the consents the user has given for good, by adapter and key, and whether corrallm’s MCP server listens, and where.',
    input: z.strictObject({}),
    output: z.strictObject({
      defaultAdapter: CatalogId.nullable(),
      consents: z.record(
        z.string().regex(ID_PATTERN),
        z.record(z.string().regex(ID_PATTERN), z.literal(true)),
      ),
      api: ApiStatus,
    }),
  }),
  // B12 C2: yours alone (the consent deviation, Core Server D8). It writes first, then publishes;
  // a write that fails changes nothing.
  'settings.set': define('settings.set', {
    summary:
      'Sets the agent corrallm adds when you add one, or null to be asked each time. Yours alone.',
    input: z.strictObject({ defaultAdapter: CatalogId.nullable() }),
    output: z.strictObject({ defaultAdapter: CatalogId.nullable() }),
  }),
} satisfies Partial<Record<OpName, OpDef>>;
