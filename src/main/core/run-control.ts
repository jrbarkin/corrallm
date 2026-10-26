import type { PartyId } from '../../shared/model/messages';
import { findItem, isDelay, isMessage, isRepeat, isWait } from '../../shared/model/queue';
import type { QueueItem } from '../../shared/model/queue';
import { WINDOW_NAMES } from '../../shared/usage';
import { andList } from '../../shared/model/words';
import { OpFailure } from './call';
import type { OpContext } from './call';
import { partyIdOf } from './caller';
import type { Caller } from './caller';
import type { Engines, OpenCanvas } from './engines';
import { nameOf, partyText, pausesText, RELEASES } from './parties';
import { agentOf, openCanvas } from './ops/open';

/*
 * The whole run's controls (B11 Design §6, Core Server §4 F), the core's services over a canvas's
 * runtime (its engine's RunStore, journaled with its messages: engines.ts), never a renderer's:
 *
 * - run.start is Run, and Run again: every queue from the top, the run's progress and decisions
 *   forgotten, what it has in flight taken back (each of its sends withdrawn, its turn interrupted),
 *   every agent's and group's pause kept. On a run going or stopped it starts afresh (Run again):
 *   one operation, as the window's button is.
 * - run.resume goes on from where a stopped run is, restarting nothing: what it finished stays
 *   finished, and what its stop or a restart cut off stays held for a decision, never sent again.
 *   A run going already has nothing to resume (no change); one with no progress to resume is
 *   refused, saying to start it.
 * - run.stop stops every queue where it is: it takes back what the run sent that is still going and
 *   holds the run's own sends alone; parties' messages stay deliverable (delivery holds them only
 *   for an agent's or a group's pause). Stamped with its party (RunStore.stop).
 * - run.goOn ends the hold an agent is at now (a delay, or a wait), early: only that item, while the
 *   run goes and holds that agent there, at the time the caller saw (`until`, if it says), else a
 *   conflict or a refusal saying why, never a silent success. A usage rule's hold is ended for
 *   every agent on its backend, until its window resets: yours alone (R3).
 *
 * Each takes effect at once and returns once it is on disk (the run journaled with its messages,
 * in one write); every send the run makes is recorded first (RunIO.beforeSend, the mailbox), so a
 * crash before a send goes never sends it twice, and the run restores paused with its start kept.
 *
 * R9 (`sticky`) for a token: it resumes, or starts afresh, only a run its own party or corrallm
 * (a close, a restart) stopped, and never starts afresh one another party decided in, nor one that
 * holds something for the user to decide (which starting afresh would discard). Checked on its
 * arguments in core.call, and again here just before the effect.
 */

/** The most agents a refusal names, then how many more there are. */
const NAMED = 5;

const START_UNSAVED =
  'The run started, but it could not be saved, so it may not survive a restart, and nothing it sends goes until it can be saved.';
const RESUME_UNSAVED =
  'The run goes on now, but it could not be saved, so it may not survive a restart, and nothing it sends goes until it can be saved.';
const STOP_UNSAVED =
  'The run is stopped now, and what it sent taken back, but not all of it could be saved, so it may not survive a restart.';
const GO_ON_UNSAVED =
  'It goes on now, but that could not be saved, so it may not survive a restart.';

/** What run.goOn names: an agent, its item, and the time the caller saw it held until. */
export interface GoOnArgs {
  canvas?: string | undefined;
  agent: string;
  item: string;
  until?: number | undefined;
}

export class RunControl {
  readonly #engines: Pick<Engines, 'canvas'>;

  constructor(engines: Pick<Engines, 'canvas'>) {
    this.#engines = engines;
  }

  /** run.start: Run, and Run again (see above). */
  async start({ canvas }: { canvas?: string | undefined }, ctx: OpContext): Promise<object> {
    const open = openCanvas(this.#engines, canvas);
    refuseIf(ctx.caller, () => startUndoes(open, ctx.caller));
    open.engine.run.start();
    await saved(open.journal(), START_UNSAVED);
    return {};
  }

  /** run.resume: on from where a stopped run is (see above). */
  async resume({ canvas }: { canvas?: string | undefined }, ctx: OpContext): Promise<object> {
    const open = openCanvas(this.#engines, canvas);
    const { run } = open.engine;
    const now = run.snapshot();
    if (now.running) return {};
    if (now.paused !== true) {
      throw new OpFailure(
        'refused',
        'There is nothing to resume: the run hasn’t started, or it finished. Start it with run.start.',
      );
    }
    refuseIf(ctx.caller, () => resumeUndoes(open, ctx.caller));
    run.resume();
    await saved(open.journal(), RESUME_UNSAVED);
    return {};
  }

  /** run.stop: every queue held where it is, the run's own sends taken back (see above). */
  async stop({ canvas }: { canvas?: string | undefined }, ctx: OpContext): Promise<object> {
    const open = openCanvas(this.#engines, canvas);
    open.engine.run.stop(ctx.by);
    // What it took back is settled in the run's write: both on disk, or neither.
    await saved(
      open.journal().then(() => open.messages.durable()),
      STOP_UNSAVED,
    );
    return {};
  }

  /** run.goOn: the hold an agent is at now, ended early (see above). */
  async goOn({ canvas, agent, item, until }: GoOnArgs, ctx: OpContext): Promise<object> {
    const open = openCanvas(this.#engines, canvas);
    const node = agentOf(open, agent);
    const { nodes } = open.document;
    const name = nameOf(nodes, agent);
    const held = findItem(node.data.queue ?? [], item)?.item;
    if (held === undefined) {
      throw new OpFailure('not-found', `${name}’s queue has no item ${item}.`);
    }
    const { run } = open.engine;
    const before = run.snapshot();
    if (!before.running) {
      throw new OpFailure(
        'refused',
        before.paused === true
          ? 'The run is stopped: Go on now ends a hold only while it runs. Resume it first.'
          : `The run isn’t going, so nothing holds ${name} at ${item}.`,
      );
    }
    const at = before.agents[agent];
    if (at?.paused === true) {
      const holding = run.holding({ agent });
      throw new OpFailure(
        'refused',
        `${name} is paused by ${pausesText(nodes, agent, holding)}: it goes on once that is released (${RELEASES})`,
      );
    }
    if (at?.status !== 'waiting' || at.current !== item) {
      throw new OpFailure(
        'conflict',
        `${name} isn’t held at ${item} now${at?.current === undefined || at.current === item ? '' : `: it is at ${at.current}`}, so Go on now ends nothing.`,
      );
    }
    if (until !== undefined && at.until !== until) {
      throw new OpFailure(
        'conflict',
        `${name}’s hold at ${item} isn’t the one you saw (it was reached again since, or its time changed): look at it again before going on.`,
      );
    }
    if (at.usage === undefined) refuseGoOn(open, agent, held);
    else refuseIf(ctx.caller, () => usageGoOn(open, agent, item));
    run.goOn(agent, item, ctx.by);
    if (run.snapshot() === before) {
      throw new OpFailure('conflict', `${name}’s hold at ${item} doesn’t take Go on now.`);
    }
    await saved(open.journal(), GO_ON_UNSAVED);
    return {};
  }
}

/**
 * R9 on a token's run.start: what starting afresh would undo of another party's, as the sentence
 * that refuses it; undefined if nothing. A stop another party made (yours over any), a decision
 * another party took in this run, or anything it holds for the user to decide.
 */
export function startUndoes(open: OpenCanvas, caller: Caller): string | undefined {
  const party = partyIdOf(caller);
  const run = open.engine.run.snapshot();
  const { nodes } = open.document;
  const stopper = stoppedBy(open, party);
  if (stopper !== undefined) {
    return `The run is stopped by ${partyText(nodes, stopper)}: only the party that stopped it, or the user, starts it again.`;
  }
  const asking = Object.entries(run.agents).flatMap(([id, at]) =>
    at.status === 'asking' ? [nameOf(nodes, id)] : [],
  );
  if (asking.length > 0) {
    const more = asking.length - NAMED;
    const names = andList(more > 0 ? [...asking.slice(0, NAMED), `${String(more)} more`] : asking);
    return `${names} ${asking.length === 1 ? 'waits' : 'wait'} for the user to decide, and starting the run afresh would discard that: only the user starts it afresh now.`;
  }
  const others = (run.decided ?? []).filter((by) => by !== party && by !== 'corrallm');
  if (others.length > 0) {
    const who = andList(others.map((by) => partyText(nodes, by)));
    return `${who.charAt(0).toUpperCase()}${who.slice(1)} decided in this run, and starting it afresh would undo that: only the user starts it afresh now.`;
  }
  return undefined;
}

/**
 * R9 on a token's run.resume: the sentence that refuses it if another party stopped the run (a
 * token resumes only its own party's stop, or corrallm's); undefined otherwise.
 */
export function resumeUndoes(open: OpenCanvas, caller: Caller): string | undefined {
  const stopper = stoppedBy(open, partyIdOf(caller));
  return stopper === undefined
    ? undefined
    : `The run stays stopped by ${partyText(open.document.nodes, stopper)}: only the party that stopped it, or the user, resumes it.`;
}

/**
 * R3 on a token's run.goOn: the sentence that refuses it if the agent is held at `item` by a usage
 * rule (Go on there lets every agent on that backend go on: yours alone); undefined otherwise.
 */
export function usageGoOn(open: OpenCanvas, agent: string, item: string): string | undefined {
  const at = open.engine.run.snapshot().agents[agent];
  const hold = at?.status === 'waiting' && at.current === item ? at.usage : undefined;
  if (hold === undefined) return undefined;
  const backend = open.engine.catalog.backendName(hold.backend);
  return `Only the user goes on past a usage rule: ${nameOf(open.document.nodes, agent)} waits for ${backend}’s ${WINDOW_NAMES[hold.window]} reset, as its rule says.`;
}

/** The party whose stop holds the run, if a token of `party` may not lift it. */
function stoppedBy(open: OpenCanvas, party: PartyId): PartyId | undefined {
  const run = open.engine.run.snapshot();
  if (run.running || run.paused !== true) return undefined;
  const by = run.pausedBy ?? 'corrallm';
  return by === party || by === 'corrallm' ? undefined : by;
}

/** Refuses a token's call, saying why, if `refusal` says it undoes another party's. */
function refuseIf(caller: Caller, refusal: () => string | undefined): void {
  if (caller.kind === 'human') return;
  const sentence = refusal();
  if (sentence !== undefined) throw new OpFailure('refused', sentence);
}

/**
 * A hold Go on now doesn't end: a repeat going round with another (it ends with it), or a task
 * waiting for its paused recipient.
 */
function refuseGoOn(open: OpenCanvas, agent: string, held: QueueItem): void {
  if (isDelay(held) || isWait(held)) return;
  const { nodes } = open.document;
  if (isRepeat(held)) {
    throw new OpFailure(
      'refused',
      `${held.id} goes round with the repeat it follows, and ends with it: Go on now doesn’t end it.`,
    );
  }
  const to = isMessage(held) ? (held.target ?? agent) : agent;
  const holding = open.engine.run.holding({ agent: to });
  throw new OpFailure(
    'refused',
    holding.length > 0
      ? `${held.id} waits for ${nameOf(nodes, to)}, which is paused by ${pausesText(nodes, to, holding)}: it goes once that is released (${RELEASES})`
      : `${held.id} isn’t a delay or a wait: Go on now doesn’t end it.`,
  );
}

/** Resolves once `write` is on disk; a write that fails says `sentence`, undoing nothing. */
async function saved(write: Promise<void>, sentence: string): Promise<void> {
  try {
    await write;
  } catch {
    throw new OpFailure('unavailable', sentence);
  }
}
