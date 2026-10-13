import { describe, expect, it } from 'vitest';

import type { GraphNode } from '../graph/graph';
import type { QueueItem, QueueRepeat, RepeatedItem } from '../graph/queue';
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

  describe('OKs', () => {
    const ok = (id = 'ok', approve = 'the spec in SPEC.md'): QueueItem => ({ id, approve });

    it('holds a queue at an OK, asking the user, and goes on once they approve', () => {
      const a = agent('a', [
        { id: 'spec', message: 'Write SPEC.md' },
        ok(),
        { id: 'plan', action: 'Read' },
      ]);
      const b = agent('b', [
        { id: 'w', waitFor: [{ agent: 'a', item: 'ok' }] },
        { id: 'build', action: 'Edit' },
      ]);
      let draws = 0;
      const { store, tick, advance, reply, where } = setup([a, b], () => {
        draws += 1;
        return 0.9;
      });
      store.start();
      reply('a');
      expect(where()).toEqual({ a: 'asking ok', b: 'waiting w' });
      expect(store.snapshot().running).toBe(true);
      // Only the user moves it on: not time, and not chance.
      advance(60 * MINUTE);
      tick();
      expect(where()).toEqual({ a: 'asking ok', b: 'waiting w' });
      expect(draws).toBe(0);

      store.decide('a', 'ok', { choice: 'approve' });
      expect(store.snapshot().agents.a?.outcomes.ok).toBe('succeeded');
      // The wait for it goes on in the same settle.
      expect(where()).toEqual({ a: 'running plan', b: 'running build' });
      expect(store.snapshot().agents.b?.outcomes.w).toBe('succeeded');
    });

    it('passes over an approved OK: an If after it checks the task before it', () => {
      // The tests fail (chance under a quarter).
      const a = agent('a', [
        { id: 'tests', action: 'Bash' },
        ok('ok', ''),
        { id: 'broken', if: { kind: 'failed' }, then: [{ id: 'fix', action: 'Edit' }] },
      ]);
      let draws = 0;
      const { store, tick, where } = setup([a], () => (draws++ === 0 ? 0.1 : 0.9));
      store.start();
      tick();
      expect(where()).toEqual({ a: 'asking ok' });
      store.decide('a', 'ok', { choice: 'approve' });
      expect(where()).toEqual({ a: 'running fix' });
    });

    it('sends the changes asked for to the queue’s own agent, then asks again', () => {
      const a = agent('a', [{ id: 'build', action: 'Edit' }, ok(), { id: 'next', action: 'Read' }]);
      const b = agent('b', [{ id: 'w', waitFor: [{ agent: 'a', item: 'ok' }] }]);
      const { store, tick, reply, where, sent } = setup([a, b]);
      store.start();
      tick();
      expect(where()).toEqual({ a: 'asking ok', b: 'waiting w' });

      store.decide('a', 'ok', { reply: '  Cover the empty state too \n' });
      expect(sent.map((s) => [s.agent, s.text])).toEqual([['a', 'Cover the empty state too']]);
      expect(where()).toEqual({ a: 'running ok', b: 'waiting w' });
      expect(store.snapshot().agents.a?.changes).toEqual({ ok: ['Cover the empty state too'] });
      // While the agent works on them, the OK is not asked: a decision now is ignored.
      store.decide('a', 'ok', { choice: 'approve' });
      expect(where()).toEqual({ a: 'running ok', b: 'waiting w' });

      reply('a');
      expect(where()).toEqual({ a: 'asking ok', b: 'waiting w' });
      expect(store.snapshot().agents.a?.outcomes.ok).toBeUndefined();
      // An interrupted turn asks again too.
      store.decide('a', 'ok', { reply: 'And the error state' });
      reply('a', true);
      expect(where()).toEqual({ a: 'asking ok', b: 'waiting w' });
      expect(store.snapshot().agents.a?.changes).toEqual({
        ok: ['Cover the empty state too', 'And the error state'],
      });
      // An empty note asks for nothing.
      store.decide('a', 'ok', { reply: '   ' });
      expect(sent).toHaveLength(2);
      expect(where()).toEqual({ a: 'asking ok', b: 'waiting w' });
    });

    it('stops the queue at an OK, and whatever waits on it or on what comes after it', () => {
      const a = agent('a', [
        { id: 'first', action: 'Read' },
        ok(),
        { id: 'after', action: 'Edit' },
      ]);
      const queues = [
        a,
        // Waits for the OK, for a later step, and (with a time limit) for all of a's work.
        agent('onOk', [
          { id: 'w', waitFor: [{ agent: 'a', item: 'ok' }] },
          { id: 'more', action: 'Read' },
        ]),
        agent('onLater', [{ id: 'w', waitFor: [{ agent: 'a', item: 'after' }] }]),
        agent('onAll', [{ id: 'w', waitFor: [{ agent: 'a' }], timeout: { seconds: 600 } }]),
        // Down a chain: a wait for what comes after a stopped wait.
        agent('chain', [{ id: 'w', waitFor: [{ agent: 'onOk', item: 'more' }] }]),
        // A join naming the OK, beside a wait for a step before it, which goes on.
        agent('join', [
          {
            id: 'w',
            waitFor: [
              { agent: 'before', item: 'x' },
              { agent: 'a', item: 'ok' },
            ],
          },
        ]),
        agent('before', [
          { id: 'x', waitFor: [{ agent: 'a', item: 'first' }] },
          { id: 'y', action: 'Bash' },
        ]),
        agent('other', [{ id: 'own', action: 'Grep' }]),
      ];
      const { store, tick, advance, where, pending } = setup(queues);
      store.start();
      tick();
      expect(where()).toMatchObject({ a: 'asking ok', before: 'running y', other: 'done' });

      store.decide('a', 'ok', { choice: 'stop' });
      expect(store.snapshot().agents.a?.outcomes.ok).toBe('stopped');
      expect(where()).toEqual({
        a: 'stopped ok',
        onOk: 'stopped w',
        onLater: 'stopped w',
        onAll: 'stopped w',
        chain: 'stopped w',
        join: 'stopped w',
        before: 'running y',
        other: 'done',
      });
      expect(store.snapshot().running).toBe(true);
      tick();
      expect(where()).toMatchObject({ a: 'stopped ok', before: 'done', onAll: 'stopped w' });
      // Stopped queues keep no run going, and a stop wins over a time limit.
      expect(store.snapshot().running).toBe(false);
      expect(pending()).toBe(0);
      advance(60 * MINUTE);
      expect(where()).toMatchObject({ a: 'stopped ok', onAll: 'stopped w' });
      expect(store.snapshot().agents.a?.outcomes.after).toBeUndefined();
    });

    it('ignores a decision before the run, for another item, twice, or after Stop', () => {
      const a = agent('a', [ok('one'), ok('two'), { id: 'next', action: 'Read' }]);
      const { store, reply, where, sent } = setup([a]);
      store.decide('a', 'one', { choice: 'approve' });
      store.start();
      expect(where()).toEqual({ a: 'asking one' });
      store.decide('a', 'two', { choice: 'approve' });
      store.decide('b', 'one', { choice: 'approve' });
      expect(where()).toEqual({ a: 'asking one' });
      store.decide('a', 'one', { choice: 'approve' });
      // A second click, meant for the OK that was answered, is not taken for the next one.
      store.decide('a', 'one', { choice: 'stop' });
      expect(where()).toEqual({ a: 'asking two' });

      // The run's Stop: a changes turn under way plays on in its session, but is not waited for.
      store.decide('a', 'two', { reply: 'Smaller steps' });
      store.stop();
      reply('a');
      store.decide('a', 'two', { choice: 'approve' });
      expect(store.snapshot().running).toBe(false);
      expect(where()).toEqual({ a: 'running two' });
      expect(sent).toHaveLength(1);

      // Run again: from the top, nothing approved or asked for.
      store.start();
      expect(where()).toEqual({ a: 'asking one' });
      expect(store.snapshot().agents.a?.changes).toBeUndefined();
    });

    it('goes on past a held OK that is removed, before or during its changes turn', () => {
      const next: QueueItem = { id: 'next', action: 'Read' };
      const { store, reply, where, edit } = setup([agent('a', [ok(), next])]);
      store.start();
      edit([agent('a', [next])]);
      expect(where()).toEqual({ a: 'running next' });

      edit([agent('a', [ok(), next])]);
      store.start();
      store.decide('a', 'ok', { reply: 'One more test' });
      edit([agent('a', [next])]);
      expect(where()).toEqual({ a: 'running ok' });
      reply('a');
      expect(where()).toEqual({ a: 'running next' });
    });

    it('runs first the item a held OK is dragged below', () => {
      const next: QueueItem = { id: 'next', action: 'Read' };
      const { store, tick, where, edit } = setup([agent('a', [ok(), next])]);
      store.start();
      edit([agent('a', [next, ok()])]);
      expect(where()).toEqual({ a: 'running next' });
      tick();
      expect(where()).toEqual({ a: 'asking ok' });
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

  describe('repeats', () => {
    const loop = (
      repeat: RepeatedItem[],
      more: Partial<Omit<QueueRepeat, 'id' | 'repeat'>> = {},
    ): QueueRepeat => ({
      id: 'loop',
      repeat,
      until: { kind: 'succeeded' },
      rounds: 3,
      otherwise: 'ask',
      ...more,
    });
    const fix: RepeatedItem = { id: 'fix', message: 'Make the tests pass' };
    const tests: RepeatedItem = { id: 'tests', action: 'Bash' };
    const next: QueueItem = { id: 'next', action: 'Read' };
    /** Chance as listed, then 0.9: a step fails under a quarter, a condition holds under a half. */
    const draws =
      (...values: number[]) =>
      () =>
        values.shift() ?? 0.9;

    it('runs its steps in rounds until its last step succeeds, then goes on', () => {
      // The tests fail in the first round, and pass in the second.
      const { store, tick, reply, where, sent } = setup(
        [agent('a', [loop([fix, tests]), next])],
        draws(0.1),
      );
      store.start();
      expect(where()).toEqual({ a: 'running fix' });
      expect(store.snapshot().agents.a?.rounds).toEqual({ loop: { round: 1 } });
      reply('a');
      tick();
      // Round 2: the round's outcomes are cleared, and the message is sent again.
      expect(where()).toEqual({ a: 'running fix' });
      expect(store.snapshot().agents.a?.rounds).toEqual({ loop: { round: 2 } });
      expect(store.snapshot().agents.a?.outcomes).toEqual({});
      expect(sent.map((s) => s.text)).toEqual(['Make the tests pass', 'Make the tests pass']);
      reply('a');
      tick();
      expect(where()).toEqual({ a: 'running next' });
      expect(store.snapshot().agents.a?.outcomes).toEqual({
        fix: 'succeeded',
        tests: 'succeeded',
        loop: 'succeeded',
      });
      expect(store.snapshot().agents.a?.rounds).toEqual({ loop: { round: 2 } });
    });

    it('judges its last step passing over a skipped last task and a delay', () => {
      const a = agent('a', [
        loop([tests, { id: 'note', message: '' }, { id: 'pause', delay: { seconds: 60 } }]),
        next,
      ]);
      const { store, tick, advance, where } = setup([a]);
      store.start();
      tick();
      tick();
      expect(where()).toEqual({ a: 'waiting pause' });
      advance(MINUTE);
      expect(where()).toEqual({ a: 'running next' });
      expect(store.snapshot().agents.a?.outcomes).toMatchObject({
        tests: 'succeeded',
        note: 'skipped',
        loop: 'succeeded',
      });
    });

    it('goes on having failed when out of rounds, then go on: an If after it can escalate', () => {
      const a = agent('a', [
        loop([tests], { rounds: 2, otherwise: 'goOn' }),
        { id: 'stuck', if: { kind: 'failed' }, then: [{ id: 'help', message: 'Ask for help' }] },
      ]);
      // The tests always fail.
      const { store, tick, where } = setup([a], () => 0.1);
      store.start();
      tick();
      expect(store.snapshot().agents.a?.rounds).toEqual({ loop: { round: 2 } });
      tick();
      expect(where()).toEqual({ a: 'running help' });
      expect(store.snapshot().agents.a?.outcomes.loop).toBe('failed');
    });

    describe('out of rounds, it asks the user', () => {
      const build: RepeatedItem = { id: 'build', message: 'Build it' };
      const approved = loop([build], {
        until: { kind: 'outputContains', text: 'APPROVED' },
        rounds: 1,
      });

      it('one more round, what to try next, or to go on', () => {
        // The output never contains it (chance over a half).
        const { store, reply, where, sent } = setup([agent('a', [approved, next])]);
        store.start();
        reply('a');
        expect(where()).toEqual({ a: 'asking loop' });
        expect(store.snapshot().running).toBe(true);

        store.decide('a', 'loop', { choice: 'more' });
        expect(where()).toEqual({ a: 'running build' });
        expect(store.snapshot().agents.a?.rounds).toEqual({ loop: { round: 2, more: 1 } });
        // A second click, meant for the ask that was answered, does nothing.
        store.decide('a', 'loop', { choice: 'more' });
        reply('a');
        expect(where()).toEqual({ a: 'asking loop' });

        // What to try next goes to the agent before the extra round's message.
        store.decide('a', 'loop', { reply: '  Try smaller steps ' });
        expect(where()).toEqual({ a: 'running build' });
        expect(sent.map((s) => s.text)).toEqual([
          'Build it',
          'Build it',
          'Try smaller steps',
          'Build it',
        ]);
        expect(store.snapshot().agents.a?.rounds).toEqual({ loop: { round: 3, more: 2 } });
        reply('a');

        // An empty reply, an OK's answer, or another item: nothing.
        store.decide('a', 'loop', { reply: '   ' });
        store.decide('a', 'loop', { choice: 'approve' });
        store.decide('a', 'next', { choice: 'goOn' });
        expect(where()).toEqual({ a: 'asking loop' });

        store.decide('a', 'loop', { choice: 'goOn' });
        expect(where()).toEqual({ a: 'running next' });
        expect(store.snapshot().agents.a?.outcomes.loop).toBe('failed');
        store.decide('a', 'loop', { choice: 'more' });
        expect(where()).toEqual({ a: 'running next' });
      });

      it('runs another round when its rounds are raised, and goes on when told to go on', () => {
        const queue = (repeat: QueueRepeat) => [agent('a', [repeat, next])];
        const { store, reply, where, edit } = setup(queue(approved));
        store.start();
        reply('a');
        expect(where()).toEqual({ a: 'asking loop' });
        edit(queue({ ...approved, rounds: 2 }));
        expect(where()).toEqual({ a: 'running build' });
        reply('a');
        expect(where()).toEqual({ a: 'asking loop' });
        edit(queue({ ...approved, rounds: 2, otherwise: 'goOn' }));
        expect(where()).toEqual({ a: 'running next' });
        expect(store.snapshot().agents.a?.outcomes.loop).toBe('failed');
      });
    });

    it('moves past a repeat that is removed, and skips an empty one', () => {
      const pause: RepeatedItem = { id: 'pause', delay: { seconds: 600 } };
      const { store, where, edit } = setup([agent('a', [loop([pause]), next])]);
      store.start();
      expect(where()).toEqual({ a: 'waiting pause' });
      edit([agent('a', [next])]);
      expect(where()).toEqual({ a: 'running next' });

      edit([agent('a', [loop([]), next])]);
      store.start();
      expect(where()).toEqual({ a: 'running next' });
      expect(store.snapshot().agents.a?.outcomes.loop).toBe('skipped');
    });

    it('counts a delay inside it afresh each round, ends it on Go on now, and starts over on Run', () => {
      // The tests fail in the first round, and pass after.
      const a = agent('a', [loop([{ id: 'pause', delay: { seconds: 600 } }, tests]), next]);
      const { store, tick, advance, where } = setup([a], draws(0.1));
      store.start();
      expect(store.snapshot().agents.a?.until).toBe(10 * MINUTE);
      advance(10 * MINUTE);
      expect(where()).toEqual({ a: 'running tests' });
      tick();
      expect(where()).toEqual({ a: 'waiting pause' });
      expect(store.snapshot().agents.a?.until).toBe(20 * MINUTE);
      store.goOn('a', 'pause');
      expect(where()).toEqual({ a: 'running tests' });
      tick();
      expect(where()).toEqual({ a: 'running next' });
      tick();

      // Run again: from round 1, the delay counted from now.
      advance(MINUTE);
      store.start();
      expect(where()).toEqual({ a: 'waiting pause' });
      expect(store.snapshot().agents.a?.rounds).toEqual({ loop: { round: 1 } });
      expect(store.snapshot().agents.a?.until).toBe(21 * MINUTE);
    });
  });
});
