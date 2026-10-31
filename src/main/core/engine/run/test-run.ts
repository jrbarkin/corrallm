import type { UsageBackendId } from '../../../../shared/adapter';
import type { CanvasNode } from '../../../../shared/model/canvas';
import { findItem } from '../../../../shared/model/queue';
import type { MessageImage, TurnResult } from '../../../../shared/session';
import type { UsageRule, UsageState, UsageWindows } from '../../../../shared/usage';
import { TEST_ENGINE } from '../test-engine';
import type { Refusal, RunIO, TurnEnd } from './runner';
import { liveRun } from './test-restore';

/*
 * For the run's tests: a run over a canvas's nodes, with its time and the turns its agents take
 * under the test's control (`setup`), on the catalog main declares (as the app gives it).
 */

const engine = TEST_ENGINE;

/** Explicit native turns stay under the test's control instead of the scripted callback fixture. */
export const manual = Symbol('manual turn callbacks');
export type FixtureResult = boolean | { succeeded: boolean; reply: string };

/**
 * A run over `nodes`, with time and sessions under the test's control: `tick()` fires every timer
 * set and pending native fixture callbacks without moving the clock. `advance(ms)` moves the clock, firing run timers
 * due on the way, and `reply(agent)` ends the turn of the oldest message sent to that agent, as it
 * went (`failed`) with what the agent replied (`text`). A message the run took back is marked
 * `withdrawn`; what the run told the user in an agent's session is `told`.
 */
export function setup(
  initial: readonly CanvasNode[],
  results: typeof manual | (() => FixtureResult) = () => true,
  unheard: ReadonlySet<string> = new Set(),
  /** What else the run is given: B11a's admission and its note on a usage limit, say. */
  more: Pick<RunIO, 'admit' | 'limitNote'> = {},
) {
  let clock = 0;
  let timers: { run: () => void; at: number; native?: boolean }[] = [];
  /** How long each timer set was for. */
  const armed: number[] = [];
  const sent: {
    agent: string;
    text: string;
    images?: readonly MessageImage[];
    done?: (turn: TurnEnd) => void;
    refused?: (refusal: Refusal) => void;
    withdrawn: boolean;
    origin?: 'user';
  }[] = [];
  const told: [string, string][] = [];
  let usage: UsageState = { readings: [], rules: {} };
  const store = liveRun(engine, {
    send: (to, text, done, images, refused, origin) => {
      const message: (typeof sent)[number] = {
        agent: to.id,
        text,
        ...(images ? { images } : {}),
        done,
        ...(refused ? { refused } : {}),
        withdrawn: false,
        ...(origin === undefined ? {} : { origin }),
      };
      // Scheduler-only tests use deterministic native callbacks for implicit-default tool steps.
      // Explicitly connected fixtures and Message turns stay manual and appear in `sent`.
      const fixture =
        results !== manual && to.data.connection === undefined && text.startsWith('Use ');
      if (!fixture) sent.push(message);
      const timer = fixture
        ? {
            native: true,
            at: clock,
            run: () => {
              if (message.withdrawn) return;
              const result = results();
              const succeeded = typeof result === 'boolean' ? result : result.succeeded;
              const current = store.snapshot().agents[to.id]?.current;
              const item = findItem(to.data.queue ?? [], current ?? '')?.item;
              const expectsFailure = item !== undefined && 'expect' in item;
              const verdict = succeeded !== expectsFailure ? 'SUCCEEDED' : 'FAILED';
              done({
                failed: false,
                reply: `${typeof result === 'boolean' ? '' : result.reply}\n${verdict}`,
              });
              // These scheduler fixtures explicitly continue known failures; native recovery tests
              // below exercise the unresolved/inspection path with manual callbacks.
              const at = store.snapshot().agents[to.id];
              if (at?.problem?.kind === 'failed' && at.current)
                store.decide(to.id, at.current, { choice: 'continue' });
            },
          }
        : undefined;
      if (timer) timers.push(timer);
      return () => {
        message.withdrawn = true;
        if (timer) timers = timers.filter((queued) => queued !== timer);
      };
    },
    tell: (to, text) => {
      told.push([to.id, text]);
    },
    later: (run, ms) => {
      const timer = { run, at: clock + ms };
      timers.push(timer);
      armed.push(ms);
      return () => {
        timers = timers.filter((t) => t !== timer);
      };
    },
    now: () => clock,
    usage: () => usage,
    unheard: (to) => unheard.has(to.id),
    ...more,
  });
  store.update(initial);
  const tick = () => {
    const due = timers;
    timers = [];
    for (const timer of due) timer.run();
  };
  const advance = (ms: number) => {
    const until = clock + ms;
    for (;;) {
      const next = timers
        .filter((t) => !t.native && t.at <= until)
        .reduce<(typeof timers)[number] | undefined>(
          (a, t) => (a && a.at <= t.at ? a : t),
          undefined,
        );
      if (!next) break;
      timers = timers.filter((t) => t !== next);
      clock = Math.max(clock, next.at);
      next.run();
    }
    clock = until;
  };
  const reply = (to: string, failed = false, text = '', result?: TurnResult) => {
    const turn = sent.find((s) => s.agent === to && s.done);
    if (!turn?.done) throw new Error(`no turn for ${to}`);
    const { done } = turn;
    delete turn.done;
    done({ failed, reply: text, ...(result === undefined ? {} : { result }) });
  };
  /** Each agent's task (or `done`), and whether it runs it or waits. */
  const where = () =>
    Object.fromEntries(
      Object.entries(store.snapshot().agents).map(([id, run]) => [
        id,
        run.status === 'done' ? 'done' : `${run.status} ${String(run.current)}`,
      ]),
    );
  return {
    store,
    sent,
    told,
    tick,
    advance,
    reply,
    where,
    armed,
    /** How many timers are set. */
    pending: () => timers.length,
    edit: (next: readonly CanvasNode[]) => {
      store.update(next);
    },
    /** The time now on the run's clock. */
    now: () => clock,
    /** Main tells a new reading of a backend's usage (read now; Claude's unless said), or a rule. */
    reading: (windows: UsageWindows | null, backend: UsageBackendId = 'claude-code') => {
      const others = usage.readings.filter((r) => r.backend !== backend);
      usage = {
        ...usage,
        readings: [...others, ...(windows ? [{ backend, windows, at: clock }] : [])],
      };
      store.usageChanged();
    },
    rule: (rule: UsageRule | null, backend: UsageBackendId = 'claude-code') => {
      const rules = { ...usage.rules };
      if (rule) rules[backend] = rule;
      else Reflect.deleteProperty(rules, backend);
      usage = { ...usage, rules };
      store.usageChanged();
    },
  };
}
