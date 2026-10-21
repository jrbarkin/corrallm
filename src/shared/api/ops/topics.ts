import { z } from 'zod';

import { TOPICS } from '../topics';
import { define } from '../define';
import type { OpDef } from '../define';
import { OpCanvas } from '../ids';
import type { OpName } from '../surface';
import { canvasOps } from './canvas';
import { conversationOps } from './conversation';
import { settingsOps } from './settings';
import { usageOps } from './usage';

/**
 * A topic: a global one by its name, or a canvas's (`canvas`, `needs`) by its name and the canvas,
 * which a caller with one canvas open may leave out, as for any op (core.call fills it in). A global
 * topic ignores a canvas; a canvas's with none is refused where it is subscribed.
 */
const Topic = z.strictObject({ topic: z.enum(TOPICS), canvas: OpCanvas });

/** A window's subscriptions (Core Server §4 M, §5.2; transport deviation D5). */
export const topicsOps = {
  'topics.subscribe': define('topics.subscribe', {
    summary:
      'Subscribes this window to a topic, returning its current state and revision in the core’s epoch.',
    input: Topic,
    output: z.strictObject({
      epoch: z.uuid(),
      rev: z.int().min(0),
      state: z.union([
        usageOps['usage.get'].output,
        settingsOps['settings.get'].output,
        canvasOps['canvas.list'].output,
        conversationOps.needs.output,
        // A canvas's entities, by key.
        z.record(z.string(), z.looseObject({ rev: z.int().min(0), by: z.string() })),
      ]),
    }),
  }),
  'topics.unsubscribe': define('topics.unsubscribe', {
    summary: 'Stops this window receiving changes to a topic.',
    input: Topic,
    output: z.strictObject({}),
  }),
} satisfies Partial<Record<OpName, OpDef>>;
