import { setImmediate } from 'node:timers/promises';
import { expect, it, vi } from 'vitest';
import type { CanvasId } from '../../shared/canvas';
import { Topics } from './topics';
import { CANVAS } from './test-registry';

it('bounds background runtime publications between event loop turns', async () => {
  let changed: ((canvas: CanvasId) => void) | undefined;
  const take = vi.fn(() => undefined);
  const topics = new Topics({
    read: () => Promise.reject(new Error('No read in this test')),
    runtime: {
      source: {
        listen: (listener) => {
          changed = listener;
          return () => undefined;
        },
        pending: () => [`sessions:${CANVAS}`],
        touched: () => true,
        take,
        taken: () => undefined,
        state: () => {
          throw new Error('No subscriber');
        },
        isPending: () => true,
        available: () => true,
        access: () => ({ world: undefined, lead: false }),
      },
      project: () => Promise.reject(new Error('No projection in this test')),
    },
  });
  try {
    for (let i = 0; i < 200; i++) {
      changed?.(CANVAS);
      await Promise.resolve();
    }
    expect(take).toHaveBeenCalledTimes(8);
    await setImmediate();
    expect(take).toHaveBeenCalledTimes(9);
  } finally {
    topics.close();
  }
});
