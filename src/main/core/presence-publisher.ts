import type { CanvasId } from '../../shared/canvas';
import { agentOf } from '../../shared/model/messages';
import type { Message } from '../../shared/model/messages';
import type { NeedsItem } from '../../shared/model/needs';
import type { Run } from '../../shared/model/run';
import type { Session } from '../../shared/model/session';
import { nextDue } from './engine/run/runner';
import { MAX_PRESENCE_COUNT } from './presence';
import type { Presence } from './presence';

/*
 * The core's presence (B14 §9 C5, C6): what main shows of a running corrallm with or without a
 * window (the Dock's badge and menu, the menu-bar item and tray, the quit question, the power
 * blocker), as one whole bounded snapshot, never names, ids, paths or text. The core counts it from
 * its own state (the canvases Engines runs, their runs, sessions and messages, what waits for you,
 * the jobs it owns), never from a window's topics; it sends the first as it is composed, then at
 * most one per PRESENCE_EVERY_MS, trailing, once what it counts has changed, each a revision more.
 * Asked `now` (quitting's idle check), it counts at once, and sends that if it changed.
 */

/** At most one snapshot this often, the last change's (trailing). */
export const PRESENCE_EVERY_MS = 250;

/** A snapshot's counts, before its revision and `busy`. */
export type PresenceCounts = Omit<Presence, 'revision' | 'busy'>;

/** What presence reads of a canvas the core runs. */
export interface PresenceCanvas {
  readonly document: { readonly id: CanvasId };
  readonly engine: {
    readonly run: { snapshot(): Run };
    readonly sessions: { snapshot(): Readonly<Record<string, Pick<Session, 'status' | 'tasks'>>> };
  };
  readonly messages: { active(): readonly Pick<Message, 'kind' | 'state' | 'to'>[] };
}

export interface PresenceSources {
  /** Every canvas the core runs (passive ones have no turn or running run). */
  canvases(): Iterable<PresenceCanvas>;
  /** What waits on a canvas now, for whomever (yours are counted). */
  needs(canvas: CanvasId): readonly Pick<NeedsItem, 'id' | 'for'>[];
  /** The owned jobs beside deliveries: worktree setups, worktrees being made or removed. */
  jobs(): number;
  /** Whether OS notifications are on, as the notifier reads the preference (absent means on). */
  notify(): boolean;
}

/**
 * What presence counts now (C5): `working`, agents in a turn (a session working, or waiting for you
 * mid-turn); `runs`, canvases whose run is running (waits and per-agent pauses included); `jobs`,
 * the owned jobs, reported background tasks and each message handed to an idle session; `needs`,
 * the distinct items that wait for you on each canvas; and (C6) `awake`, while something goes on
 * without you: a turn not waiting for you, a setup/workspace/delivery job, or a running run's timer
 * for an agent no pause holds; and `notify`, whether notifications are on (the one fact here that
 * isn't a count: main asks the OS for authorization only while it is true).
 */
export function countPresence(sources: PresenceSources): PresenceCounts {
  let working = 0;
  let runs = 0;
  let jobs = sources.jobs();
  let needs = 0;
  let awake = jobs > 0;
  for (const open of sources.canvases()) {
    const sessions = open.engine.sessions.snapshot();
    for (const session of Object.values(sessions)) {
      // Background work would be cut off by quitting, but does not itself keep the app awake.
      jobs += session.tasks?.length ?? 0;
      if (session.status === 'idle') continue;
      working += 1;
      if (session.status === 'working') awake = true;
    }
    const run = open.engine.run.snapshot();
    if (run.running) runs += 1;
    if (nextDue(run) !== undefined) awake = true;
    for (const message of open.messages.active()) {
      if (message.kind !== 'text' || message.state !== 'delivering') continue;
      const agent = agentOf(message.to);
      // One queued behind a turn going on is that turn's work, counted once.
      if (agent === undefined || (sessions[agent]?.status ?? 'idle') !== 'idle') continue;
      jobs += 1;
      awake = true;
    }
    needs += new Set(
      sources
        .needs(open.document.id)
        .filter((item) => item.for === 'you')
        .map(({ id }) => id),
    ).size;
  }
  return { working, runs, jobs, needs, awake, notify: sources.notify() };
}

export interface PresencePublisherDeps {
  /** What it counts now. */
  count: () => PresenceCounts;
  /** Sends a snapshot to main (HostServices.presence). */
  send: (snapshot: Presence) => void;
}

/** One core process's presence: its snapshots, each whole, revised as what it counts changes. */
export class PresencePublisher {
  readonly #deps: PresencePublisherDeps;
  #last: Presence | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #started = false;
  #closed = false;

  constructor(deps: PresencePublisherDeps) {
    this.#deps = deps;
  }

  /** Sends the first snapshot, whatever it counts (main has none until it does). */
  start(): void {
    this.#started = true;
    this.#publish(snapshotOf(0, this.#deps.count()));
  }

  /**
   * What it counts may have changed: counted again once the period ends, and sent if it did.
   * Nothing before it starts (what it counts may not be composed yet) or once it is closed.
   */
  changed(): void {
    if (!this.#started || this.#closed || this.#timer !== undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.now();
    }, PRESENCE_EVERY_MS);
  }

  /** The snapshot now, counted at once: sent first if it changed (the period's change with it). */
  now(): Presence {
    const counts = this.#deps.count();
    const last = this.#last;
    if (last !== undefined && same(last, counts)) return last;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    const next = snapshotOf(last === undefined ? 0 : last.revision + 1, counts);
    this.#publish(next);
    return next;
  }

  close(): void {
    this.#closed = true;
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #publish(snapshot: Presence): void {
    this.#last = snapshot;
    if (this.#closed) return;
    try {
      this.#deps.send(snapshot);
    } catch (error) {
      // Presence never holds up the core: main keeps the last it heard, and the next goes whole.
      console.error('Could not tell main what corrallm is doing:', error);
    }
  }
}

function snapshotOf(revision: number, counts: PresenceCounts): Presence {
  const cap = (count: number) => Math.min(Math.max(0, Math.trunc(count)), MAX_PRESENCE_COUNT);
  const working = cap(counts.working);
  const runs = cap(counts.runs);
  const jobs = cap(counts.jobs);
  return {
    revision,
    working,
    runs,
    jobs,
    needs: cap(counts.needs),
    busy: working + runs + jobs > 0,
    awake: counts.awake,
    notify: counts.notify,
  };
}

function same(last: Presence, counts: PresenceCounts): boolean {
  const next = snapshotOf(last.revision, counts);
  return (Object.keys(next) as (keyof Presence)[]).every((key) => next[key] === last[key]);
}
