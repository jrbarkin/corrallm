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

/**
 * B11's run reader and whole-run controls (Core Server §4 F), registered over the core's runtime
 * (core/run-control.ts).
 */
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
      summary:
        'Starts every queue from the top (Run, and Run again): what the run has in flight is ' +
        'taken back and its progress forgotten, while every pause stays. Each message it sends ' +
        'is recorded before it is sent. A token starts afresh only a run no other party stopped ' +
        'or decided in, and none that waits for the user.',
      input: z.strictObject({ canvas }),
      output: z.strictObject({}),
    },
  ),
  'run.stop': define(
    { kind: 'command' },
    {
      summary:
        'Stops every queue where it is: what the run sent that is still going is taken back, and ' +
        'the run sends nothing more until it is resumed or started again. Parties’ messages still ' +
        'reach agents that aren’t paused.',
      input: z.strictObject({ canvas }),
      output: z.strictObject({}),
    },
  ),
  'run.resume': define(
    { kind: 'command' },
    {
      summary:
        'Goes on from where a stopped run is, restarting nothing: what it finished stays finished, ' +
        'and what its stop cut off waits for a decision. A token resumes only a run its own party ' +
        'or a restart stopped.',
      input: z.strictObject({ canvas }),
      output: z.strictObject({}),
    },
  ),
  'run.goOn': define(
    { kind: 'command' },
    {
      summary:
        'Ends early the hold an agent is at now: a delay, as if its time had come, or a wait, as ' +
        'if its time limit had passed. Pass `until` as run.get shows it to end only that hold. A ' +
        'usage rule’s hold is the user’s to end.',
      input: z.strictObject({
        canvas,
        agent: AgentId,
        item: ItemId,
        until: z
          .number()
          .min(0)
          .optional()
          .meta({ description: 'When the hold ends by itself (epoch ms), as run.get shows it.' }),
      }),
      output: z.strictObject({}),
    },
  ),
};
