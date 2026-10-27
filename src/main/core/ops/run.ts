import type { PauseTarget } from '../engine/run/runner';
import { groupMembers, isGroup } from '../../../shared/model/queries';
import { OpFailure } from '../call';
import { RunControl } from '../run-control';
import { partyIdOf } from '../caller';
import type { OpenCanvas } from '../engines';
import { runSeen } from './views';
import { RunViewSchema } from '../../../shared/api/ops/b11-data';
import { MAX_PAUSE_UNSAVED, MAX_PRESENCE_COUNT } from '../../../shared/api/limits';
import { agentOf, openCanvas, reachFor } from './open';
import type { Implementations, OpServices } from '.';

/**
 * The run (Core Server §4 F): its whole-run controls, Run (and Run again), Stop, Resume and Go on
 * now, the core's services over the canvas's runtime (core/run-control.ts, with R9's and R3's
 * refusals); and pausing, killing and releasing an agent or a group, whether or not a run is going. Each pause and kill is stamped with the party that set it: a token releases only
 * its own (Core Server rule R9, checked in core.call), you any; a release says what holds its
 * target still (another party's pause, or one on a group it is in). Each takes effect at once, and
 * returns once it is on disk: the canvas's run committed to the database, and for a kill, what it
 * took back at once with it, in the same commit (one being delivered is withdrawn once its
 * interrupted turn ends, which the kill never waits for). One that can't be fails, saying it is in
 * place all the same but may not survive a restart. Pause all (B14 C3), from main's native menus
 * as you, pauses every agent of every canvas the core runs in one synchronous pass, then journals
 * each canvas it paused one on, all together: one that can't be saved is said, undoing nothing.
 */
export function runOps({
  engines,
  isLead,
  runError,
}: OpServices): Pick<
  Implementations,
  | 'run.get'
  | 'run.start'
  | 'run.stop'
  | 'run.resume'
  | 'run.goOn'
  | 'run.pause'
  | 'run.pauseAll'
  | 'run.kill'
  | 'run.unpause'
> {
  const control = new RunControl(engines);
  return {
    'run.start': (args, ctx) => control.start(args, ctx),
    'run.stop': (args, ctx) => control.stop(args, ctx),
    'run.resume': (args, ctx) => control.resume(args, ctx),
    'run.goOn': (args, ctx) => control.goOn(args, ctx),
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
    'run.pauseAll': async (_args, ctx) => {
      const by = partyIdOf(ctx.caller);
      // One pass with no await: every agent of every canvas the core runs (executing), at once,
      // so no callback starts another one's work between pauses. One opened, added or run after
      // it is not paused (a later Pause all is); one already paused by `by` is left as it is.
      const paused: OpenCanvas[] = [];
      let agents = 0;
      for (const canvas of engines.opened()) {
        const open = engines.canvas(canvas);
        if (open?.state !== 'executing') continue;
        const { run } = open.engine;
        const already = new Set(
          (run.snapshot().individualPauses ?? [])
            .filter((cause) => cause.by === by)
            .map(({ id }) => id),
        );
        let here = 0;
        for (const node of open.document.nodes) {
          if (node.type !== 'agent' || already.has(node.id)) continue;
          run.pauseAgent(node.id, by);
          here += 1;
        }
        if (here === 0) continue;
        agents += here;
        paused.push(open);
        for (const kind of ['run', 'sessions', 'messages', 'needs'] as const)
          ctx.published(`${kind}:${open.document.id}`);
      }
      // Then each canvas it paused one on, journaled together.
      const saved = await Promise.allSettled(paused.map((open) => open.journal()));
      const unsaved = paused.flatMap((open, i) =>
        saved[i]?.status === 'rejected'
          ? [{ canvas: open.document.id, sentence: HOLD_UNSAVED }]
          : [],
      );
      return {
        agents: Math.min(agents, MAX_PRESENCE_COUNT),
        canvases: Math.min(paused.length, MAX_PRESENCE_COUNT),
        unsaved: unsaved.slice(0, MAX_PAUSE_UNSAVED),
      };
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
      // its recipient is told of it, should it have reached it: not waited for here, since a CLI
      // that ignores the interrupt would hold this call's scope for as long.
      delivery.kill(members, by);
      for (const agent of members) engine.sessions.stop(agent);
      await saved(
        open.journal().then(() => open.messages.durable()),
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
