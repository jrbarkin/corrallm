import type { PauseTarget } from '../../../shared/engine/run/runner';
import { groupMembers, isGroup } from '../../../shared/model/queries';
import { OpFailure } from '../call';
import { partyIdOf } from '../caller';
import type { OpenCanvas } from '../engines';
import { runSeen } from './views';
import { RunViewSchema } from '../../../shared/api/ops/b11-data';
import { agentOf, openCanvas, reachFor } from './open';
import type { Implementations, OpServices } from '.';

/**
 * The run (Core Server §4 F): pausing, killing and releasing an agent or a group, whether or not a
 * run is going. Each pause and kill is stamped with the party that set it: a token releases only
 * its own (Core Server rule R9, checked in core.call), you any; a release says what holds its
 * target still (another party's pause, or one on a group it is in). Each takes effect at once, and
 * returns once it is on disk: the canvas's run committed to the database, and for a kill, what it
 * took back with it, in the same commit (one being delivered, once its interrupted turn ends). One
 * that can't be fails, saying it is in place all the same but may not survive a restart.
 */
export function runOps({
  engines,
  isLead,
  runError,
}: OpServices): Pick<Implementations, 'run.get' | 'run.pause' | 'run.kill' | 'run.unpause'> {
  return {
    'run.get': ({ canvas }, ctx) => {
      const open = openCanvas(engines, canvas);
      return RunViewSchema.parse(
        runSeen(
          open,
          ctx.caller,
          reachFor('run.get', ctx),
          ctx.caller.kind === 'agent' && isLead(open.document.id, ctx.caller.agent),
          ctx.caller.kind === 'human' ? runError?.(open.document.id) : undefined,
        ),
      );
    },
    'run.pause': async ({ canvas, target }, { caller }) => {
      const open = openCanvas(engines, canvas);
      const by = partyIdOf(caller);
      if ('agent' in target) open.engine.run.pauseAgent(agentOf(open, target.agent).id, by);
      else open.engine.run.pauseGroup(groupOf(open, target), by);
      await saved(open.journal(), HOLD_UNSAVED);
      return {};
    },
    'run.kill': async ({ canvas, target }, { caller }) => {
      const open = openCanvas(engines, canvas);
      const by = partyIdOf(caller);
      const { engine, delivery } = open;
      const members =
        'agent' in target
          ? [agentOf(open, target.agent).id]
          : groupMembers(open.document.nodes, groupOf(open, target));
      // Held first, so that nothing taken back lets another member's work start.
      if ('agent' in target) engine.run.killAgent(target.agent, by);
      else engine.run.killGroup(target.group, by);
      // What waits is withdrawn at once, committed with the hold: neither reaches the disk without
      // the other. One being delivered is withdrawn once its interrupted turn ends, with the note
      // its recipient is told of it, should it have reached it.
      const withdrawing = delivery.kill(members, by);
      for (const agent of members) engine.sessions.stop(agent);
      await saved(
        open.journal().then(async () => {
          await withdrawing;
          await open.messages.durable();
        }),
        KILL_UNSAVED,
      );
      return {};
    },
    'run.unpause': async ({ canvas, target }, { caller }) => {
      const open = openCanvas(engines, canvas);
      const by = partyIdOf(caller);
      const { run } = open.engine;
      if ('agent' in target) run.resumeAgent(agentOf(open, target.agent).id, by);
      else run.resumeGroup(groupOf(open, target), by);
      await saved(open.journal(), RELEASE_UNSAVED);
      return { held: run.holding(target).map(({ id, by: party }) => ({ by: party, on: id })) };
    },
  };
}

const HOLD_UNSAVED =
  'The hold is in place now, but it could not be saved and may not survive a restart.';
const KILL_UNSAVED =
  'The hold is in place now, and what was sent to or from it taken back, but not all of it could be saved, so it may not survive a restart.';
const RELEASE_UNSAVED =
  'The pause is released now, but the release could not be saved and may not survive a restart.';

/** Resolves once `write` is on disk; a write that fails says `sentence`, undoing nothing. */
async function saved(write: Promise<void>, sentence: string): Promise<void> {
  try {
    await write;
  } catch {
    throw new OpFailure('unavailable', sentence);
  }
}

/** The group a target names: not-found if it names none. */
function groupOf(open: OpenCanvas, target: PauseTarget): string {
  const id = 'group' in target ? target.group : target.agent;
  if (!isGroup(open.document.nodes, id))
    throw new OpFailure('not-found', `There is no group ${id}.`);
  return id;
}
