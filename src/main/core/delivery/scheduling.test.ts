import { setImmediate } from 'node:timers/promises';
import { expect, it, vi } from 'vitest';
import { Delivery } from './delivery';
import { MessageStore, MessageTable } from './messages';
import { unopened } from '../store/store';
import { Engine } from '../engine/engine';
import { TEST_ENGINE } from '../engine/test-engine';
import { NO_BACKEND } from '../engine/transcript/receive';
import { CANVAS } from '../test-registry';

it('bounds delivery checks within a burst of microtasks and yields before checking again', async () => {
  const engine = new Engine({
    catalog: TEST_ENGINE,
    backend: NO_BACKEND,
    now: () => 1000,
    later: () => () => undefined,
  });
  const messages = new MessageStore(
    CANVAS,
    new MessageTable(unopened('No database needed for an empty canvas'), {
      ensure: () => undefined,
    }),
    () => 1000,
  );
  const nodes = vi.fn(() => []);
  const delivery = new Delivery({
    canvas: CANVAS,
    engine,
    store: messages,
    nodes,
    usage: { exhausted: () => undefined },
    now: () => 1000,
    later: () => () => undefined,
    changed: () => undefined,
    defaultAsks: () => Promise.resolve(true),
  });
  try {
    await delivery.start();
    await setImmediate();
    nodes.mockClear();
    for (let i = 0; i < 20; i++) {
      delivery.schedule();
      await Promise.resolve();
    }
    expect(nodes).toHaveBeenCalledTimes(24);
    await setImmediate();
    expect(nodes).toHaveBeenCalledTimes(27);
  } finally {
    await delivery.close();
    engine.reset();
  }
});
