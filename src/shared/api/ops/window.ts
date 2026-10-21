import { z } from 'zod';

import { define } from '../define';
import type { OpDef } from '../define';
import { CanvasId } from '../ids';
import type { OpName } from '../surface';

/** Which canvas a window shows (Core Server §4 M, D4). */
export const windowOps = {
  'window.get': define('window.get', {
    summary: 'The canvas shown in the calling window, restored when it first asks.',
    input: z.strictObject({}),
    output: z.strictObject({ canvas: z.uuid() }),
  }),
  'window.show': define('window.show', {
    summary: 'Shows a kept canvas in the calling window, ending the previous canvas’s sessions.',
    input: z.strictObject({ canvas: CanvasId }),
    output: z.strictObject({}),
  }),
} satisfies Partial<Record<OpName, OpDef>>;
