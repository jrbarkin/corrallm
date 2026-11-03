import { afterEach, expect, it, vi } from 'vitest';
import { Delivery } from './delivery';
import { LoopStore, LoopTable } from './loops';
import { MessageStore, MessageTable } from './messages';
import { unopened } from '../store/store';
import { Engine } from '../engine/engine';
import { TEST_ENGINE } from '../engine/test-engine';
import { NO_BACKEND } from '../engine/transcript/receive';
import { expectRestorable, liveRunOf } from '../engine/run/test-restore';
import { CANVAS } from '../test-registry';

afterEach(expectRestorable);

it('settles withdrawals and tells their senders before the next event loop turn, throughout a burst', async () => {
  vi.useFakeTimers({ toFake: ['setImmediate', 'clearImmediate'] });
  const engine = new Engine({
    catalog: TEST_ENGINE,
    backend: NO_BACKEND,
    now: () => 1000,
    later: () => () => undefined,
  });
  liveRunOf(engine.run, TEST_ENGINE, () => 1000);
  const messages = new MessageStore(
    CANVAS,
    new MessageTable(unopened('No database needed for an empty canvas'), {
      ensure: () => undefined,
    }),
    () => 1000,
  );
  await messages.load();
  vi.spyOn(messages, 'durable').mockResolvedValue();
  const delivery = new Delivery({
    canvas: CANVAS,
    engine,
    store: messages,
    nodes: () => [],
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
  });
  try {
    await delivery.start();
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
    await delivery.close();
    engine.reset();
    vi.useRealTimers();
    vi.restoreAllMocks();
  }
});
