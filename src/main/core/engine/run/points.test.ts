import { afterEach, describe, expect, it } from 'vitest';

import type { ConnectionId } from '../../../../shared/adapter';
import type { AgentNode } from '../../../../shared/model/canvas';
import type { QueueItem } from '../../../../shared/model/queue';
import type { RunPoints } from './runner';
import { expectRestorable } from './test-restore';
import { manual, setup } from './test-run';

/*
 * B19 C2, the run's half: the interpreter owns its delivery points. While its queue runs, an agent
 * is at one at an authored wait, in the gap before each of its queue's items but an If, and between
 * a repeat's rounds once the round's condition is decided; never just before an If, within an If's
 * steps or between a round's tasks. A delay, an OK, a task held for you and a condition waiting on
 * you hold a party's message. At each gap the run offers delivery the agent's next native turn,
 * synchronously (RunPoints.offer): taken, the queue waits until delivery releases its slot
 * (RunStore.release); and while delivery holds an agent's slot no task of the run's goes to it.
 */

afterEach(expectRestorable);

const agent = (
  id: string,
  queue: QueueItem[] = [],
  connection: ConnectionId = 'claude-code.terminal',
): AgentNode => ({
  id,
  type: 'agent',
  position: { x: 0, y: 0 },
  data: { label: id, adapter: connection.slice(0, connection.indexOf('.')), connection, queue },
});

/** Delivery's half as the test says: each gap offered, and whether it takes the next. */
function points() {
  const offered: [string, string][] = [];
  let takes = 0;
  const tokens: object[] = [];
  const seam: RunPoints = {
    offer: (to, gap, token) => {
      offered.push([to, gap]);
      if (takes === 0) return false;
      takes -= 1;
      tokens.push(token);
      return true;
    },
  };
  return {
    seam,
    offered,
    tokens,
    /** Delivery takes the next `n` gaps it is offered. */
    take: (n = 1) => {
      takes = n;
    },
  };
}

function world(queue: QueueItem[], box = points()) {
  const run = setup([agent('a', queue)], manual, new Set(), { points: box.seam });
  return { run, box, point: () => run.store.point('a') };
}

const one: QueueItem = { id: 'one', message: 'One' };
const two: QueueItem = { id: 'two', message: 'Two' };

describe('delivery points (B19 C2)', () => {
  it('offers the gap between two items, and the queue waits while delivery takes it', () => {
    const { run, box, point } = world([one, two]);
    run.store.start();
    expect(run.sent.map(({ text }) => text)).toEqual(['One']);
    // None before the queue's first item: no item went before it.
    expect(box.offered).toEqual([]);
    expect(point()).toEqual({ kind: 'protected' });
    box.take();
    run.reply('a');
    expect(box.offered).toEqual([['a', expect.stringContaining('"two"')]]);
    expect(run.where()).toEqual({ a: 'waiting two' });
    expect(run.sent).toHaveLength(1);
    expect(point()).toEqual({ kind: 'gap', gap: box.offered[0]?.[1] });
    // Released, it offers the same gap again: delivery may take what still waits from before it.
    run.store.release('a', box.tokens[0] ?? {});
    expect(box.offered[1]).toEqual(box.offered[0]);
    expect(run.sent.map(({ text }) => text)).toEqual(['One', 'Two']);
    expect(point()).toEqual({ kind: 'protected' });
  });

  it('goes on past a gap delivery took but had nothing to deliver in, never offering it again', () => {
    const { run, box } = world([one, two]);
    run.store.start();
    box.take();
    run.reply('a');
    expect(run.where()).toEqual({ a: 'waiting two' });
    run.store.release('a', box.tokens[0] ?? {}, true);
    expect(box.offered).toHaveLength(1);
    expect(run.sent.map(({ text }) => text)).toEqual(['One', 'Two']);
    // Its queue done, the agent's slot is free to take.
    run.reply('a');
    expect(run.store.reserve('a')).toBeDefined();
  });

  it('offers no gap before an If, within its steps or between consecutive Ifs, and the next after them', () => {
    const { run, box, point } = world([
      one,
      {
        id: 'first',
        if: { kind: 'succeeded' },
        then: [
          { id: 'x', message: 'X' },
          { id: 'y', message: 'Y' },
        ],
      },
      { id: 'second', if: { kind: 'failed' }, then: [{ id: 'z', message: 'Z' }] },
      two,
    ]);
    run.store.start();
    box.offered.length = 0;
    run.reply('a');
    expect(run.sent.map(({ text }) => text)).toEqual(['One', 'X']);
    expect(point()).toEqual({ kind: 'protected' });
    run.reply('a');
    expect(run.sent.map(({ text }) => text)).toEqual(['One', 'X', 'Y']);
    run.reply('a');
    // The second If was skipped: no gap before it, and the next is Two's.
    expect(box.offered).toEqual([['a', expect.stringContaining('"two"')]]);
    expect(run.sent.map(({ text }) => text)).toEqual(['One', 'X', 'Y', 'Two']);
  });

  it('offers no gap between a round’s tasks, and one between rounds once its condition is decided', () => {
    const { run, box } = world([
      {
        id: 'loop',
        repeat: [one, two],
        until: { kind: 'outputContains', text: 'DONE' },
        rounds: 3,
        otherwise: 'goOn',
      },
    ]);
    run.store.start();
    box.offered.length = 0;
    run.reply('a', false, 'first');
    expect(box.offered).toEqual([]);
    expect(run.sent.map(({ text }) => text)).toEqual(['One', 'Two']);
    box.take();
    run.reply('a', false, 'not yet');
    // The round's condition was decided: the gap before round 2 is offered, and taken.
    expect(box.offered).toEqual([['a', expect.stringContaining('"loop",2')]]);
    expect(run.where()).toEqual({ a: 'waiting one' });
    expect(run.store.point('a')).toMatchObject({ kind: 'gap' });
    run.store.release('a', box.tokens[0] ?? {});
    expect(run.sent.map(({ text }) => text)).toEqual(['One', 'Two', 'One']);
  });

  it('is open at an authored wait, and holds at a delay, an OK and a task held for you', () => {
    const wait = world([
      { id: 'w', waitFor: [{ agent: 'a', item: 'later' }] },
      { ...one, id: 'later' },
    ]);
    wait.run.store.start();
    expect(wait.point()).toEqual({ kind: 'open' });

    const delay = world([{ id: 'd', delay: { seconds: 300 } }, one]);
    delay.run.store.start();
    expect(delay.point()).toMatchObject({ kind: 'held', hold: 'delay' });

    const ok = world([{ id: 'ok', approve: '' }]);
    ok.run.store.start();
    expect(ok.point()).toMatchObject({ kind: 'held', hold: 'approval' });

    const failed = world([one, two]);
    failed.run.store.start();
    failed.run.reply('a', true);
    expect(failed.point()).toMatchObject({ kind: 'held', hold: 'problem' });

    const condition = world([
      one,
      { id: 'check', if: { kind: 'freeText', text: 'Is it done?' }, then: [two] },
    ]);
    condition.run.store.start();
    condition.run.reply('a');
    condition.run.reply('a', false, 'Maybe.');
    expect(condition.point()).toMatchObject({ kind: 'held', hold: 'condition' });
  });

  it('is open with no run going, once its queue is done, and once the run is stopped', () => {
    const { run, point } = world([one]);
    expect(point()).toEqual({ kind: 'open' });
    run.store.start();
    run.reply('a');
    expect(run.where()).toEqual({ a: 'done' });
    expect(point()).toEqual({ kind: 'open' });
    const stopped = world([one, two]);
    stopped.run.store.start();
    stopped.run.store.stop();
    expect(stopped.point()).toEqual({ kind: 'open' });
  });

  it('starts nothing of the run’s on an agent whose slot delivery holds, wherever its queue is', () => {
    const { run, point } = world([
      { id: 'w', waitFor: [{ agent: 'a', item: 'check' }], timeout: { seconds: 60 } },
      { id: 'check', if: { kind: 'timedOut' }, then: [two] },
    ]);
    run.store.start();
    expect(point()).toEqual({ kind: 'open' });
    // Delivery takes the agent's slot at its wait.
    const token = run.store.reserve('a');
    expect(token).toBeDefined();
    expect(run.store.reserve('a')).toBeUndefined();
    run.advance(60_000);
    // The wait ended; the If's step waits for the slot, and isn't a point of its own.
    expect(run.sent).toEqual([]);
    expect(run.where()).toEqual({ a: 'waiting two' });
    expect(point()).toEqual({ kind: 'protected' });
    run.store.release('a', token ?? {});
    expect(run.sent.map(({ text }) => text)).toEqual(['Two']);
    // Busy with the run's own task, its slot is the run's.
    expect(run.store.reserve('a')).toBeUndefined();
  });
});
