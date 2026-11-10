import { afterEach, expect, it, vi } from 'vitest';
import type { AgentNode, CanvasNode } from '../../../shared/model/canvas';
import type { Message } from '../../../shared/model/messages';
import type { NeedsItem } from '../../../shared/model/needs';
import { Delivery } from './delivery';
import type { DeliveryDeps } from './delivery';
import { LoopStore, LoopTable } from './loops';
import { MessageStore, MessageTable } from './messages';
import { unopened } from '../store/store';
import { Engine } from '../engine/engine';
import { TEST_ENGINE } from '../engine/test-engine';
import { NO_BACKEND } from '../engine/transcript/receive';
import { expectRestorable, liveRunOf } from '../engine/run/test-restore';
import { CANVAS } from '../test-registry';

afterEach(expectRestorable);

/** An agent of the test catalog, on Claude's Agent SDK. */
function agentNode(id: string): AgentNode {
  return {
    id,
    type: 'agent',
    position: { x: 0, y: 0 },
    data: { label: id, adapter: 'claude-code', connection: 'claude-code.sdk' },
  };
}

/**
 * A started delivery over the canvas `nodes`, its store journaling nothing (every write resolves at
 * once), and what it reads as it acts, while `counting` says so: its store's walks of what it acts
 * on (`active`), each field of a message such a walk gave it, and the canvas's nodes. `stop` ends it.
 */
async function worldOf(
  nodes: readonly CanvasNode[],
  deps: Partial<DeliveryDeps> = {},
  seed?: (messages: MessageStore) => void,
) {
  const engine = new Engine({
    catalog: TEST_ENGINE,
    backend: NO_BACKEND,
    now: () => 1000,
    later: () => () => undefined,
  });
  liveRunOf(engine.run, TEST_ENGINE, () => 1000);
  engine.update(nodes);
  const messages = new MessageStore(
    CANVAS,
    new MessageTable(unopened('No database needed for an empty canvas'), {
      ensure: () => undefined,
    }),
    () => 1000,
  );
  await messages.load();
  vi.spyOn(messages, 'durable').mockResolvedValue();
  const read = { counting: false, walks: 0, fields: 0, nodes: 0 };
  const active = messages.active.bind(messages);
  vi.spyOn(messages, 'active').mockImplementation(() => {
    if (!read.counting) return active();
    read.walks += 1;
    return active().map(
      (message) =>
        new Proxy(message, {
          get: (target, key, receiver): unknown => {
            read.fields += 1;
            return Reflect.get(target, key, receiver) as unknown;
          },
        }),
    );
  });
  seed?.(messages);
  const delivery = new Delivery({
    canvas: CANVAS,
    engine,
    store: messages,
    nodes: () => {
      if (read.counting) read.nodes += 1;
      return nodes;
    },
    usage: { exhausted: () => undefined },
    now: () => 1000,
    later: () => () => undefined,
    changed: () => undefined,
    defaultAsks: () => Promise.resolve(true),
    loops: new LoopStore(
      CANVAS,
      new LoopTable(unopened('No database needed for an empty canvas'), {
        ensure: () => undefined,
      }),
    ),
    ...deps,
  });
  await delivery.start();
  const stop = async () => {
    await delivery.close();
    engine.reset();
  };
  return { engine, messages, delivery, read, stop };
}

/** Lets a check of what waits run, and what it started settle. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

it('settles withdrawals and tells their senders before the next event loop turn, throughout a burst', async () => {
  vi.useFakeTimers({ toFake: ['setImmediate', 'clearImmediate'] });
  const { messages, delivery, stop } = await worldOf([]);
  try {
    for (let i = 0; i < 20; i++) {
      const message = messages.add({
        from: 'outside:orchestrator',
        to: 'agent:gone',
        kind: 'text',
        origin: 'party',
        body: `Work ${String(i)}`,
        state: 'pending',
      });
      delivery.schedule();
      delivery.schedule();
      await Promise.resolve();
      expect(messages.get(message.id)?.state).toBe('withdrawn');
      const notices = messages.all().filter((entry) => entry.replyTo === message.id);
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({ kind: 'notice', to: message.from });
      expect(notices[0]?.body).toContain('is no longer on the canvas');
    }
  } finally {
    await stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
  }
});

/** The six agents of G2's canvas. */
const AGENTS = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'].map(agentNode);

/** What keeps a1 busy: a prompt of its session's, open. */
const PROMPT: NeedsItem = {
  id: 'prompt/a1/0/p1',
  canvas: CANVAS,
  agent: 'a1',
  kind: 'prompt',
  for: 'you',
  by: ['you'],
  title: 'Allow?',
  choices: [],
  answerIn: 'both',
};

/**
 * What one check of what waits reads with `count` messages waiting for a1, which an open prompt
 * keeps busy (telling no one anything): half from outside orchestrators, half from a2 (turns
 * between two agents of the canvas, which the loop breaker counts); and what reading the canvas's
 * Needs items from delivery reads, no pair of agents held.
 */
async function readWith(count: number) {
  const { messages, delivery, read, stop } = await worldOf(AGENTS, {
    waitingOn: (agent) => (agent === 'a1' ? PROMPT : undefined),
  });
  try {
    const waiting: Message[] = [];
    for (let i = 0; i < count; i++) {
      waiting.push(
        messages.add({
          from: i % 2 === 0 ? `outside:party-${String(i % 20)}` : 'agent:a2',
          to: 'agent:a1',
          kind: 'text',
          origin: 'party',
          body: `Work ${String(i)}`,
          state: 'pending',
        }),
      );
    }
    // A first look reads how a1's session asks: the one measured looks as G2's burst does.
    delivery.schedule();
    await settled();
    const kept = messages.all().length;
    read.counting = true;
    delivery.schedule();
    await Promise.resolve();
    read.counting = false;
    const check = { walks: read.walks, fields: read.fields, nodes: read.nodes };
    Object.assign(read, { walks: 0, fields: 0, nodes: 0, counting: true });
    const items = delivery.items();
    read.counting = false;
    // Nothing went, and nothing was told: every message still waits.
    expect(messages.all()).toHaveLength(kept);
    for (const { id } of waiting) expect(messages.get(id)?.state).toBe('pending');
    expect(items).toEqual([]);
    return { check, items: { walks: read.walks, fields: read.fields } };
  } finally {
    await stop();
    vi.restoreAllMocks();
  }
}

it('reads what waits a fixed number of times per check, and each waiting message a bounded number of times, however much waits', async () => {
  // G2: with B21's asks, continuations and loop counts, every check walked what waits again,
  // ordered each agent's line by insertion (its reads growing with the square of what waits) and
  // read the canvas's agents once per waiting turn between two agents.
  const small = await readWith(100);
  const large = await readWith(400);
  // Its walks of what it acts on, as before B21: what is gone, what is stale, then what waits.
  expect(large.check.walks).toBe(small.check.walks);
  expect(large.check.walks).toBeLessThanOrEqual(3);
  // The canvas's agents, read a fixed number of times, never once per waiting message.
  expect(large.check.nodes).toBe(small.check.nodes);
  // Four times as much waiting, at most about four times the reads: never their square.
  expect(large.check.fields).toBeLessThanOrEqual(5 * small.check.fields);
});

it('reads none of what waits for Needs while no pair of agents is held', async () => {
  // G2: every look at what waits for an answer (each change, as `serve` hears it) walked every
  // message delivery acts on to find the loop breaker's holds.
  const { items } = await readWith(100);
  expect(items).toEqual({ walks: 0, fields: 0 });
});

it('re-addresses manager rows as delivery starts, from a recipient that no longer leads', async () => {
  // B24: who leads may have changed while the canvas's engine was closed.
  const nodes: CanvasNode[] = [
    agentNode('top'),
    { ...agentNode('mid'), parentId: 'top' },
    { ...agentNode('work'), parentId: 'mid' },
  ];
  let id = '';
  const { messages, stop } = await worldOf(
    nodes,
    { manages: (lead) => lead === 'top' },
    (store) => {
      id = store.add({
        from: 'agent:work',
        to: 'agent:mid',
        kind: 'text',
        origin: 'party',
        body: 'Blocked.',
        state: 'pending',
        display: { via: 'manager' },
      }).id;
    },
  );
  try {
    expect(messages.get(id)).toMatchObject({ to: 'agent:top' });
    expect(messages.displayOf(id)).toEqual({ via: 'manager' });
  } finally {
    await stop();
    vi.restoreAllMocks();
  }
});
