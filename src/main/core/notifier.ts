import { MAX_NEED_ID } from '../../shared/api/limits';
import type { CanvasId } from '../../shared/canvas';
import type { WindowShow } from '../../shared/gui-link';
import type { NeedsItem } from '../../shared/model/needs';
import type { Run } from '../../shared/model/run';
import { notificationText, subjectOf } from './notification-text';
import type { NotificationSubject } from './notification-text';
import type { NotificationRequest, NotificationResult } from './presence';

/*
 * The core's notifier (B14 §9 C7, and C10's core half): which of the core's own state changes
 * become an OS notification, and where a click on one leads. Eligible are a Needs item for you
 * newly entering a canvas's current set, after that canvas's first pass since it opened (its
 * baseline: nothing already waiting is announced), and a run that was running in this core ending,
 * finished or stopped by a party (never a restore, the barrier, a quit, a per-agent pause or a
 * crash). An id that leaves the set and comes back is a new episode; an item changing in place is
 * not. Nothing is eligible while a corrallm window is focused (main says so, `focus`), or while
 * notifications are off (read at each event): what was dropped is never replayed.
 *
 * Events within NOTIFY_COALESCE_MS of a burst's first go out as one: one event in its own words
 * (notification-text.ts), several as "N things need you"; at most NOTIFY_PER_MINUTE a minute, then
 * one at the next slot for all that waited. Only ids and counts are held, never text: the words
 * are made as it goes, from the names then. Needs counted past the ids a burst holds are bounded
 * as it goes by what is live then (per canvas, less its live items held by id). Each notification gets a new UUID, mapped to where a
 * click leads (`{ canvas, need? }`; none for a rollup across canvases: a generic Open), at most
 * MAX_NOTIFICATION_HANDLES (the oldest closed), forgotten (and closed) as its canvas closes, its
 * Need settles (a rollup's, every Need it counted), or notifications turn off. No persistence and
 * no retry: a failure is a status, never another notification.
 */

/** A burst's window: events within it of its first go out as one. */
export const NOTIFY_COALESCE_MS = 2000;
/** At most this many notifications a minute. */
export const NOTIFY_PER_MINUTE = 6;
/** The handles a click may name, at most: the oldest is closed and forgotten past it. */
export const MAX_NOTIFICATION_HANDLES = 256;
/** A canvas's Needs are compared again at most this often after its baseline (trailing). */
const NEEDS_EVERY_MS = 250;
const MINUTE_MS = 60_000;
/** The events a burst (or those waiting for a slot) holds by id; past it, only a count. */
const MAX_PENDING = 256;

/** What the notifier reads of a canvas's run. */
export interface NotifierRun {
  snapshot(): Pick<Run, 'running' | 'paused' | 'pausedBy' | 'agents'>;
  subscribe(listener: () => void): () => void;
}

/** The notifier's timings; tests may shorten them. */
export interface NotifierTiming {
  coalesceMs: number;
  perMinute: number;
}

export interface NotifierDeps {
  /** What waits on a canvas the core runs, now, for whomever: yours are notified. */
  needs(canvas: CanvasId): readonly Pick<NeedsItem, 'id' | 'kind' | 'for' | 'agent'>[];
  /** A canvas's run, while the core runs it. */
  run(canvas: CanvasId): NotifierRun | undefined;
  /** Whether the core runs the canvas now. */
  runs(canvas: CanvasId): boolean;
  /** An agent's name as the app shows it. */
  agentName(canvas: CanvasId, agent: string): string;
  /** A canvas's name as the app shows it (its file's name), or null for a draft. */
  canvasName(canvas: CanvasId): string | null;
  /** Whether notifications are on (settings' `notifications.enabled`): read at each event. */
  enabled(): boolean;
  /** Asks main to show one (HostServices.notify). */
  notify(request: NotificationRequest): Promise<NotificationResult>;
  /** Asks main to close one it holds (HostServices.unnotify). */
  unnotify(handle: string): void;
  timing?: Partial<NotifierTiming>;
}

/** An eligible event, by ids alone: a Need (its kind and agent, for its words) or a run's end. */
type Pending =
  | { canvas: CanvasId; need: string; kind: NeedsItem['kind']; agent?: string }
  | { canvas: CanvasId; run: 'finished' | 'stopped' };

/** Events past the ones held by id, only counted: Needs (bounded at delivery) and run endings. */
interface Counted {
  needs: number;
  runs: number;
}

/** Events going out as one: those held by id, those only counted, and their canvases. */
interface Batch {
  events: Pending[];
  extra: Map<CanvasId, Counted>;
  canvases: Set<CanvasId>;
}

/** A canvas the notifier watches: its Needs as last compared (none before its baseline). */
interface Watched {
  seen: Set<string> | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  running: boolean;
  stop: (() => void) | undefined;
}

/** A notification main may hold: where its click leads, and the Needs that withdraw it. */
interface Shown {
  canvases: Set<CanvasId>;
  canvas?: CanvasId;
  need?: string;
  /** Its Needs' keys still waiting: none to track (a run's end, a count) when undefined. */
  needs?: Set<string>;
  /**
   * The canvases whose Needs it counts without ids: closed once none of its canvases has a Need
   * for you left (their ids were never held, so they can't be settled one by one).
   */
  counted?: Set<CanvasId>;
}

export class Notifier {
  readonly #deps: NotifierDeps;
  readonly #timing: NotifierTiming;
  readonly #canvases = new Map<CanvasId, Watched>();
  readonly #shown = new Map<string, Shown>();
  /** When each of the last minute's notifications went. */
  #sent: number[] = [];
  #batch: Batch | undefined;
  #batchTimer: ReturnType<typeof setTimeout> | undefined;
  /** Events past the rate, waiting for the next slot, with its timer. */
  #waiting: Batch | undefined;
  #slotTimer: ReturnType<typeof setTimeout> | undefined;
  /** Whether a corrallm window is focused, as main last said: none until it does. */
  #focused = false;
  #enabled: boolean;
  #status: NotificationResult | undefined;
  #closed = false;

  constructor(deps: NotifierDeps) {
    this.#deps = deps;
    this.#enabled = deps.enabled();
    this.#timing = {
      coalesceMs: deps.timing?.coalesceMs ?? NOTIFY_COALESCE_MS,
      perMinute: deps.timing?.perMinute ?? NOTIFY_PER_MINUTE,
    };
  }

  /** A canvas opened in the core: its next Needs pass is its baseline, its run's state now too. */
  opened(canvas: CanvasId): void {
    if (this.#closed) return;
    this.#unwatch(canvas);
    const run = this.#deps.run(canvas);
    const watched: Watched = {
      seen: undefined,
      timer: undefined,
      running: run?.snapshot().running ?? false,
      stop: undefined,
    };
    watched.stop = run?.subscribe(() => {
      this.#runChanged(canvas, watched, run.snapshot());
    });
    this.#canvases.set(canvas, watched);
  }

  /** A canvas closed: its events dropped, its notifications closed and forgotten. */
  closed(canvas: CanvasId): void {
    if (this.#closed) return;
    this.#unwatch(canvas);
    this.#prune((event) => event.canvas !== canvas, canvas);
    for (const [handle, shown] of this.#shown) {
      shown.canvases.delete(canvas);
      shown.counted?.delete(canvas);
      for (const key of shown.needs ?? []) {
        if (key.startsWith(`${canvas}\u0000`)) shown.needs?.delete(key);
      }
      if (
        shown.canvas === canvas ||
        shown.canvases.size === 0 ||
        (shown.needs?.size === 0 && (shown.counted?.size ?? 0) === 0)
      )
        this.#withdraw(handle);
    }
    this.#withdrawCounted();
  }

  /**
   * What waits on a canvas may have changed: compared at once for its baseline, then at most every
   * NEEDS_EVERY_MS.
   */
  needsChanged(canvas: CanvasId): void {
    if (this.#closed || !this.#deps.runs(canvas)) return;
    let watched = this.#canvases.get(canvas);
    if (watched === undefined) {
      watched = { seen: undefined, timer: undefined, running: false, stop: undefined };
      this.#canvases.set(canvas, watched);
    }
    if (watched.seen === undefined) {
      this.#compare(canvas, watched);
      return;
    }
    if (watched.timer !== undefined) return;
    const it = watched;
    it.timer = setTimeout(() => {
      it.timer = undefined;
      if (this.#canvases.get(canvas) === it) this.#compare(canvas, it);
    }, NEEDS_EVERY_MS);
  }

  /**
   * Whether any corrallm window is focused (main's): while one is, nothing goes or waits to. What
   * changed before main said so is compared first, as it was then.
   */
  focus(focused: boolean): void {
    if (focused !== this.#focused && !this.#closed) {
      for (const [canvas, watched] of this.#canvases) {
        if (watched.timer === undefined) continue;
        clearTimeout(watched.timer);
        watched.timer = undefined;
        this.#compare(canvas, watched);
      }
    }
    this.#focused = focused;
    if (focused) this.#drop();
  }

  /** The preference may have changed: turned off, nothing waits to go, and every one is closed. */
  preferenceChanged(): void {
    if (this.#closed) return;
    const enabled = this.#deps.enabled();
    if (enabled !== this.#enabled) {
      // Finish delayed comparisons at the preference boundary without announcing what waited.
      for (const [canvas, watched] of this.#canvases) {
        if (watched.timer === undefined) continue;
        clearTimeout(watched.timer);
        watched.timer = undefined;
        this.#compare(canvas, watched, false);
      }
    }
    this.#enabled = enabled;
    if (enabled) return;
    this.#drop();
    for (const handle of [...this.#shown.keys()]) this.#withdraw(handle);
  }

  /**
   * Where a notification's click leads (C10): its canvas, and its Need if it had one, while the
   * core runs that canvas; none (a generic Open) for an unknown handle or a canvas it doesn't.
   */
  activation(handle: string): WindowShow | undefined {
    const shown = typeof handle === 'string' ? this.#shown.get(handle) : undefined;
    const canvas = shown?.canvas;
    if (canvas === undefined || !this.#deps.runs(canvas)) return undefined;
    const need = shown?.need;
    return need !== undefined && need.length <= MAX_NEED_ID ? { canvas, need } : { canvas };
  }

  /** How the last notification went (C9), without values: none yet, if none was attempted. */
  status(): NotificationResult | undefined {
    return this.#status;
  }

  /** The core closes: nothing more goes, and nothing is held (main closes what it shows). */
  close(): void {
    this.#closed = true;
    this.#drop();
    for (const canvas of [...this.#canvases.keys()]) this.#unwatch(canvas);
    this.#shown.clear();
  }

  #unwatch(canvas: CanvasId): void {
    const watched = this.#canvases.get(canvas);
    if (watched === undefined) return;
    clearTimeout(watched.timer);
    watched.stop?.();
    this.#canvases.delete(canvas);
  }

  /** Compares what waits for you on a canvas with its last pass: settled, and newly eligible. */
  #compare(canvas: CanvasId, watched: Watched, eligible = true): void {
    let items: readonly Pick<NeedsItem, 'id' | 'kind' | 'for' | 'agent'>[];
    try {
      items = this.#deps.needs(canvas).filter((item) => item.for === 'you');
    } catch {
      // Never holds the core up: compared again at the next change, from what it last saw.
      console.error('corrallm couldn’t read what waits for you, for its notifications.');
      return;
    }
    const now = new Set(items.map(({ id }) => id));
    const before = watched.seen;
    watched.seen = now;
    if (before === undefined) return;
    for (const id of before) if (!now.has(id)) this.#settled(canvas, id);
    this.#withdrawCounted();
    if (!eligible) return;
    const added = new Set<string>();
    for (const item of items) {
      if (before.has(item.id) || added.has(item.id)) continue;
      added.add(item.id);
      this.#eligible({
        canvas,
        need: item.id,
        kind: item.kind,
        ...(item.agent === undefined ? {} : { agent: item.agent }),
      });
    }
  }

  #runChanged(canvas: CanvasId, watched: Watched, run: ReturnType<NotifierRun['snapshot']>): void {
    if (this.#closed) return;
    const was = watched.running;
    watched.running = run.running;
    if (!was || run.running) return;
    const ended = endOf(run);
    if (ended !== undefined) this.#eligible({ canvas, run: ended });
  }

  /** A Need that waited no longer does: not sent if still to go, and its notification closed. */
  #settled(canvas: CanvasId, id: string): void {
    this.#prune((event) => !('need' in event && event.canvas === canvas && event.need === id));
    const key = keyOf(canvas, id);
    for (const [handle, shown] of this.#shown) {
      if (
        shown.needs?.delete(key) === true &&
        shown.needs.size === 0 &&
        shown.counted === undefined
      )
        this.#withdraw(handle);
    }
  }

  /** Closes the notifications counting Needs without ids once their canvases have none left. */
  #withdrawCounted(): void {
    for (const [handle, shown] of this.#shown) {
      if (shown.counted === undefined) continue;
      if ([...shown.canvases].every((canvas) => this.#canvases.get(canvas)?.seen?.size === 0))
        this.#withdraw(handle);
    }
  }

  /** What waits for you on a canvas now, by id; no count when its live Needs can't be read. */
  #live(canvas: CanvasId): ReadonlySet<string> {
    if (!this.#deps.runs(canvas)) return new Set();
    try {
      return new Set(
        this.#deps
          .needs(canvas)
          .filter((item) => item.for === 'you')
          .map(({ id }) => id),
      );
    } catch {
      console.error('corrallm couldn’t read what waits for you, for its notifications.');
      // Items held by id still go; a count without ids needs a successful live read.
      return new Set();
    }
  }

  #eligible(event: Pending): void {
    if (this.#focused || !this.#deps.enabled()) return;
    if (this.#batch === undefined) {
      this.#batch = { events: [], extra: new Map(), canvases: new Set() };
      this.#batchTimer = setTimeout(() => {
        this.#batchTimer = undefined;
        const batch = this.#batch;
        this.#batch = undefined;
        if (batch !== undefined) this.#ready(batch);
      }, this.#timing.coalesceMs);
    }
    add(this.#batch, event);
  }

  /** A burst's window ended: it goes now if the rate allows, else waits for the next slot. */
  #ready(batch: Batch): void {
    if (this.#waiting !== undefined) {
      merge(this.#waiting, batch);
      return;
    }
    const next = this.#nextSlot();
    if (next === undefined) {
      this.#send(batch);
      return;
    }
    this.#waiting = batch;
    this.#armSlot(next);
  }

  #armSlot(at: number): void {
    clearTimeout(this.#slotTimer);
    this.#slotTimer = setTimeout(
      () => {
        this.#slotTimer = undefined;
        const later = this.#nextSlot();
        if (later !== undefined) {
          this.#armSlot(later);
          return;
        }
        const waiting = this.#waiting;
        this.#waiting = undefined;
        if (waiting !== undefined) this.#send(waiting);
      },
      Math.max(0, at - Date.now()),
    );
  }

  /** When the next notification may go, if not now. */
  #nextSlot(): number | undefined {
    const now = Date.now();
    this.#sent = this.#sent.filter((at) => now - at < MINUTE_MS);
    const oldest = this.#sent[0];
    return this.#sent.length < this.#timing.perMinute || oldest === undefined
      ? undefined
      : oldest + MINUTE_MS;
  }

  #send(batch: Batch): void {
    if (this.#closed || this.#focused || !this.#deps.enabled()) return;
    // Needs counted without ids can't be settled one by one: per canvas, at most the Needs for you
    // it has now beyond the live ones held by id. Run endings never go stale, and stay as held.
    const live = new Map<CanvasId, ReadonlySet<string>>();
    const liveOf = (canvas: CanvasId) => {
      let ids = live.get(canvas);
      if (ids === undefined) live.set(canvas, (ids = this.#live(canvas)));
      return ids;
    };
    const counted = new Map<CanvasId, number>();
    let ended = 0;
    const canvases = new Set(batch.events.map(({ canvas }) => canvas));
    for (const [canvas, extra] of batch.extra) {
      if (extra.runs > 0) {
        ended += extra.runs;
        canvases.add(canvas);
      }
      if (extra.needs === 0) continue;
      const ids = liveOf(canvas);
      const held = batch.events.filter(
        (event) => event.canvas === canvas && 'need' in event && ids.has(event.need),
      ).length;
      const bound = Math.min(extra.needs, Math.max(0, ids.size - held));
      if (bound === 0) continue;
      counted.set(canvas, bound);
      canvases.add(canvas);
    }
    let total = batch.events.length + ended;
    for (const count of counted.values()) total += count;
    if (total === 0) return;
    const [only] = batch.events;
    let subject: NotificationSubject;
    let shown: Shown;
    if (total === 1 && only !== undefined) {
      if ('run' in only) {
        subject = { kind: only.run, canvas: this.#deps.canvasName(only.canvas) };
        shown = { canvas: only.canvas, canvases };
      } else {
        subject = subjectOf(
          {
            id: only.need,
            kind: only.kind,
            ...(only.agent === undefined ? {} : { agent: only.agent }),
          },
          {
            agent: (agent) => this.#deps.agentName(only.canvas, agent),
            canvas: this.#deps.canvasName(only.canvas),
          },
        );
        shown = {
          canvases,
          canvas: only.canvas,
          need: only.need,
          needs: new Set([keyOf(only.canvas, only.need)]),
        };
      }
    } else {
      subject = { kind: 'rollup', count: total };
      const [canvas] = canvases;
      const needs = batch.events.flatMap((event) =>
        'need' in event ? [keyOf(event.canvas, event.need)] : [],
      );
      // Withdrawn by its Needs only if it counted nothing else.
      const onlyNeeds = ended === 0 && needs.length === batch.events.length;
      shown = {
        canvases,
        ...(canvases.size === 1 && canvas !== undefined ? { canvas } : {}),
        ...(onlyNeeds ? { needs: new Set(needs) } : {}),
        ...(onlyNeeds && counted.size > 0 ? { counted: new Set(counted.keys()) } : {}),
      };
    }
    const handle = crypto.randomUUID();
    while (this.#shown.size >= MAX_NOTIFICATION_HANDLES) {
      const [oldest] = this.#shown.keys();
      if (oldest === undefined) break;
      this.#withdraw(oldest);
    }
    this.#shown.set(handle, shown);
    this.#sent.push(Date.now());
    const { title, body } = notificationText(subject);
    let asked: Promise<NotificationResult>;
    try {
      asked = this.#deps.notify({ handle, title, body });
    } catch (error) {
      asked = Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    void asked.then(
      (result) => {
        this.#status = result;
        // Nothing shown: nothing to close, nothing to click.
        if (result !== 'shown') this.#shown.delete(handle);
      },
      () => {
        this.#status = 'failed';
        this.#shown.delete(handle);
        console.error('corrallm couldn’t show a notification.');
      },
    );
  }

  /** Closes a notification main may hold, and forgets its handle. */
  #withdraw(handle: string): void {
    this.#shown.delete(handle);
    try {
      this.#deps.unnotify(handle);
    } catch {
      console.error('corrallm couldn’t close a notification.');
    }
  }

  /** Keeps only the pending events `keep` keeps; their canvases follow, unless some are uncounted. */
  #prune(keep: (event: Pending) => boolean, closedCanvas?: CanvasId): void {
    for (const batch of [this.#batch, this.#waiting]) {
      if (batch === undefined) continue;
      batch.events = batch.events.filter(keep);
      if (closedCanvas !== undefined) batch.extra.delete(closedCanvas);
      batch.canvases = new Set([
        ...batch.events.map(({ canvas }) => canvas),
        ...batch.extra.keys(),
      ]);
    }
  }

  /** Nothing waits to go: what was pending is dropped, never replayed. */
  #drop(): void {
    clearTimeout(this.#batchTimer);
    clearTimeout(this.#slotTimer);
    this.#batchTimer = undefined;
    this.#slotTimer = undefined;
    this.#batch = undefined;
    this.#waiting = undefined;
  }
}

/** How a run that was running ended, if a party ended it or it finished; none for corrallm's pause. */
function endOf(run: ReturnType<NotifierRun['snapshot']>): 'finished' | 'stopped' | undefined {
  if (run.paused === true)
    return (run.pausedBy ?? 'corrallm') === 'corrallm' ? undefined : 'stopped';
  return Object.values(run.agents).every((agent) => agent.status === 'done')
    ? 'finished'
    : 'stopped';
}

function keyOf(canvas: CanvasId, need: string): string {
  return `${canvas}\u0000${need}`;
}

function add(batch: Batch, event: Pending): void {
  batch.canvases.add(event.canvas);
  if (batch.events.length < MAX_PENDING) {
    batch.events.push(event);
    return;
  }
  const extra = batch.extra.get(event.canvas) ?? { needs: 0, runs: 0 };
  if ('need' in event) extra.needs += 1;
  else extra.runs += 1;
  batch.extra.set(event.canvas, extra);
}

function merge(into: Batch, from: Batch): void {
  for (const event of from.events) add(into, event);
  for (const [canvas, count] of from.extra) {
    into.canvases.add(canvas);
    const extra = into.extra.get(canvas) ?? { needs: 0, runs: 0 };
    extra.needs += count.needs;
    extra.runs += count.runs;
    into.extra.set(canvas, extra);
  }
}
