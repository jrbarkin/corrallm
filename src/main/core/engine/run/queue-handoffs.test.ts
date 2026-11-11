import { afterEach, describe, expect, it, vi } from 'vitest';

import { MAX_MESSAGE_BYTES } from '../../../../shared/api/limits';
import type { ConnectionId } from '../../../../shared/adapter';
import type { AgentNode } from '../../../../shared/model/canvas';
import type { QueueItem } from '../../../../shared/model/queue';
import type { TaskMessage, TurnResult } from '../../../../shared/session';
import type { RunHandOff, RunHandOffs, RunTasks } from './runner';
import { expectRestorable } from './test-restore';
import { manual, setup } from './test-run';

/*
 * B19 C1, the run's half: a queue's Message item for another agent is a queue hand-off. Where its
 * host gives the run somewhere to hand it off (RunIO.handOffs: the core's delivery), the run records
 * it pending, linked to its item's attempt, and sends nothing itself; how the recipient's turn ended
 * comes back (RunStore.handedOff) as the item's evidence, never a turn of its owner's. Its owner's
 * usage rule never holds it; Stop and Run again take it back; a quit keeps one still pending, and
 * a restored run waits for it again.
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
const COMPLETED: TurnResult = { status: 'completed', reason: 'completed' };
const HOUR = 60 * 60_000;
const fiveHour = (used: number) => ({ fiveHour: { usedPercent: used, resetsAt: 2 * HOUR } });

/** Where hand-offs go, as the test keeps them: each recorded, and each the run took back. */
function handOffs({ full = false }: { full?: boolean } = {}) {
  const recorded: (RunHandOff & { id: string })[] = [];
  const withdrawn: TaskMessage[] = [];
  /** The hand-offs still pending: their attempts. */
  const pending = new Set<string>();
  let room = !full;
  const seam: RunHandOffs = {
    record: vi.fn((send: RunHandOff) => {
      if (!room) return undefined;
      const id = crypto.randomUUID();
      recorded.push({ ...send, id });
      pending.add(send.task.attempt);
      return id;
    }),
    withdraw: (task) => {
      withdrawn.push(task);
      pending.delete(task.attempt);
    },
  };
  const tasks: RunTasks = {
    waits: () => false,
    reported: () => undefined,
    recover: () => ({ waiting: false, answered: false }),
    interrupt: () => undefined,
    pending: ({ attempt }) => pending.has(attempt),
  };
  return {
    seam,
    tasks,
    recorded,
    withdrawn,
    pending,
    /** Room in its recipient's line again. */
    room: () => {
      room = true;
    },
  };
}

/** Lead hands a task to Worker; then, if its reply says APPROVED, ships it itself. */
const QUEUE: QueueItem[] = [
  { id: 'hand', message: 'Review this', target: 'worker' },
  {
    id: 'check',
    if: { kind: 'outputContains', text: 'APPROVED' },
    then: [{ id: 'ship', message: 'Ship it' }],
  },
];

function world(queue: QueueItem[] = QUEUE, box = handOffs()) {
  const run = setup(
    [agent('lead', queue), agent('worker', [], 'codex.terminal')],
    manual,
    new Set(),
    {
      handOffs: box.seam,
      tasks: box.tasks,
    },
  );
  /** The last hand-off recorded, as its task names it. */
  const last = () => {
    const one = box.recorded.at(-1);
    if (one === undefined) throw new Error('No hand-off');
    return one;
  };
  /** The recipient's turn ended: its reply, and how. */
  const end = (reply: string, result: TurnResult = COMPLETED, task = last().task) => {
    box.pending.delete(task.attempt);
    run.store.handedOff(task, { failed: result.status !== 'completed', reply, result });
  };
  return { run, box, last, end };
}

describe('a queue hand-off (B19 C1)', () => {
  it('updates waiting hand-off owners with a fixed amount of work per agent', () => {
    const box = handOffs();
    const nodes = [
      ...Array.from({ length: 64 }, (_, index) =>
        agent(`lead-${String(index)}`, [{ id: 'hand', message: 'Review this', target: 'worker' }]),
      ),
      agent('worker'),
    ];
    const run = setup(nodes, manual, new Set(), { handOffs: box.seam, tasks: box.tasks });
    run.store.start();
    expect(box.recorded).toHaveLength(64);
    let reads = 0;
    for (const node of nodes) {
      const id = node.id;
      Object.defineProperty(node, 'id', {
        get: () => {
          reads++;
          return id;
        },
      });
    }
    run.store.update(nodes);
    expect(reads).toBeLessThanOrEqual(nodes.length * 16);
  });

  it('is recorded pending from its queue’s agent, linked to its attempt, and the run sends nothing', () => {
    const { run, box, last } = world();
    run.store.start();
    const attempt = run.store.snapshot().agents.lead?.attempts?.hand?.[0];
    expect(box.recorded).toEqual([
      {
        owner: 'lead',
        to: 'worker',
        text: 'Review this',
        task: { agent: 'lead', item: 'hand', attempt: attempt?.id },
        id: last().id,
      },
    ]);
    expect(attempt).toMatchObject({ status: 'running', messageId: last().id });
    expect(run.where()).toEqual({ lead: 'running hand', worker: 'done' });
    // Neither its recipient's session nor its owner's is sent anything by the run.
    expect(run.sent).toEqual([]);
  });

  it('takes its recipient’s reply as the item’s evidence, never as a turn of its owner’s', () => {
    const { run, end } = world();
    run.store.start();
    end('Looks good.\nAPPROVED');
    expect(run.store.snapshot().agents.lead?.outcomes).toMatchObject({ hand: 'succeeded' });
    // The If read the reply: its own step is the owner's first native work.
    expect(run.sent.map(({ agent: to, text }) => [to, text])).toEqual([['lead', 'Ship it']]);
  });

  it('reads the whole reply, not a message’s capped excerpt of it', () => {
    const { run, end } = world();
    run.store.start();
    end(`${'x'.repeat(MAX_MESSAGE_BYTES + 10)}\nAPPROVED`);
    expect(run.sent.map(({ text }) => text)).toEqual(['Ship it']);
  });

  it('reads a reply without what the If looks for as its evidence: no owner turn at all', () => {
    const { run, end } = world();
    run.store.start();
    end('Not yet.');
    expect(run.store.snapshot().agents.lead).toMatchObject({
      status: 'done',
      outcomes: { hand: 'succeeded', check: 'skipped' },
    });
    expect(run.sent).toEqual([]);
  });

  it('takes a FAILED line in the reply as data, and holds a native failure despite text that looks fine', () => {
    const failed = world([
      { id: 'hand', message: 'Review this', target: 'worker' },
      { id: 'after', if: { kind: 'failed' }, then: [{ id: 'fix', message: 'Fix it' }] },
    ]);
    failed.run.store.start();
    failed.end('FAILED');
    expect(failed.run.store.snapshot().agents.lead?.outcomes).toMatchObject({
      hand: 'succeeded',
      after: 'skipped',
    });
    const native = world([
      { id: 'hand', message: 'Review this', target: 'worker' },
      { id: 'after', if: { kind: 'failed' }, then: [{ id: 'fix', message: 'Fix it' }] },
    ]);
    native.run.store.start();
    native.end('All done.\nSUCCEEDED', { status: 'failed', reason: 'api', message: 'Overloaded' });
    // Held for you with its native reason; the queue's If for a failure doesn't run for it.
    expect(native.run.store.snapshot().agents.lead).toMatchObject({
      status: 'asking',
      current: 'hand',
      problem: { kind: 'failed', reason: 'api', text: 'Overloaded', agent: 'worker' },
    });
    expect(native.run.sent).toEqual([]);
  });

  it('hears no other attempt’s end: a late end never finishes a retried item', () => {
    const { run, box, end } = world();
    run.store.start();
    const first = box.recorded[0]?.task;
    if (first === undefined) throw new Error('No hand-off');
    end('Interrupted', { status: 'cancelled', reason: 'interrupted' });
    expect(run.where()).toEqual({ lead: 'asking hand', worker: 'done' });
    run.store.decide('lead', 'hand', { choice: 'retry' });
    expect(box.recorded).toHaveLength(2);
    // The first attempt's end again, and a made-up one's: neither finishes the retry.
    end('APPROVED', COMPLETED, first);
    end('APPROVED', COMPLETED, { ...first, attempt: '00000000-0000-4000-8000-000000000000' });
    expect(run.where()).toEqual({ lead: 'running hand', worker: 'done' });
    end('APPROVED');
    expect(run.store.snapshot().agents.lead?.outcomes).toMatchObject({ hand: 'succeeded' });
  });

  it('isn’t held by its owner’s usage rule; only its recipient’s, where delivery reads it', () => {
    const { run, box } = world();
    // The owner spends Claude, over its rule's share, which asks.
    run.rule({ window: 'fiveHour', percent: 80, action: 'ask' });
    run.reading(fiveHour(90));
    run.store.start();
    expect(box.recorded).toHaveLength(1);
    expect(run.where()).toEqual({ lead: 'running hand', worker: 'done' });
  });

  it('is held for you by its recipient’s usage rule that asks, before it is recorded, as run work', () => {
    const { run, box } = world();
    // Worker spends Codex, over its rule's share, which asks.
    run.rule({ window: 'fiveHour', percent: 80, action: 'ask' }, 'codex');
    run.reading(fiveHour(90), 'codex');
    run.store.start();
    expect(box.recorded).toEqual([]);
    expect(run.where()).toEqual({ lead: 'asking hand', worker: 'done' });
    expect(run.store.snapshot().agents.lead?.usage).toMatchObject({ backend: 'codex' });
    // Go on: the rule holds no one on that backend until its window resets, and it is handed off.
    run.store.decide('lead', 'hand', { choice: 'goOn' });
    expect(box.recorded).toHaveLength(1);
    expect(run.where()).toEqual({ lead: 'running hand', worker: 'done' });
  });

  it('is admitted as run work against its recipient before it is recorded', () => {
    const box = handOffs();
    const admit = vi.fn(() => 'switching' as const);
    const run = setup(
      [agent('lead', QUEUE), agent('worker', [], 'codex.terminal')],
      manual,
      new Set(),
      { handOffs: box.seam, tasks: box.tasks, admit },
    );
    run.store.start();
    expect(admit).toHaveBeenCalledWith('worker', { run: true });
    expect(box.recorded).toEqual([]);
    expect(run.where()).toEqual({ lead: 'waiting hand', worker: 'done' });
  });

  it('is taken back by Stop, its owner told nothing more of how it ends', () => {
    const { run, box, end } = world();
    run.store.start();
    const task = box.recorded[0]?.task;
    run.store.stop();
    expect(box.withdrawn).toEqual([task]);
    expect(run.store.snapshot().agents.lead?.problem).toMatchObject({
      kind: 'cancelled',
      agent: 'worker',
    });
    end('APPROVED');
    expect(run.store.snapshot().agents.lead?.problem?.kind).toBe('cancelled');
    expect(run.sent).toEqual([]);
  });

  it('is taken back by Run again before the fresh run hands its own off', () => {
    const { run, box } = world();
    run.store.start();
    const task = box.recorded[0]?.task;
    run.store.start();
    expect(box.withdrawn).toEqual([task]);
    expect(box.recorded).toHaveLength(2);
    expect(box.recorded[1]?.task.attempt).not.toBe(task?.attempt);
  });

  it('is left to delivery by Kill, which takes back what was sent between the killed agents', () => {
    const { run, box, end } = world();
    run.store.start();
    run.store.killAgent('worker');
    expect(box.withdrawn).toEqual([]);
    expect(run.store.snapshot().agents.lead?.problem).toMatchObject({ kind: 'cancelled' });
    end('APPROVED');
    expect(run.store.snapshot().agents.lead?.problem?.kind).toBe('cancelled');
  });

  it('stays pending through a quit and waits for it again, restored, as the same attempt', () => {
    const { run, box, end } = world();
    run.store.start();
    const task = box.recorded[0]?.task;
    run.store.pause();
    // Still the item's attempt, still running: nothing was sent, nothing is uncertain.
    expect(run.store.snapshot().agents.lead?.attempts?.hand?.[0]).toMatchObject({
      status: 'running',
    });
    expect(run.store.snapshot().agents.lead?.problem).toBeUndefined();
    expect(box.withdrawn).toEqual([]);
    run.store.resume();
    expect(box.recorded).toHaveLength(1);
    end('APPROVED', COMPLETED, task);
    expect(run.store.snapshot().agents.lead?.outcomes).toMatchObject({ hand: 'succeeded' });
  });

  it('is uncertain after a quit once its recipient had it, as any send in flight is', () => {
    const { run, box } = world();
    run.store.start();
    box.pending.clear();
    run.store.pause();
    expect(run.store.snapshot().agents.lead?.problem).toMatchObject({ kind: 'uncertain' });
  });

  it('waits unsent, no attempt made, while its recipient’s line is full, and goes once there is room', () => {
    const box = handOffs({ full: true });
    const { run } = world(QUEUE, box);
    run.store.start();
    expect(run.where()).toEqual({ lead: 'waiting hand', worker: 'done' });
    expect(run.store.snapshot().agents.lead?.attempts).toBeUndefined();
    box.room();
    run.store.admissionChanged();
    expect(box.recorded).toHaveLength(1);
    expect(run.where()).toEqual({ lead: 'running hand', worker: 'done' });
  });

  it('holds one longer than a message holds for you, unsent and never cut', () => {
    const { run, box } = world([
      { id: 'hand', message: 'é'.repeat(MAX_MESSAGE_BYTES), target: 'worker' },
    ]);
    run.store.start();
    expect(box.recorded).toEqual([]);
    expect(run.store.snapshot().agents.lead).toMatchObject({
      status: 'asking',
      current: 'hand',
      problem: { kind: 'failed', reason: 'too-long', agent: 'worker' },
    });
  });

  it('sends a correction you typed with Retry as yours, past delivery, as before', () => {
    const { run, box, end } = world();
    run.store.start();
    end('', { status: 'cancelled', reason: 'interrupted' });
    run.store.decide('lead', 'hand', { reply: 'Look at the tests too' });
    expect(box.recorded).toHaveLength(1);
    expect(run.sent).toMatchObject([{ agent: 'worker', origin: 'user' }]);
    expect(run.sent[0]?.text).toContain('Look at the tests too');
  });
});
