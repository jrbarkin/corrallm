import { afterEach, expect, it, vi } from 'vitest';

import type { AgentNode, CanvasNode } from '../../../shared/model/canvas';
import type { QueueItem } from '../../../shared/model/queue';
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
