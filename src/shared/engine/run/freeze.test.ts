import { afterEach, describe, expect, it } from 'vitest';

import type { AgentNode } from '../../model/canvas';
import type { QueueItem } from '../../model/queue';
import { expectRestorable } from './test-restore';
import { setup } from './test-run';

afterEach(expectRestorable);

/*
 * The core's shutdown barrier (B11 Design §16.5), as a run keeps it: while frozen, no task starts
 * and nothing the run sends goes, but a turn going on goes on, and how it ends is kept; thawed (a
 * quit cancelled), the run goes on from where it is. A quit committed meanwhile holds only the turn
 * that was going as uncertain: a task the barrier kept from starting was never sent.
 */

const connected = (id: string, queue: QueueItem[]): AgentNode => ({
  id,
  type: 'agent',
  position: { x: 0, y: 0 },
  data: { label: id, queue, connection: 'claude-code.sdk' },
});

const QUEUE: QueueItem[] = [
  { id: 'one', message: 'First' },
  { id: 'two', message: 'Second' },
];

describe('a frozen run', () => {
  it('starts no task, keeps the turn going and how it ends, and goes on once thawed', () => {
    const run = setup([connected('a', QUEUE)]);
    run.store.start();
    expect(run.sent.map(({ text }) => text)).toEqual(['First']);
    run.store.freeze();
    run.reply('a', false, 'Done.');
    // The turn's end is kept, but the next task waits for the barrier.
    expect(run.sent.map(({ text }) => text)).toEqual(['First']);
    expect(run.store.snapshot().agents.a?.outcomes).toEqual({ one: 'succeeded' });
    run.tick();
    expect(run.sent.map(({ text }) => text)).toEqual(['First']);
    run.store.thaw();
    expect(run.sent.map(({ text }) => text)).toEqual(['First', 'Second']);
    run.reply('a', false, 'Done too.');
    expect(run.where()).toEqual({ a: 'done' });
  });

  it('started while frozen, sends nothing until thawed', () => {
    const run = setup([connected('a', QUEUE)]);
    run.store.freeze();
    run.store.start();
    run.tick();
    expect(run.sent).toEqual([]);
    run.store.thaw();
    expect(run.sent.map(({ text }) => text)).toEqual(['First']);
  });

  it('thawed twice, or never frozen, changes nothing', () => {
    const run = setup([connected('a', QUEUE)]);
    run.store.thaw();
    run.store.start();
    run.store.freeze();
    run.store.thaw();
    run.store.thaw();
    expect(run.sent.map(({ text }) => text)).toEqual(['First']);
  });

  it('paused as a committed quit pauses it, holds only the turn going as uncertain', () => {
    const run = setup([connected('a', QUEUE), connected('b', [{ id: 'later', message: 'Later' }])]);
    run.store.start();
    expect(run.sent.map(({ text }) => text)).toEqual(['First', 'Later']);
    run.store.freeze();
    run.reply('b', false, 'Done.');
    run.store.pause();
    const { agents } = run.store.snapshot();
    expect(agents.a?.problem).toMatchObject({ kind: 'uncertain', reason: 'interrupted' });
    expect(agents.b?.problem).toBeUndefined();
    expect(agents.b?.outcomes).toEqual({ later: 'succeeded' });
    expect(run.sent.map(({ text }) => text)).toEqual(['First', 'Later']);
  });
});
