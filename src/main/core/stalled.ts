import { connectionIn } from '../../shared/adapter';
import type { Catalog, ConnectionId } from '../../shared/adapter';
import type { CanvasId } from '../../shared/canvas';
import type { NeedsItem } from '../../shared/model/needs';
import type { SessionEvent } from '../../shared/session';

export const STALL_MS = 20 * 60_000;
export const WAKE_GRACE_MS = 2 * 60_000;
export const WATCH_EVERY_MS = 15_000;
/** A late timer can mean sleep, suspension, or a blocked process: all deserve fresh grace. */
const WAKE_GAP_MS = 60_000;

export interface WatchdogClock {
  now: () => number;
  later: (run: () => void, ms: number) => () => void;
}

interface Turn {
  canvas: CanvasId;
  agent: string;
  connection: ConnectionId;
  messages: Set<string>;
  last: number;
  wake?: number;
  notified: boolean;
  stalled: boolean;
  text: string;
}

interface Deps {
  catalog: Catalog;
  clock?: WatchdogClock;
  changed: (canvas: CanvasId) => void;
  warning: (
    canvas: CanvasId,
    agent: string,
    connection: ConnectionId,
    messages: string[],
    text: string,
  ) => void;
}

/**
 * A turn's silence is a warning, never a failure. Owned by the core, independent of whether its
 * run lives here or in a window. Only live connector events enter this service: history and our
 * own warning must not look like fresh CLI activity. Timers are unref'd and stopped at close.
 */
export class StalledTurns {
  readonly #deps: Deps;
  readonly #clock: WatchdogClock;
  readonly #turns = new Map<string, Turn>();
  #checked: number;
  #cancel: () => void = () => undefined;
  #closed = false;

  constructor(deps: Deps) {
    this.#deps = deps;
    this.#clock = deps.clock ?? {
      now: Date.now,
      later: (run, ms) => {
        const timer = setTimeout(run, ms);
        timer.unref();
        return () => {
          clearTimeout(timer);
        };
      },
    };
    this.#checked = this.#clock.now();
    this.#arm();
  }

  event(canvas: CanvasId, agent: string, connection: ConnectionId, event: SessionEvent): void {
    if (this.#closed) return;
    if (event.type === 'end' || event.type === 'closed' || event.type === 'cleared') {
      this.ended(canvas, agent);
      return;
    }
    const key = keyOf(canvas, agent);
    let turn = this.#turns.get(key);
    if (
      !turn &&
      (event.type === 'user' || (event.type === 'status' && event.status === 'working'))
    ) {
      turn = {
        canvas,
        agent,
        connection,
        messages: new Set(),
        last: this.#clock.now(),
        notified: false,
        stalled: false,
        text: '',
      };
      this.#turns.set(key, turn);
    }
    if (event.type === 'user') turn?.messages.add(event.id);
    this.activity(canvas, agent);
  }

  /** Raw output/hooks/progress count too, even if a connector has no transcript event for them. */
  activity(canvas: CanvasId, agent: string): void {
    const turn = this.#turns.get(keyOf(canvas, agent));
    if (!turn) return;
    turn.last = this.#clock.now();
    delete turn.wake;
    if (turn.stalled) {
      turn.stalled = false;
      this.#deps.changed(canvas);
    }
  }

  /** Also used when a session is intentionally closed without emitting a closed event. */
  ended(canvas: CanvasId, agent: string): void {
    const key = keyOf(canvas, agent);
    const turn = this.#turns.get(key);
    this.#turns.delete(key);
    if (turn?.stalled) this.#deps.changed(canvas);
  }

  /** Host resume, or the headless timer's equivalent. Duplicate wake reports do not extend grace. */
  resume(): void {
    this.#woke(this.#clock.now());
  }

  #woke(before: number): void {
    const now = this.#clock.now();
    for (const turn of this.#turns.values()) {
      if (turn.last <= before) turn.wake ??= now;
    }
    this.#checked = now;
  }

  items(canvas: CanvasId): NeedsItem[] {
    return [...this.#turns.values()].flatMap((turn): NeedsItem[] =>
      turn.canvas === canvas && turn.stalled
        ? [
            {
              id: `stalled/${encodeURIComponent(turn.agent)}`,
              canvas,
              agent: turn.agent,
              kind: 'prompt',
              for: 'you',
              by: ['you'],
              title: turn.text,
              choices: [{ value: 'interrupt', label: 'Interrupt' }],
              answerIn: 'api',
            },
          ]
        : [],
    );
  }

  close(): void {
    this.#closed = true;
    this.#cancel();
    this.#turns.clear();
  }

  #arm(): void {
    this.#cancel = this.#clock.later(() => {
      if (this.#closed) return;
      const now = this.#clock.now();
      // Check the jump before the deadline: waking must never immediately declare a stall.
      if (now - this.#checked > WAKE_GAP_MS) this.#woke(now - WAKE_GAP_MS);
      this.#checked = now;
      for (const turn of this.#turns.values()) {
        const due = turn.wake === undefined ? turn.last + STALL_MS : turn.wake + WAKE_GRACE_MS;
        if (now < due || turn.stalled) continue;
        const cli = connectionIn(this.#deps.catalog, turn.connection)?.adapter.name ?? 'the agent';
        const silence = turn.wake === undefined ? '20 minutes' : '2 minutes after waking';
        turn.text = `No activity from ${cli} for ${silence}: its connection may have dropped. Interrupt to stop the turn.`;
        turn.stalled = true;
        this.#deps.changed(turn.canvas);
        if (!turn.notified) {
          turn.notified = true;
          this.#deps.warning(
            turn.canvas,
            turn.agent,
            turn.connection,
            [...turn.messages],
            turn.text,
          );
        }
      }
      this.#arm();
    }, WATCH_EVERY_MS);
  }
}

function keyOf(canvas: CanvasId, agent: string): string {
  return JSON.stringify([canvas, agent]);
}
