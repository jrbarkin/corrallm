import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentNode } from '../../../../shared/model/canvas';
import type { QueueItem } from '../../../../shared/model/queue';
import type { RunMailbox, RunSend, RunSendEnd } from './runner';
import { expectRestorable } from './test-restore';
import { manual, setup } from './test-run';

/*
 * The run's half of B11a's handoff (C7): while corrallm's handoff request to an agent waits or
 * runs, the run's gate holds that agent's next task; and a send goes to its session as its
 * mailbox records it, which is where the first send after a switch carries the agent's handoff.
 * Whether a request waits, and what is carried, is the core's handoff service's: here, the test's.
 */

afterEach(expectRestorable);

const agent = (id: string, queue: QueueItem[] = []): AgentNode => ({
  id,
  type: 'agent',
  position: { x: 0, y: 0 },
  data: { label: id, adapter: 'claude-code', connection: 'claude-code.terminal', queue },
});

describe('a handoff request waiting or running (B11a C7)', () => {
  it('holds its agent’s next task unsent, asking no admission, until it ends', () => {
    const asking = new Set<string>();
    const admit = vi.fn(() => 'go' as const);
    const run = setup(
      [
        agent('a', [
          { id: 'one', message: 'One' },
          { id: 'two', message: 'Two' },
        ]),
      ],
      manual,
      new Set(),
      { admit, handoff: (to) => asking.has(to) },
    );
    run.store.start();
    expect(run.sent.map(({ text }) => text)).toEqual(['One']);
    // Its turn crossed the ask point: corrallm's request is recorded as the turn ends.
    asking.add('a');
    admit.mockClear();
    run.reply('a');
    expect(run.where()).toEqual({ a: 'waiting two' });
    expect(run.sent).toHaveLength(1);
    expect(admit).not.toHaveBeenCalled();
    // Asked again as the run moves, it holds the same.
    run.store.admissionChanged();
    expect(run.sent).toHaveLength(1);
    // The request's turn ended: the task goes.
    asking.delete('a');
    run.store.admissionChanged();
    expect(run.sent.map(({ text }) => text)).toEqual(['One', 'Two']);
    expect(run.where()).toEqual({ a: 'running two' });
  });

  it('holds a message item to another agent on that recipient’s request', () => {
    const run = setup(
      [agent('a', [{ id: 'hand', message: 'Review this', target: 'b' }]), agent('b')],
      manual,
      new Set(),
      { handoff: (to) => to === 'b' },
    );
    run.store.start();
    expect(run.sent).toEqual([]);
    expect(run.where()).toEqual({ a: 'waiting hand', b: 'done' });
  });
});

describe('what a send goes as (B11a C7’s carry)', () => {
  /** A mailbox that frames each send as `frame` says, recording what it was given and settled. */
  function mailbox(frame: (send: RunSend) => string = ({ text }) => text) {
    const recorded: RunSend[] = [];
    const settled: [string, RunSendEnd][] = [];
    const box: RunMailbox = {
      record: (send) => {
        recorded.push(send);
        return { id: `m${String(recorded.length)}`, text: frame(send) };
      },
      settle: (id, end) => {
        settled.push([id, end]);
      },
    };
    return { box, recorded, settled };
  }

  it('sends its session what the mailbox recorded, whole', () => {
    const { box, recorded } = mailbox(({ text }) => `[corrallm] Switched.\n\n${text}\n\nHandoff`);
    const run = setup([agent('a', [{ id: 'one', message: 'Do it' }])], manual, new Set(), {
      mailbox: box,
    });
    run.store.start();
    expect(recorded.map(({ text }) => text)).toEqual(['Do it']);
    expect(run.sent.map(({ text }) => text)).toEqual(['[corrallm] Switched.\n\nDo it\n\nHandoff']);
  });

  it('says a send withdrawn before it went never reached its session, and one taken back after did not say so', async () => {
    const { box, settled } = mailbox();
    const journaled = Promise.withResolvers<undefined>();
    const run = setup(
      [agent('a', [{ id: 'one', message: 'One' }]), agent('b', [{ id: 'two', message: 'Two' }])],
      manual,
      new Set(),
      { mailbox: box, beforeSend: () => journaled.promise },
    );
    run.store.start();
    expect(run.sent).toEqual([]);
    // Stopped while its record is on its way: neither ever went.
    run.store.pause();
    journaled.resolve(undefined);
    await Promise.resolve();
    expect(settled).toEqual([
      ['m1', expect.objectContaining({ state: 'withdrawn', unsent: true })],
      ['m2', expect.objectContaining({ state: 'withdrawn', unsent: true })],
    ]);
  });

  it('says nothing of the kind of a send taken back from its session', () => {
    const { box, settled } = mailbox();
    const run = setup([agent('a', [{ id: 'one', message: 'One' }])], manual, new Set(), {
      mailbox: box,
    });
    run.store.start();
    expect(run.sent).toHaveLength(1);
    run.store.pause();
    expect(settled).toEqual([['m1', { state: 'withdrawn', turn: expect.anything() as unknown }]]);
  });
});
