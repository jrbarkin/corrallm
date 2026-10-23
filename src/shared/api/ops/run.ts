import { z } from 'zod';

import { define } from '../define';
import type { OpDef } from '../define';
import { PARTY_PATTERN } from '../../model/messages';
import { AgentId, GroupId, ItemId, OpCanvas } from '../ids';
import { RunViewSchema } from './b11-data';
import type { OpName } from '../surface';

/** The run (Core Server §4 F): holding and releasing an agent's queue, or a group's. */

const canvas = OpCanvas;

/** A party: you, corrallm, an agent (`agent:<id>`) or an outside orchestrator (`outside:<name>`). */
const Party = z.string().regex(PARTY_PATTERN);

/** One agent, or every agent of a group (a group of nodes, or an agent with agents inside it). */
const Target = z.union([z.strictObject({ agent: AgentId }), z.strictObject({ group: GroupId })]);

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
      'back the messages to and from it that are waiting or whose turn is going on. An agent ' +
      'one of them had reached is told so with its next message.',
    input: z.strictObject({ canvas, target: Target }),
    output: z.strictObject({}),
  }),
  'run.unpause': define('run.unpause', {
    summary:
      'Unpauses an agent, or every agent of a group, that you paused or killed. Only the user ' +
      'releases a pause another set. Returns the pauses that hold it still: whose, and on what ' +
      '(it, or a group it is in); none once it runs again.',
    input: z.strictObject({ canvas, target: Target }),
    output: z.strictObject({
      held: z.array(z.strictObject({ by: Party, on: z.string() })),
    }),
  }),
} satisfies Partial<Record<OpName, OpDef>>;

/** B11 X2: prepared only; X9 registers these when the core services exist. */
export const b11RunOps = {
  'run.get': define(
    { kind: 'read' },
    {
      summary: 'The current run, projected for the caller.',
      input: z.strictObject({ canvas }),
      output: RunViewSchema,
    },
  ),
  'run.start': define(
    { kind: 'command' },
    {
      summary: 'Starts the queues afresh, recording each message before sending it.',
      input: z.strictObject({ canvas }),
      output: z.strictObject({}),
    },
  ),
  'run.stop': define(
    { kind: 'command' },
    {
      summary: 'Stops the run and takes back its sends; parties’ messages remain deliverable.',
      input: z.strictObject({ canvas }),
      output: z.strictObject({}),
    },
  ),
  'run.resume': define(
    { kind: 'command' },
    {
      summary: 'Resumes paused progress without starting a new run.',
      input: z.strictObject({ canvas }),
      output: z.strictObject({}),
    },
  ),
  'run.goOn': define(
    { kind: 'command' },
    {
      summary: 'Ends the current delay or time limit early.',
      input: z.strictObject({ canvas, agent: AgentId, item: ItemId }),
      output: z.strictObject({}),
    },
  ),
};
