import { describe, expect, it, vi } from 'vitest';

import type { UsageState } from '../../shared/usage';
import { UsageStore } from './store';
import type { UsageSource } from './store';

const RULE = { window: 'fiveHour', percent: 80, action: 'ask' } as const;
const reading = (usedPercent: number): UsageState => ({
  readings: [
    { backend: 'claude-code', windows: { fiveHour: { usedPercent, resetsAt: null } }, at: 1 },
  ],
  rules: {},
});

/** A usage topic mirror and the operations that change its source in the core. */
function fakeSource(initial: UsageState) {
  let listener: (() => void) | undefined;
  let state: UsageState | undefined;
  const source = {
    topics: {
      snapshot: vi.fn(() => state),
      subscribe: vi.fn((_topic: 'usage', given: () => void) => {
        listener = given;
        return () => {
          listener = undefined;
        };
      }),
    },
    setRule: vi.fn<UsageSource['setRule']>().mockResolvedValue({}),
    simulate: vi.fn<UsageSource['simulate']>().mockResolvedValue({}),
  };
  return {
    source,
    answer: () => {
      state = initial;
      listener?.();
    },
    emit: (next: UsageState) => {
      state = next;
      listener?.();
    },
    listening: () => listener !== undefined,
  };
}

describe('UsageStore', () => {
  it('starts from the usage topic, then follows its mirror', async () => {
    const core = fakeSource(reading(10));
    const store = new UsageStore(core.source);
    const heard = vi.fn<() => void>();
    store.subscribe(heard);
    expect(store.snapshot()).toEqual({ readings: [], rules: {} });
    core.answer();
    await vi.waitFor(() => {
      expect(store.snapshot()).toEqual(reading(10));
    });
    core.emit(reading(20));
    expect(store.snapshot()).toEqual(reading(20));
    expect(heard).toHaveBeenCalledTimes(2);
    store.dispose();
    expect(core.listening()).toBe(false);
  });

  it('starts from a snapshot the topic mirror already has', async () => {
    const core = fakeSource(reading(10));
    core.emit(reading(30));
    const store = new UsageStore(core.source);
    await Promise.resolve();
    await Promise.resolve();
    expect(store.snapshot()).toEqual(reading(30));
  });

  it('asks the core to set rules and simulate readings, and hears the change back', () => {
    const core = fakeSource(reading(10));
    const store = new UsageStore(core.source);
    store.setRule('claude-code', RULE);
    expect(core.source.setRule).toHaveBeenCalledWith('claude-code', RULE);
    store.simulate('claude-code', { weekly: { usedPercent: 91, resetsAt: null } });
    expect(core.source.simulate).toHaveBeenCalledWith('claude-code', {
      weekly: { usedPercent: 91, resetsAt: null },
    });
    // The topic's state is what counts.
    expect(store.snapshot()).toEqual({ readings: [], rules: {} });
  });

  it('keeps rules and simulated readings itself without a source (as in tests)', () => {
    const store = new UsageStore(undefined, () => 5_000);
    store.setRule('claude-code', RULE);
    store.simulate('claude-code', { weekly: { usedPercent: 91, resetsAt: null } });
    expect(store.snapshot()).toEqual({
      readings: [
        {
          backend: 'claude-code',
          windows: { weekly: { usedPercent: 91, resetsAt: null } },
          at: 5_000,
          simulated: true,
        },
      ],
      rules: { 'claude-code': RULE },
    });
    store.setRule('claude-code', null);
    store.simulate('claude-code', null);
    expect(store.snapshot()).toEqual({ readings: [], rules: {} });
  });
});
