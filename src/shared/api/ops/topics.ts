import { z } from 'zod';

import { TOPICS } from '../topics';
import { define } from '../define';
import type { OpDef } from '../define';
import type { OpName } from '../surface';
import { settingsOps } from './settings';
import { usageOps } from './usage';

/** A window's subscriptions (Core Server §4 M, §5.2; transport deviation D5). */
export const topicsOps = {
  'topics.subscribe': define('topics.subscribe', {
    summary:
      'Subscribes this window to a topic, returning its current state and revision in the core’s epoch.',
    input: z.strictObject({ topic: z.enum(TOPICS) }),
    output: z.strictObject({
      epoch: z.uuid(),
      rev: z.int().min(0),
      state: z.union([usageOps['usage.get'].output, settingsOps['settings.get'].output]),
    }),
  }),
  'topics.unsubscribe': define('topics.unsubscribe', {
    summary: 'Stops this window receiving changes to a topic.',
    input: z.strictObject({ topic: z.enum(TOPICS) }),
    output: z.strictObject({}),
  }),
} satisfies Partial<Record<OpName, OpDef>>;
