import { z } from 'zod';

import { define } from '../define';
import type { OpDef } from '../define';
import { AgentId, CanvasId, NodeId } from '../ids';
import type { OpName } from '../surface';

/** The run (Core Server §4 F): holding and releasing an agent's queue, or a group's. */

const canvas = CanvasId.optional();

/** One agent, or every agent of a group (a group of nodes, or an agent with agents inside it). */
const Target = z.union([z.strictObject({ agent: AgentId }), z.strictObject({ group: NodeId })]);

export const runOps = {
  'run.pause': define('run.pause', {
    summary:
      'Pauses an agent, or every agent of a group: what it is doing finishes, then nothing more ' +
      'is sent to it, messages from parties included, until it is unpaused.',
    input: z.strictObject({ canvas, target: Target }),
    output: z.strictObject({}),
  }),
  'run.kill': define('run.kill', {
    summary:
      'Kills an agent, or every agent of a group: pauses it, interrupts its turn, and takes ' +
      'back the messages to and from it that are waiting or whose turn is going on.',
    input: z.strictObject({ canvas, target: Target }),
    output: z.strictObject({}),
  }),
  'run.unpause': define('run.unpause', {
    summary:
      'Unpauses an agent, or every agent of a group, that you paused or killed. Only the user ' +
      'releases a pause another set.',
    input: z.strictObject({ canvas, target: Target }),
    output: z.strictObject({}),
  }),
} satisfies Partial<Record<OpName, OpDef>>;
