import { afterEach, expect, it, vi } from 'vitest';

import type { AgentNode, CanvasNode } from '../../../shared/model/canvas';
import type { QueueItem } from '../../../shared/model/queue';
import { MAX_WAITING } from '../../../shared/api/limits';
import { agentParty } from '../../../shared/model/messages';
import { Delivery } from './delivery';
import { LoopStore, LoopTable } from './loops';
import { MessageStore, MessageTable } from './messages';
import { mailboxTasks } from './tasks';
import { unopened } from '../store/store';
import { Engine } from '../engine/engine';
import { TEST_ENGINE } from '../engine/test-engine';
import { NO_BACKEND } from '../engine/transcript/receive';
import { expectRestorable, liveRunOf } from '../engine/run/test-restore';
import { CANVAS } from '../test-registry';

/*
 * B19 C1, delivery's half, where no session need run: a queue hand-off's words, as written, are
 * checked against its recipient's connection before anything is journaled. One its connection would
 * run as a shell command (a Terminal's `!`) is never sent: withdrawn by corrallm, its item failed,
 * declined, and held for you, as the run's own sends are.
 */

afterEach(expectRestorable);

function agentNode(
  id: string,
  connection: 'claude-code.sdk' | 'claude-code.terminal',
  queue: QueueItem[] = [],
): AgentNode {
  return {
    id,
    type: 'agent',
    position: { x: 0, y: 0 },
    data: { label: id, adapter: 'claude-code', connection, queue },
  };
}

async function worldOf(nodes: readonly CanvasNode[]) {
  const messages = new MessageStore(
    CANVAS,
    new MessageTable(unopened('No database needed'), { ensure: () => undefined }),
    () => 1000,
  );
  await messages.load();
  vi.spyOn(messages, 'durable').mockResolvedValue();
  /** The delivery the run hands off to, made once the engine is. */
  const late: { delivery?: Delivery } = {};
  const tasks = mailboxTasks(messages);
  const engine = new Engine({
    catalog: TEST_ENGINE,
    backend: NO_BACKEND,
    now: () => 1000,
    later: () => () => undefined,
    tasks,
    handOffs: {
      record: (send) => late.delivery?.handOff(send),
      withdraw: (task) => {
        late.delivery?.withdrawHandOff(task);
      },
    },
    points: { offer: (agent, gap, token) => late.delivery?.offer(agent, gap, token) ?? false },
  });
  liveRunOf(engine.run, TEST_ENGINE, () => 1000, tasks);
  engine.update(nodes);
  const delivery = new Delivery({
    canvas: CANVAS,
    engine,
    store: messages,
    nodes: () => nodes,
    usage: { exhausted: () => undefined },
    now: () => 1000,
    later: () => () => undefined,
    changed: () => undefined,
    defaultAsks: () => Promise.resolve(true),
    loops: new LoopStore(
      CANVAS,
      new LoopTable(unopened('No database needed'), { ensure: () => undefined }),
    ),
  });
  late.delivery = delivery;
  await delivery.start();
  const stop = async () => {
    await delivery.close();
    engine.reset();
  };
  return { engine, messages, delivery, stop };
}

it('never sends a hand-off its recipient’s connection would run as a shell command: its item is held, declined', async () => {
  const { engine, messages, stop } = await worldOf([
    agentNode('lead', 'claude-code.sdk', [
      { id: 'hand', message: '!rm -rf build', target: 'worker' },
    ]),
    agentNode('worker', 'claude-code.terminal'),
  ]);
  try {
    const send = vi.spyOn(engine.sessions, 'send');
    engine.run.start();
    await vi.waitFor(() => {
      expect(messages.all().find((one) => one.purpose?.type === 'handoff')?.state).toBe(
        'withdrawn',
      );
    });
    const [handoff] = messages.all();
    expect(handoff).toMatchObject({
      by: 'corrallm',
      turn: { status: 'failed', reason: 'declined' },
      body: '!rm -rf build',
    });
    expect(send).not.toHaveBeenCalled();
    expect(engine.run.snapshot().agents.lead).toMatchObject({
      status: 'asking',
      current: 'hand',
      problem: { kind: 'failed', reason: 'declined', agent: 'worker' },
    });
    // No one is told: the run holds its item.
    expect(messages.all().filter((one) => one.kind === 'notice')).toEqual([]);
  } finally {
    await stop();
  }
});

it('offers no gap a walk of every message delivery acts on: only what waits for its agent is read', async () => {
  const nodes = [agentNode('lead', 'claude-code.sdk'), agentNode('worker', 'claude-code.sdk')];
  const { messages, delivery, stop } = await worldOf(nodes);
  try {
    // A backlog for another agent, which a gap of Worker's never reads.
    for (let i = 0; i < 50; i++)
      messages.add({
        from: 'outside:orchestrator',
        to: 'agent:lead',
        kind: 'text',
        origin: 'party',
        body: `Work ${String(i)}`,
        state: 'pending',
      });
    const walks = vi.spyOn(messages, 'active');
    expect(delivery.offer('worker', 'gap', {})).toBe(false);
    expect(walks).not.toHaveBeenCalled();
  } finally {
    await stop();
  }
});

it.each([false, true])(
  'rechecks the exact hand-off line when another is full: %s',
  async (other) => {
    const owner = 'lead\u0000part';
    const to = 'worker\u0000part';
    const { engine, messages, delivery, stop } = await worldOf([
      agentNode(owner, 'claude-code.sdk'),
      agentNode(to, 'claude-code.sdk'),
      agentNode('lead', 'claude-code.sdk'),
      agentNode('part', 'claude-code.sdk'),
    ]);
    try {
      engine.run.pauseAgent(to);
      engine.run.pauseAgent('part');
      const waiting = Array.from({ length: MAX_WAITING }, () =>
        messages.add({
          from: agentParty(owner),
          to: agentParty(to),
          kind: 'text',
          origin: 'party',
          body: 'Waiting work',
          state: 'pending',
        }),
      );
      if (other)
        for (let index = 0; index < MAX_WAITING; index++)
          messages.add({
            from: 'agent:lead',
            to: 'agent:part',
            kind: 'text',
            origin: 'party',
            body: 'Other waiting work',
            state: 'pending',
          });
      const admission = vi.spyOn(engine.run, 'admissionChanged');
      expect(
        delivery.handOff({
          owner,
          to,
          text: 'Review this',
          task: { agent: owner, item: 'hand', attempt: 'attempt' },
        }),
      ).toBeUndefined();
      delivery.schedule();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(admission).not.toHaveBeenCalled();
      messages.update(waiting[0]?.id ?? '', { state: 'withdrawn' });
      delivery.schedule();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(admission).toHaveBeenCalledTimes(1);
    } finally {
      await stop();
    }
  },
);

it('checks full hand-off lines with a fixed amount of work per waiting message', async () => {
  const owners = Array.from({ length: 64 }, (_, index) => `lead-${String(index)}`);
  const { engine, messages, delivery, stop } = await worldOf([
    ...owners.map((owner) => agentNode(owner, 'claude-code.sdk')),
    agentNode('worker', 'claude-code.sdk'),
  ]);
  try {
    engine.run.pauseAgent('worker');
    for (const owner of owners)
      for (let index = 0; index < MAX_WAITING; index++)
        messages.add({
          from: agentParty(owner),
          to: 'agent:worker',
          kind: 'text',
          origin: 'party',
          body: 'Waiting work',
          state: 'pending',
        });
    // Let the ordinary pause notices land before measuring a steady-state check.
    delivery.schedule();
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (const owner of owners)
      expect(
        delivery.handOff({
          owner,
          to: 'worker',
          text: 'Review this',
          task: { agent: owner, item: 'hand', attempt: 'attempt' },
        }),
      ).toBeUndefined();
    const line = messages.activeTo('agent:worker');
    let reads = 0;
    for (const message of line) {
      const from = message.from;
      Object.defineProperty(message, 'from', {
        get: () => {
          reads++;
          return from;
        },
      });
    }
    delivery.schedule();
    await new Promise<void>((resolve) => setImmediate(resolve));
    // Includes every delivery classifier, not only room checks. Adding blocked owners must
    // never make each message get read once again for every owner sharing its recipient.
    expect(reads).toBeLessThanOrEqual(line.length * 16);
  } finally {
    await stop();
  }
});
