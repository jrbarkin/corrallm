import { describe, expect, it } from 'vitest';

import type { GraphNode } from '../graph/graph';
import type { QueueItem } from '../graph/queue';
import { RunStore } from './runner';

const agent = (id: string, queue: QueueItem[] = []): GraphNode => ({
  id,
  type: 'agent',
  position: { x: 0, y: 0 },
  data: { label: id, queue },
});

const MINUTE = 60_000;

/**
 * A run over `nodes`, with time and sessions under the test's control: `tick()` fires every timer
 * set (steps finish) without moving the clock, `advance(ms)` moves the clock, firing the timers
 * due on the way, and `reply(agent)` ends the turn of the oldest message sent to that agent.
 */
function setup(initial: GraphNode[], chance = () => 0.9) {
  let clock = 0;
  let timers: { run: () => void; at: number }[] = [];
  /** How long each timer set was for. */
  const armed: number[] = [];
  const sent: { agent: string; text: string; done?: (failed: boolean) => void }[] = [];
  const store = new RunStore({
    send: (to, text, done) => {
      sent.push({ agent: to.id, text, ...(done ? { done } : {}) });
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
    chance,
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
        .filter((t) => t.at <= until)
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
  const reply = (to: string, failed = false) => {
    const turn = sent.find((s) => s.agent === to && s.done);
    if (!turn?.done) throw new Error(`no turn for ${to}`);
    const { done } = turn;
    delete turn.done;
    done(failed);
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
    tick,
    advance,
    reply,
    where,
    armed,
    /** How many timers are set. */
    pending: () => timers.length,
    edit: (next: GraphNode[]) => {
      store.update(next);
    },
  };
}

describe('RunStore', () => {
  it('runs each queue in order, a wait holding until what it waits for is done', () => {
    const a = agent('a', [
      { id: 'research', action: 'Workflow' },
      { id: 'notes', message: 'Write it up' },
    ]);
    const b = agent('b', [
      { id: 'w', waitFor: [{ agent: 'a', item: 'research' }] },
      { id: 'build', action: 'Edit' },
      { id: 'all', waitFor: [{ agent: 'a' }] },
    ]);
    const { store, tick, reply, where, sent } = setup([a, b]);
    store.start();
    expect(store.snapshot().running).toBe(true);
    expect(where()).toEqual({ a: 'running research', b: 'waiting w' });

    tick(); // a's Workflow is done: its message goes to its session, and b goes on.
    expect(where()).toEqual({ a: 'running notes', b: 'running build' });
    expect(sent.map((s) => [s.agent, s.text])).toEqual([['a', 'Write it up']]);

    tick(); // b's Edit is done; a is still on its message, until its turn ends.
    expect(where()).toEqual({ a: 'running notes', b: 'waiting all' });
    reply('a');
    expect(where()).toEqual({ a: 'done', b: 'done' });
    expect(store.snapshot().agents.a?.outcomes).toEqual({
      research: 'succeeded',
      notes: 'succeeded',
    });
    expect(store.snapshot().running).toBe(false);
  });

  it('hands a message aimed at another agent to that agent’s session', () => {
    const a = agent('a', [{ id: 'hand', message: 'Over to you', target: 'b' }]);
    const b = agent('b');
    const { store, tick, where, sent } = setup([a, b]);
    store.start();
    expect(sent.map((s) => [s.agent, s.text])).toEqual([['b', 'Over to you']]);
    expect(where()).toEqual({ a: 'running hand', b: 'done' });
    tick();
    expect(where()).toEqual({ a: 'done', b: 'done' });
  });

  it('runs an if-then’s steps only when its condition holds of the step before', () => {
    const queue = (id: string): QueueItem[] => [
      { id: 'tests', action: 'Bash' },
      {
        id: 'failing',
        if: { kind: 'failed' },
        then: [{ id: `fix-${id}`, message: 'Fix the tests' }],
      },
      { id: 'after', action: 'Read' },
    ];
    // The tests fail (chance under a quarter) for a, and pass for b.
    let draws = 0;
    const { store, tick, reply, where } = setup(
      [agent('a', queue('a')), agent('b', queue('b'))],
      () => (draws++ === 0 ? 0.1 : 0.9),
    );
    store.start();
    tick();
    expect(where()).toEqual({ a: 'running fix-a', b: 'running after' });
    expect(store.snapshot().agents.b?.outcomes.failing).toBe('skipped');
    reply('a');
    tick();
    expect(where()).toEqual({ a: 'done', b: 'done' });
    expect(store.snapshot().agents.a?.outcomes).toEqual({
      tests: 'failed',
      'fix-a': 'succeeded',
      failing: 'succeeded',
      after: 'succeeded',
    });
  });

  it('leaves waits that wait on each other waiting, and stops when asked', () => {
    const a = agent('a', [{ id: 'w', waitFor: [{ agent: 'b', item: 'w' }] }]);
    const b = agent('b', [
      { id: 'w', waitFor: [{ agent: 'a', item: 'w' }] },
      { id: 'never', action: 'Edit' },
    ]);
    const c = agent('c', [{ id: 'slow', action: 'Read' }]);
    const { store, tick, where } = setup([a, b, c]);
    store.start();
    expect(where()).toEqual({ a: 'waiting w', b: 'waiting w', c: 'running slow' });
    store.stop();
    tick(); // c's step was cancelled: nothing moves.
    expect(store.snapshot().running).toBe(false);
    expect(where()).toEqual({ a: 'waiting w', b: 'waiting w', c: 'running slow' });
    store.reset();
    expect(store.snapshot()).toEqual({ running: false, agents: {} });
  });

  it('follows the queues as they change: a removed step no longer holds, new work is run', () => {
    const a = (queue: QueueItem[]) => agent('a', queue);
    const one: QueueItem = { id: 'one', action: 'Read' };
    const two: QueueItem = { id: 'two', action: 'Grep' };
    const b = agent('b', [
      { id: 'w', waitFor: [{ agent: 'a', item: 'two' }] },
      { id: 'next', message: 'Go on' },
    ]);
    const { store, tick, reply, where, edit } = setup([a([one, two]), b]);
    store.start();
    expect(where()).toEqual({ a: 'running one', b: 'waiting w' });
    // The step b waits for is removed: b has nothing left to wait for.
    edit([a([one]), b]);
    expect(where()).toEqual({ a: 'running one', b: 'running next' });
    tick();
    expect(where()).toEqual({ a: 'done', b: 'running next' });
    // Work added for an agent that had finished is run, while the run goes on.
    edit([a([one, { id: 'more', action: 'Bash' }]), b]);
    expect(where()).toEqual({ a: 'running more', b: 'running next' });
    reply('b');
    tick();
    expect(where()).toEqual({ a: 'done', b: 'done' });
    expect(store.snapshot().running).toBe(false);
  });

  describe('delays', () => {
    it('holds an agent until its time has come, the If after it checking the step before', () => {
      // The Edit fails (chance under a quarter); so "If the previous step failed" holds after the delay.
      const a = agent('a', [
        { id: 'build', action: 'Edit' },
        { id: 'pause', delay: { seconds: 600 } },
        { id: 'broken', if: { kind: 'failed' }, then: [{ id: 'fix', action: 'Edit' }] },
      ]);
      let draws = 0;
      const { store, tick, advance, where } = setup([a], () => (draws++ === 0 ? 0.1 : 0.9));
      store.start();
      tick();
      expect(where()).toEqual({ a: 'waiting pause' });
      expect(store.snapshot().agents.a?.until).toBe(10 * MINUTE);
      expect(store.snapshot().running).toBe(true);
      advance(10 * MINUTE - 1);
      expect(where()).toEqual({ a: 'waiting pause' });
      advance(1);
      expect(where()).toEqual({ a: 'running fix' });
      expect(store.snapshot().agents.a?.outcomes).toMatchObject({
        build: 'failed',
        pause: 'succeeded',
      });
      expect(store.snapshot().agents.a?.until).toBeUndefined();
    });

    it('waits until a time of day', () => {
      const a = agent('a', [
        { id: 'morning', delay: { at: '09:00' } },
        { id: 'next', action: 'Read' },
      ]);
      const { store, advance, where } = setup([a]);
      store.start();
      const until = store.snapshot().agents.a?.until ?? 0;
      expect(new Date(until).getHours()).toBe(9);
      expect(new Date(until).getMinutes()).toBe(0);
      advance(until - 1);
      expect(where()).toEqual({ a: 'waiting morning' });
      advance(1);
      expect(where()).toEqual({ a: 'running next' });
    });

    it('re-checks the clock at least once a minute, so no timer is set for longer', () => {
      const a = agent('a', [
        { id: 'pause', delay: { seconds: 3600 } },
        { id: 'next', action: 'Read' },
      ]);
      const { store, advance, where, armed } = setup([a]);
      store.start();
      advance(60 * MINUTE - 1);
      expect(where()).toEqual({ a: 'waiting pause' });
      advance(1);
      expect(where()).toEqual({ a: 'running next' });
      expect(Math.max(...armed)).toBeLessThanOrEqual(MINUTE);
    });
  });

  describe('time limits on waits', () => {
    const queues = () => [
      agent('a', [{ id: 'slow', message: 'Take your time' }]),
      agent('b', [
        { id: 'w', waitFor: [{ agent: 'a' }], timeout: { seconds: 1800 } },
        {
          id: 'late',
          if: { kind: 'timedOut' },
          then: [{ id: 'nudge', message: 'Wrap up', target: 'a' }],
        },
        { id: 'after', action: 'Read' },
      ]),
    ];

    it('goes on without what it waits for once its limit passes: the wait ran out of time', () => {
      const { store, advance, where, sent } = setup(queues());
      store.start();
      expect(where()).toEqual({ a: 'running slow', b: 'waiting w' });
      expect(store.snapshot().agents.b?.until).toBe(30 * MINUTE);
      advance(30 * MINUTE - 1);
      expect(where()).toEqual({ a: 'running slow', b: 'waiting w' });
      advance(1);
      expect(where()).toEqual({ a: 'running slow', b: 'running nudge' });
      expect(store.snapshot().agents.b?.outcomes.w).toBe('timedOut');
      // The agent waited for is not interrupted: the nudge is a message to it.
      expect(sent.map((s) => [s.agent, s.text])).toEqual([
        ['a', 'Take your time'],
        ['a', 'Wrap up'],
      ]);
    });

    it('succeeds, and the If after it is skipped, when what it waits for is done in time', () => {
      const { store, tick, advance, reply, where } = setup(queues());
      store.start();
      advance(10 * MINUTE);
      reply('a');
      expect(where()).toEqual({ a: 'done', b: 'running after' });
      expect(store.snapshot().agents.b?.outcomes).toMatchObject({
        w: 'succeeded',
        late: 'skipped',
      });
      tick();
      expect(where()).toEqual({ a: 'done', b: 'done' });
    });
  });

  it('fails a wait for a step that failed, or for an agent whose last task that ran failed', () => {
    // a's tests fail (chance under a quarter); its empty message after them is skipped.
    const retry = (id: string): QueueItem => ({
      id: 'retry',
      if: { kind: 'failed' },
      then: [{ id, action: 'Edit' }],
    });
    const a = agent('a', [
      { id: 'tests', action: 'Bash' },
      { id: 'note', message: '' },
    ]);
    const b = agent('b', [{ id: 'w', waitFor: [{ agent: 'a', item: 'tests' }] }, retry('fix-b')]);
    const c = agent('c', [{ id: 'w', waitFor: [{ agent: 'a' }] }, retry('fix-c')]);
    let draws = 0;
    const { store, tick, where } = setup([a, b, c], () => (draws++ === 0 ? 0.1 : 0.9));
    store.start();
    tick();
    expect(where()).toEqual({ a: 'running note', b: 'running fix-b', c: 'waiting w' });
    tick();
    expect(where()).toEqual({ a: 'done', b: 'done', c: 'running fix-c' });
    expect(store.snapshot().agents.a?.outcomes).toEqual({ tests: 'failed', note: 'skipped' });
    expect(store.snapshot().agents.b?.outcomes.w).toBe('failed');
    expect(store.snapshot().agents.c?.outcomes.w).toBe('failed');
  });

  describe('Go on now', () => {
    it('ends a held delay as done, and a held wait as run out of time, freeing a loop', () => {
      const a = agent('a', [
        { id: 'pause', delay: { seconds: 600 } },
        { id: 'w', waitFor: [{ agent: 'b', item: 'w' }] },
        { id: 'late', if: { kind: 'timedOut' }, then: [{ id: 'note', message: '' }] },
      ]);
      const b = agent('b', [
        { id: 'w', waitFor: [{ agent: 'a', item: 'w' }] },
        { id: 'next', action: 'Read' },
      ]);
      const { store, where } = setup([a, b]);
      store.start();
      expect(where()).toEqual({ a: 'waiting pause', b: 'waiting w' });
      store.goOn('a', 'pause');
      expect(store.snapshot().agents.a?.outcomes.pause).toBe('succeeded');
      expect(where()).toEqual({ a: 'waiting w', b: 'waiting w' });
      // A plain wait in a loop of waits: Go on now is the way out.
      store.goOn('a', 'w');
      expect(store.snapshot().agents.a?.outcomes.w).toBe('timedOut');
      expect(where()).toEqual({ a: 'running note', b: 'running next' });
      expect(store.snapshot().agents.b?.outcomes.w).toBe('succeeded');
    });

    it('ignores a stale item, an agent not held, and a stopped run', () => {
      const a = agent('a', [
        { id: 'pause', delay: { seconds: 600 } },
        { id: 'next', action: 'Read' },
      ]);
      const b = agent('b', [{ id: 'busy', action: 'Edit' }]);
      const { store, where } = setup([a, b]);
      store.start();
      store.goOn('a', 'next');
      store.goOn('b', 'busy');
      expect(where()).toEqual({ a: 'waiting pause', b: 'running busy' });
      store.stop();
      store.goOn('a', 'pause');
      expect(store.snapshot().running).toBe(false);
      expect(where()).toEqual({ a: 'waiting pause', b: 'running busy' });
    });
  });

  describe('edits and timers', () => {
    const pause = (seconds: number): QueueItem => ({ id: 'pause', delay: { seconds } });
    const next: QueueItem = { id: 'next', action: 'Read' };

    it('counts a changed delay from when the agent reached it', () => {
      const { store, advance, where, edit } = setup([agent('a', [pause(600), next])]);
      store.start();
      advance(3 * MINUTE);
      edit([agent('a', [pause(300), next])]);
      expect(where()).toEqual({ a: 'waiting pause' });
      expect(store.snapshot().agents.a?.until).toBe(5 * MINUTE);
      edit([agent('a', [pause(120), next])]);
      expect(where()).toEqual({ a: 'running next' });
    });

    it('times a wait out at once when a limit added has already passed', () => {
      const a = agent('a', [{ id: 'slow', message: 'Take your time' }]);
      const wait = { id: 'w', waitFor: [{ agent: 'a' }] };
      const { store, advance, where, edit } = setup([a, agent('b', [wait, next])]);
      store.start();
      advance(5 * MINUTE);
      expect(store.snapshot().agents.b?.until).toBeUndefined();
      edit([a, agent('b', [{ ...wait, timeout: { seconds: 60 } }, next])]);
      expect(where()).toEqual({ a: 'running slow', b: 'running next' });
      expect(store.snapshot().agents.b?.outcomes.w).toBe('timedOut');
    });

    it('moves an agent on when the delay it is held at is removed', () => {
      const { store, where, edit } = setup([agent('a', [pause(600), next])]);
      store.start();
      edit([agent('a', [next])]);
      expect(where()).toEqual({ a: 'running next' });
    });

    it('leaves no timer set once stopped, and counts delays from zero when run again', () => {
      const a = agent('a', [pause(600), next]);
      const b = agent('b', [{ id: 'busy', action: 'Edit' }]);
      const { store, advance, where, pending } = setup([a, b]);
      store.start();
      advance(9 * MINUTE);
      store.stop();
      expect(pending()).toBe(0);
      store.start();
      expect(store.snapshot().agents.a?.until).toBe(19 * MINUTE);
      expect(where()).toEqual({ a: 'waiting pause', b: 'running busy' });
    });
  });
});
