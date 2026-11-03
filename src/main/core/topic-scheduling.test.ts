import { expect, it, vi } from 'vitest';
import type { CanvasId } from '../../shared/canvas';
import { Topics } from './topics';
import { CANVAS } from './test-registry';

it('publishes runtime changes in order before the next event loop turn, throughout a burst', async () => {
  vi.useFakeTimers({ toFake: ['setImmediate', 'clearImmediate'] });
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
      for (let step = 0; step < 10; step++) await Promise.resolve();
      expect(take).toHaveBeenCalledTimes(i + 1);
    }
  } finally {
    topics.close();
    vi.useRealTimers();
  }
});
