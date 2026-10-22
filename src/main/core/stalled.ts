import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';

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

/** A local OS snapshot, not a network request. Injectable alongside the watchdog's clock. */
export type WatchdogNetwork = () => ReturnType<typeof networkInterfaces>;

type Disruption = 'wake' | 'network';

interface Turn {
  canvas: CanvasId;
  agent: string;
  connection: ConnectionId;
  messages: Set<string>;
  last: number;
  grace?: { at: number; why: Disruption };
  notified: boolean;
  answered?: boolean;
  stalled: boolean;
  text: string;
}

interface Deps {
  catalog: Catalog;
  clock?: WatchdogClock;
  network?: WatchdogNetwork;
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
  readonly #network: WatchdogNetwork;
  #identity: string | undefined;
  #networkWarned = false;
  readonly #turns = new Map<string, Turn>();
  #checked: number;
  #cancel: () => void = () => undefined;
  #closed = false;

  constructor(deps: Deps) {
    this.#deps = deps;
    this.#network = deps.network ?? networkInterfaces;
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
    delete turn.grace;
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
    this.#disrupted(this.#clock.now(), 'wake');
    this.#checked = this.#clock.now();
  }

  #disrupted(before: number, why: Disruption): void {
    const now = this.#clock.now();
    for (const turn of this.#turns.values()) {
      if (turn.last <= before) turn.grace ??= { at: now, why };
    }
  }

  #checkNetwork(now: number): void {
    try {
      const value = networkIdentity(this.#network());
      const previous = this.#identity;
      this.#identity = value;
      if (previous !== undefined && previous !== value) {
        // The sampling time is the observed change: an event between samples may have come
        // before the link dropped. Only activity after this reading clears the shorter grace.
        this.#disrupted(now, 'network');
      }
    } catch (error) {
      // Keep the last good baseline. A failed read neither means a change nor a recovery.
      if (!this.#networkWarned) {
        this.#networkWarned = true;
        console.error(
          'Could not check the network for silent turns:',
          error instanceof Error ? error.message : String(error),
        );
      }
    }
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
              choices: [
                { value: 'interrupt', label: 'Interrupt' },
                { value: 'resend', label: 'Interrupt and resend' },
              ],
              answerIn: 'api',
            },
          ]
        : [],
    );
  }

  /** One answer belongs to this turn, even while its interrupt still awaits an end. */
  take(
    canvas: CanvasId,
    agent: string,
  ):
    | { messages: string[]; connection: ConnectionId; current: () => boolean; release: () => void }
    | undefined {
    const turn = this.#turns.get(keyOf(canvas, agent));
    if (!turn?.stalled || turn.answered) return undefined;
    turn.answered = true;
    turn.stalled = false;
    this.#deps.changed(canvas);
    const current = () => this.#turns.get(keyOf(canvas, agent)) === turn;
    const last = turn.last;
    return {
      messages: [...turn.messages],
      connection: turn.connection,
      current,
      release: () => {
        if (!current()) return;
        turn.answered = false;
        turn.stalled = turn.last === last;
        this.#deps.changed(canvas);
      },
    };
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
      // Prefer the network wording if both are first observed on this tick, without extending
      // grace already granted by an earlier wake or network change.
      this.#checkNetwork(now);
      // Check the jump before the deadline: waking must never immediately declare a stall.
      if (now - this.#checked > WAKE_GAP_MS) this.#disrupted(now - WAKE_GAP_MS, 'wake');
      this.#checked = now;
      for (const turn of this.#turns.values()) {
        const due = turn.grace === undefined ? turn.last + STALL_MS : turn.grace.at + WAKE_GRACE_MS;
        if (now < due || turn.stalled || turn.answered) continue;
        const cli = connectionIn(this.#deps.catalog, turn.connection)?.adapter.name ?? 'the agent';
        const silence =
          turn.grace === undefined
            ? '20 minutes'
            : turn.grace.why === 'wake'
              ? '2 minutes after waking'
              : '2 minutes after the network changed';
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

/** Ignore address order, IPv6 privacy suffixes and link-local-only interfaces. */
function networkIdentity(interfaces: ReturnType<WatchdogNetwork>): string {
  const identity = new Set<string>();
  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const info of addresses ?? []) {
      if (info.internal) continue;
      if (info.family === 'IPv4' && isIP(info.address) === 4) {
        identity.add(JSON.stringify([name, 'IPv4', info.address]));
      } else if (info.family === 'IPv6') {
        const prefix = ipv6Prefix(info.address);
        if (prefix !== undefined) identity.add(JSON.stringify([name, 'IPv6', prefix]));
      }
    }
  }
  return JSON.stringify([...identity].sort());
}

function ipv6Prefix(address: string): string | undefined {
  let ip = address.split('%')[0] ?? '';
  if (isIP(ip) !== 6) return undefined;
  // An embedded IPv4 suffix occupies two hextets, not one.
  if (ip.includes('.')) {
    const colon = ip.lastIndexOf(':');
    const bytes = ip
      .slice(colon + 1)
      .split('.')
      .map(Number);
    const [a = 0, b = 0, c = 0, d = 0] = bytes;
    ip = `${ip.slice(0, colon + 1)}${(a * 256 + b).toString(16)}:${(c * 256 + d).toString(16)}`;
  }
  const [head = '', tail] = ip.split('::');
  const left = head === '' ? [] : head.split(':');
  const right = tail === undefined || tail === '' ? [] : tail.split(':');
  const groups =
    tail === undefined
      ? left
      : [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right];
  const prefix = groups.slice(0, 4).map((group) => Number.parseInt(group, 16));
  if (((prefix[0] ?? 0) & 0xffc0) === 0xfe80) return undefined;
  return prefix.map((group) => group.toString(16)).join(':');
}
