import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CanvasId } from '../../shared/canvas';
import { CATALOG } from '../sessions/adapters';
import { StalledTurns, STALL_MS, WAKE_GRACE_MS, WATCH_EVERY_MS } from './stalled';

const CANVAS = '01234567-1234-4123-8123-123456789abc' as CanvasId;
const AGENT = 'a/b\n';
let watchdog: StalledTurns;
const warning = vi.fn();
const changed = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  warning.mockClear();
  changed.mockClear();
  watchdog = new StalledTurns({ catalog: CATALOG, warning, changed });
});
afterEach(() => {
  watchdog.close();
  vi.useRealTimers();
});

function start(id = 'message') {
  watchdog.event(CANVAS, AGENT, 'codex.app-server', { type: 'user', id, text: 'Hello' });
  watchdog.event(CANVAS, AGENT, 'codex.app-server', { type: 'status', status: 'working' });
}

describe('silent turns', () => {
  it('warns once, names the catalog CLI, and offers an escaped, user-only Interrupt item', async () => {
    start();
    await vi.advanceTimersByTimeAsync(STALL_MS - WATCH_EVERY_MS);
    expect(warning).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(WATCH_EVERY_MS);
    expect(warning).toHaveBeenCalledExactlyOnceWith(
      CANVAS,
      AGENT,
      'codex.app-server',
      ['message'],
      'No activity from Codex for 20 minutes: its connection may have dropped. Interrupt to stop the turn.',
    );
    expect(watchdog.items(CANVAS)).toEqual([
      expect.objectContaining({
        id: `stalled/${encodeURIComponent(AGENT)}`,
        agent: AGENT,
        for: 'you',
        by: ['you'],
        answerIn: 'api',
        choices: [{ value: 'interrupt', label: 'Interrupt' }],
      }),
    ]);
    await vi.advanceTimersByTimeAsync(STALL_MS);
    expect(warning).toHaveBeenCalledTimes(1);
  });

  it('counts every session event and raw connector activity, clearing a warning on activity', async () => {
    start();
    await vi.advanceTimersByTimeAsync(STALL_MS - WATCH_EVERY_MS);
    watchdog.event(CANVAS, AGENT, 'codex.app-server', {
      type: 'usage',
      usage: { costUsd: null, contextTokens: 1, contextWindow: 100 },
    });
    await vi.advanceTimersByTimeAsync(WATCH_EVERY_MS);
    expect(warning).not.toHaveBeenCalled();
    watchdog.activity(CANVAS, AGENT);
    await vi.advanceTimersByTimeAsync(STALL_MS);
    expect(watchdog.items(CANVAS)).toHaveLength(1);
    watchdog.activity(CANVAS, AGENT);
    expect(watchdog.items(CANVAS)).toEqual([]);
    await vi.advanceTimersByTimeAsync(STALL_MS);
    expect(warning).toHaveBeenCalledTimes(1);
  });

  it.each(['end', 'closed', 'cleared'] as const)(
    'clears on %s and gives a later turn its own warning',
    async (type) => {
      start();
      await vi.advanceTimersByTimeAsync(STALL_MS);
      watchdog.event(
        CANVAS,
        AGENT,
        'codex.app-server',
        type === 'end'
          ? {
              type,
              messages: ['message'],
              seconds: 1,
              result: { status: 'completed', reason: 'completed' },
            }
          : type === 'cleared'
            ? { type, id: 'clear' }
            : { type },
      );
      expect(watchdog.items(CANVAS)).toEqual([]);
      start('next');
      await vi.advanceTimersByTimeAsync(STALL_MS);
      expect(warning).toHaveBeenCalledTimes(2);
    },
  );

  it('gives a pre-sleep turn two fresh minutes on a wall-clock jump, without an immediate warning', async () => {
    start();
    vi.setSystemTime(Date.now() + 5 * 60 * 60_000);
    await vi.advanceTimersByTimeAsync(WATCH_EVERY_MS);
    expect(warning).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(WAKE_GRACE_MS);
    expect(warning).toHaveBeenCalledOnce();
    expect(warning.mock.calls[0]?.[4]).toContain('2 minutes after waking');
  });

  it('also accepts a host resume and resumes the normal deadline after fresh activity', async () => {
    start();
    vi.setSystemTime(Date.now() + 60 * 60_000);
    watchdog.resume();
    await vi.advanceTimersByTimeAsync(WAKE_GRACE_MS - WATCH_EVERY_MS);
    watchdog.activity(CANVAS, AGENT);
    await vi.advanceTimersByTimeAsync(WAKE_GRACE_MS);
    expect(warning).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(STALL_MS);
    expect(warning).toHaveBeenCalledOnce();
  });

  it('does not shorten a fresh event received after waking or extend grace for duplicate resumes', async () => {
    start();
    vi.setSystemTime(Date.now() + 60 * 60_000);
    watchdog.activity(CANVAS, AGENT);
    await vi.advanceTimersByTimeAsync(WAKE_GRACE_MS);
    expect(warning).not.toHaveBeenCalled();
    watchdog.resume();
    await vi.advanceTimersByTimeAsync(60_000);
    watchdog.resume();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(warning).toHaveBeenCalledOnce();
  });

  it('does not start a turn from history or an idle status and cancels its timer on close', async () => {
    watchdog.event(CANVAS, AGENT, 'codex.app-server', {
      type: 'history',
      events: [
        { type: 'user', id: 'old', text: 'old' },
        { type: 'status', status: 'working' },
      ],
    });
    watchdog.event(CANVAS, AGENT, 'codex.app-server', {
      type: 'started',
      mode: null,
      model: null,
      models: [],
    });
    await vi.advanceTimersByTimeAsync(STALL_MS);
    expect(warning).not.toHaveBeenCalled();
    watchdog.close();
    expect(vi.getTimerCount()).toBe(0);
  });
});
