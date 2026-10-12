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

/**
 * A run over `nodes`, with time and sessions under the test's control: `tick()` fires the timers
 * due, `reply(agent)` ends the turn of the oldest message sent to that agent.
 */
function setup(initial: GraphNode[], chance = () => 0.9) {
  let timers: (() => void)[] = [];
  const sent: { agent: string; text: string; done?: (failed: boolean) => void }[] = [];
  const store = new RunStore({
    send: (to, text, done) => {
      sent.push({ agent: to.id, text, ...(done ? { done } : {}) });
    },
    later: (run) => {
      timers.push(run);
      return () => {
        timers = timers.filter((t) => t !== run);
      };
    },
    chance,
  });
  store.update(initial);
  const tick = () => {
    const due = timers;
    timers = [];
    for (const run of due) run();
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
    reply,
    where,
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
});
