import { z } from 'zod';

import { USAGE_ACTIONS, USAGE_BACKENDS, USAGE_WINDOWS } from '../../usage';
import { define } from '../define';
import type { OpDef } from '../define';
import type { OpName } from '../surface';

/** Usage readings and rules (Core Server §4 I; src/shared/usage.ts). */

const WindowUsage = z.strictObject({
  usedPercent: z.number().min(0).max(100),
  resetsAt: z.number().nullable(),
});

const UsageReading = z.strictObject({
  backend: z.enum(USAGE_BACKENDS),
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
      rules: z.partialRecord(z.enum(USAGE_BACKENDS), UsageRule),
    }),
  }),
} satisfies Partial<Record<OpName, OpDef>>;
