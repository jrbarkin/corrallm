import { afterEach, expect, it, vi } from 'vitest';

import { newCanvasId } from '../../shared/canvas';
import { SessionViews } from './session-views';
import type { ViewedSession } from './session-views';

afterEach(() => {
  vi.useRealTimers();
});

function setup() {
  vi.useFakeTimers();
  const canvas = newCanvasId();
  const stop = vi.fn();
  const open = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
  const say = vi.fn();
  let changed: () => void = () => undefined;
  let state: ViewedSession = { owner: {}, key: 'generation-0' };
  const inspect = vi.fn(() => Promise.resolve(state));
  const views = new SessionViews({
    inspect,
    open,
    say,
    watch: (_canvas, listener) => {
      changed = listener;
      return stop;
    },
  });
  return {
    views,
    canvas,
    open,
    stop,
    inspect,
    say,
    changed: () => {
      changed();
    },
    next: () => {
      state = { ...state, key: 'generation-1' };
      changed();
    },
  };
}

it('defers release per window/topic and stops its watcher only after the last window goes', async () => {
  const { views, canvas, open, stop, next } = setup();
  const release = views.acquire(1, canvas, 'a');
  release();
  const rehearsal = views.acquire(1, canvas, 'a');
  const second = views.acquire(2, canvas, 'a');
  await vi.waitFor(() => {
    expect(open).toHaveBeenCalledOnce();
  });
  rehearsal();
  await vi.runOnlyPendingTimersAsync();
  expect(stop).not.toHaveBeenCalled();
  second();
  second();
  await vi.runOnlyPendingTimersAsync();
  expect(stop).toHaveBeenCalledOnce();
  next();
  expect(open).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  views.close();
});

it('does not open after the final release while the directory lookup is pending', async () => {
  const { views, canvas, inspect, open, stop } = setup();
  const lookup = Promise.withResolvers<ViewedSession>();
  inspect.mockImplementation(() => lookup.promise);
  views.acquire(1, canvas, 'a')();
  await vi.runOnlyPendingTimersAsync();
  lookup.resolve({ owner: {}, key: 'ready' });
  await lookup.promise;
  expect(open).not.toHaveBeenCalled();
  expect(stop).toHaveBeenCalledOnce();
  views.close();
});

it('closing clears deferred releases and prevents pending lookups and later notifications opening a session', async () => {
  const { views, canvas, inspect, open, stop, changed } = setup();
  const lookup = Promise.withResolvers<ViewedSession>();
  inspect.mockImplementation(() => lookup.promise);
  views.acquire(1, canvas, 'a')();
  views.close();
  changed();
  lookup.resolve({ owner: {}, key: 'ready' });
  await lookup.promise;
  expect(open).not.toHaveBeenCalled();
  expect(stop).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it('a launch deferred by shutdown can be admitted after cancellation at the same binding', async () => {
  const { views, canvas, open } = setup();
  open.mockResolvedValueOnce(false);
  views.acquire(1, canvas, 'a');
  await vi.waitFor(() => {
    expect(open).toHaveBeenCalledOnce();
  });
  views.changed();
  await vi.waitFor(() => {
    expect(open).toHaveBeenCalledTimes(2);
  });
  views.close();
});
