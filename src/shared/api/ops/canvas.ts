import { z } from 'zod';

import { define } from '../define';
import type { OpDef } from '../define';
import { NodeId, OpCanvas } from '../ids';
import { MAX_LABEL } from '../limits';
import type { OpName } from '../surface';

/**
 * A canvas's structure (Core Server §4 C): its nodes and links, each op a change to the canvas's
 * document.
 */
export const canvasOps = {
  'canvas.rename': define('canvas.rename', {
    summary: 'Renames an agent or a group: the name the canvas shows it by.',
    input: z.strictObject({ canvas: OpCanvas, node: NodeId, label: z.string().max(MAX_LABEL) }),
    output: z.strictObject({}),
  }),
} satisfies Partial<Record<OpName, OpDef>>;
