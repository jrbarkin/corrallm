import { afterEach, describe, expect, it } from 'vitest';

import type { AgentNode } from '../../../../shared/model/canvas';
import type { QueueItem } from '../../../../shared/model/queue';
import { TEST_ENGINE } from '../test-engine';
import { RunStore } from './runner';
import type { RunIO, TurnEnd } from './runner';
import { expectRestorable, liveRun } from './test-restore';

afterEach(expectRestorable);

/*
 * The whole run's controls, stamped with their party (Core Server rule R9, B11 Design §6): who
 * stopped the run (`pausedBy`, you over any other, corrallm for a close or a restart), and who
 * decided what it held (`decided`), so that a token never resumes or starts afresh past yours.
 */

const node = (id: string, queue: QueueItem[]): AgentNode => ({
  id,
  type: 'agent',
  position: { x: 0, y: 0 },
  data: { label: id, queue, connection: 'claude-code.sdk' },
});

function setup(nodes: AgentNode[], extra: Partial<RunIO> = {}) {
  const sent: { agent: string; done: (turn: TurnEnd) => void; withdrawn: boolean }[] = [];
  let now = 1_000;
  const io: RunIO = {
    send: (to, _text, done) => {
      const entry = { agent: to.id, done, withdrawn: false };
      sent.push(entry);
      return () => {
        entry.withdrawn = true;
      };
    },
    tell: () => undefined,
    later: () => () => undefined,
    now: () => now,
    ...extra,
  };
  const store = liveRun(TEST_ENGINE, io);
  store.update(nodes);
  return {
    store,
    sent,
    io,
    nodes,
    advance: (ms: number) => {
      now += ms;
    },
    reply: (agent: string, reply = '') => {
      const entry = sent.find((one) => one.agent === agent && !one.withdrawn);
      entry?.done({ failed: false, reply });
    },
  };
}

describe('who stopped the run', () => {
  it('stamps a stop with its party, and clears it as the run resumes or starts afresh', () => {
    const { store } = setup([node('a', [{ id: 'one', message: 'One' }])]);
    store.start();
    store.stop('outside:orchestrator');
    expect(store.snapshot()).toMatchObject({ running: false, paused: true });
    expect(store.snapshot().pausedBy).toBe('outside:orchestrator');
    store.resume();
    expect(store.snapshot()).toMatchObject({ running: true, paused: false });
    expect(store.snapshot()).not.toHaveProperty('pausedBy');
    store.stop();
    expect(store.snapshot().pausedBy).toBe('you');
    store.start();
    expect(store.snapshot()).not.toHaveProperty('pausedBy');
  });

  it('keeps an earlier stop’s party when another party stops it again, but yours makes it yours', () => {
    const { store } = setup([node('a', [{ id: 'one', message: 'One' }])]);
    store.start();
    store.stop();
    // A token's stop of the run you stopped never makes it the token's to resume.
    store.stop('outside:orchestrator');
    expect(store.snapshot().pausedBy).toBe('you');
    store.resume();
    store.stop('outside:orchestrator');
    store.stop();
    expect(store.snapshot().pausedBy).toBe('you');
  });

  it('is corrallm’s when quitting pauses a running run, and keeps a stop’s party through a quit', () => {
    const { store } = setup([node('a', [{ id: 'one', message: 'One' }])]);
    store.start();
    store.pause();
    expect(store.snapshot().pausedBy).toBe('corrallm');
    store.resume();
    store.stop();
    // Closing the core pauses it again: what you stopped stays yours.
    store.pause();
    expect(store.snapshot().pausedBy).toBe('you');
  });

  it('restores a stop’s party, and a run that was going as corrallm’s pause', () => {
    const nodes = [node('a', [{ id: 'one', message: 'One' }])];
    const { store } = setup(nodes);
    store.start();
    store.stop('outside:orchestrator');
    const restored = new RunStore(TEST_ENGINE, {
      send: () => () => undefined,
      tell: () => undefined,
      later: () => () => undefined,
      now: () => 0,
    });
    restored.update(nodes);
    restored.restore(store.checkpoint());
    expect(restored.snapshot().pausedBy).toBe('outside:orchestrator');
    // A run the core stopped mid-turn (a crash) restores as the restart paused it.
    const going = setup(nodes);
    going.store.start();
    restored.restore(going.store.checkpoint());
    expect(restored.snapshot()).toMatchObject({ running: false, paused: true });
    expect(restored.snapshot().pausedBy).toBe('corrallm');
  });

  it('stamps nothing on a run with nothing to resume', () => {
    const { store } = setup([node('a', [])]);
    store.stop('outside:orchestrator');
    expect(store.snapshot()).not.toHaveProperty('paused');
    expect(store.snapshot()).not.toHaveProperty('pausedBy');
  });
});

describe('who decided what the run held', () => {
  it('records each party once, as its decision takes effect, until the run starts afresh', () => {
    const { store } = setup([
      node('a', [
        { id: 'ok', approve: 'The plan' },
        { id: 'nap', delay: { seconds: 600 } },
        { id: 'ok-again', approve: 'Again' },
      ]),
    ]);
    store.start();
    expect(store.snapshot()).not.toHaveProperty('decided');
    store.decide('a', 'ok', { choice: 'approve' });
    expect(store.snapshot().decided).toEqual(['you']);
    store.goOn('a', 'nap', 'outside:orchestrator');
    expect(store.snapshot().decided).toEqual(['you', 'outside:orchestrator']);
    store.decide('a', 'ok-again', { choice: 'approve' }, 'you');
    expect(store.snapshot().decided).toEqual(['you', 'outside:orchestrator']);
    store.start();
    expect(store.snapshot()).not.toHaveProperty('decided');
  });

  it('records nothing for a decision that changes nothing: a stale hold, or a run not going', () => {
    const { store } = setup([node('a', [{ id: 'nap', delay: { seconds: 600 } }])]);
    store.start();
    const before = store.snapshot();
    store.decide('a', 'nap', { choice: 'approve' }, 'outside:orchestrator');
    store.goOn('a', 'elsewhere', 'outside:orchestrator');
    expect(store.snapshot()).toBe(before);
    store.stop();
    const stopped = store.snapshot();
    store.goOn('a', 'nap', 'outside:orchestrator');
    expect(store.snapshot()).toBe(stopped);
  });

  it('keeps who decided through a stop, a resume and a restore', () => {
    const nodes = [
      node('a', [
        { id: 'ok', approve: 'The plan' },
        { id: 'nap', delay: { seconds: 600 } },
      ]),
    ];
    const { store } = setup(nodes);
    store.start();
    store.decide('a', 'ok', { choice: 'approve' });
    store.stop();
    store.resume();
    expect(store.snapshot().decided).toEqual(['you']);
    const restored = new RunStore(TEST_ENGINE, {
      send: () => () => undefined,
      tell: () => undefined,
      later: () => () => undefined,
      now: () => 0,
    });
    restored.update(nodes);
    restored.restore(store.checkpoint());
    expect(restored.snapshot().decided).toEqual(['you']);
  });
});
