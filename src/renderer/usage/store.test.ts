import { describe, expect, it, vi } from 'vitest';

import type { UsageState } from '../../shared/usage';
import { UsageStore } from './store';
import type { UsageSource } from './store';

const RULE = { window: 'fiveHour', percent: 80, action: 'ask' } as const;
const reading = (usedPercent: number): UsageState => ({
  readings: [{ backend: 'Claude', windows: { fiveHour: { usedPercent, resetsAt: null } }, at: 1 }],
  rules: {},
});

/** Main's usage, faked: `emit` plays a 'usage:changed' event. */
function fakeSource(initial: UsageState) {
  let listener: ((state: UsageState) => void) | undefined;
  let resolve: (state: UsageState) => void = () => undefined;
  const source = {
    get: vi.fn<UsageSource['get']>(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    ),
    setRule: vi.fn<UsageSource['setRule']>().mockResolvedValue(null),
    simulate: vi.fn<UsageSource['simulate']>().mockResolvedValue(null),
    onChanged: vi.fn<UsageSource['onChanged']>((given) => {
      listener = given;
      return () => {
        listener = undefined;
      };
    }),
  };
  return {
    source,
    answer: () => {
      resolve(initial);
    },
    emit: (state: UsageState) => listener?.(state),
    listening: () => listener !== undefined,
  };
}

describe('UsageStore', () => {
  it('starts from main’s readings, then follows each change main tells', async () => {
    const main = fakeSource(reading(10));
    const store = new UsageStore(main.source);
    const heard = vi.fn<() => void>();
    store.subscribe(heard);
    expect(store.snapshot()).toEqual({ readings: [], rules: {} });
    main.answer();
    await vi.waitFor(() => {
      expect(store.snapshot()).toEqual(reading(10));
    });
    main.emit(reading(20));
    expect(store.snapshot()).toEqual(reading(20));
    expect(heard).toHaveBeenCalledTimes(2);
    store.dispose();
    expect(main.listening()).toBe(false);
  });

  it('keeps a change main told over the readings it asked for before', async () => {
    const main = fakeSource(reading(10));
    const store = new UsageStore(main.source);
    main.emit(reading(30));
    main.answer();
    await Promise.resolve();
    await Promise.resolve();
    expect(store.snapshot()).toEqual(reading(30));
  });

  it('asks main to set rules and simulate readings, and hears the change back', () => {
    const main = fakeSource(reading(10));
    const store = new UsageStore(main.source);
    store.setRule('Claude', RULE);
    expect(main.source.setRule).toHaveBeenCalledWith('Claude', RULE);
    store.simulate('Claude', { weekly: { usedPercent: 91, resetsAt: null } });
    expect(main.source.simulate).toHaveBeenCalledWith('Claude', {
      weekly: { usedPercent: 91, resetsAt: null },
    });
    // Main's word is what counts.
    expect(store.snapshot()).toEqual({ readings: [], rules: {} });
  });

  it('keeps rules and simulated readings itself without main (as in tests)', () => {
    const store = new UsageStore(undefined, () => 5_000);
    store.setRule('Claude', RULE);
    store.simulate('Claude', { weekly: { usedPercent: 91, resetsAt: null } });
    expect(store.snapshot()).toEqual({
      readings: [
        {
          backend: 'Claude',
          windows: { weekly: { usedPercent: 91, resetsAt: null } },
          at: 5_000,
          simulated: true,
        },
      ],
      rules: { Claude: RULE },
    });
    store.setRule('Claude', null);
    store.simulate('Claude', null);
    expect(store.snapshot()).toEqual({ readings: [], rules: {} });
  });
});
