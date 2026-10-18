import { z } from 'zod';

import { ID_PATTERN } from '../../adapter';
import { USAGE_ACTIONS, USAGE_WINDOWS } from '../../usage';
import { define } from '../define';
import type { OpDef } from '../define';
import type { OpName } from '../surface';

/** Usage readings and rules (Core Server §4 I; src/shared/usage.ts). */

/** A usage backend, as the catalog names it (src/shared/adapter.ts): adapters declare them. */
const UsageBackendId = z.string().regex(ID_PATTERN);

const WindowUsage = z.strictObject({
  usedPercent: z.number().min(0).max(100),
  resetsAt: z.number().nullable(),
});

const UsageReading = z.strictObject({
  backend: UsageBackendId,
  windows: z.partialRecord(z.enum(USAGE_WINDOWS), WindowUsage),
  at: z.number(),
  simulated: z.literal(true).optional(),
});

const UsageRule = z.strictObject({
  window: z.enum(USAGE_WINDOWS),
  percent: z.int().min(1).max(99),
  action: z.enum(USAGE_ACTIONS),
});

export const usageOps = {
  'usage.get': define('usage.get', {
    summary:
      "Each backend's latest usage reading (how much of its 5-hour and weekly windows is used, " +
      'and when each resets) and the usage rule it has, if any.',
    input: z.strictObject({}),
    output: z.strictObject({
      readings: z.array(UsageReading),
      rules: z.partialRecord(UsageBackendId, UsageRule),
    }),
  }),
} satisfies Partial<Record<OpName, OpDef>>;
