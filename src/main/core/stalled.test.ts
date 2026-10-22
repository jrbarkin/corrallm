import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NetworkInterfaceInfo } from 'node:os';

import type { CanvasId } from '../../shared/canvas';
import { CATALOG } from '../sessions/adapters';
import { StalledTurns, STALL_MS, WAKE_GRACE_MS, WATCH_EVERY_MS } from './stalled';

const CANVAS = '01234567-1234-4123-8123-123456789abc' as CanvasId;
const AGENT = 'a/b\n';
let watchdog: StalledTurns;
const warning = vi.fn();
const changed = vi.fn();
let interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>;
const network = vi.fn(() => interfaces);

function address(
  ip: string,
  family: 'IPv4' | 'IPv6' = 'IPv4',
  internal = false,
): NetworkInterfaceInfo {
  const common = { address: ip, netmask: '', mac: '', cidr: null, internal };
  return family === 'IPv4' ? { ...common, family } : { ...common, family, scopeid: 0 };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  warning.mockClear();
  changed.mockClear();
  interfaces = { en0: [address('192.0.2.1'), address('2001:db8:1:2::1234', 'IPv6')] };
  network.mockClear();
  watchdog = new StalledTurns({ catalog: CATALOG, warning, changed, network });
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
  it('reports a silent turn two minutes after the network identity changes', async () => {
    start();
    await vi.advanceTimersByTimeAsync(WATCH_EVERY_MS);
    interfaces = { en0: [address('198.51.100.1')] };
    await vi.advanceTimersByTimeAsync(WATCH_EVERY_MS);
    await vi.advanceTimersByTimeAsync(WAKE_GRACE_MS - WATCH_EVERY_MS);
    expect(warning).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(WATCH_EVERY_MS);
    expect(warning).toHaveBeenCalledExactlyOnceWith(
      CANVAS,
      AGENT,
      'codex.app-server',
      ['message'],
      'No activity from Codex for 2 minutes after the network changed: its connection may have dropped. Interrupt to stop the turn.',
    );
    expect(watchdog.items(CANVAS)[0]?.choices).toEqual([
      { value: 'interrupt', label: 'Interrupt' },
    ]);
  });

  it('ignores IPv6 privacy rotation, link-local and internal addresses, duplicates and ordering', async () => {
    interfaces = {
      en0: [
        address('192.0.2.1'),
        address('2001:db8:1:2::abcd', 'IPv6'),
        address('fe80::1', 'IPv6'),
      ],
      lo0: [address('127.0.0.1', 'IPv4', true)],
    };
    start();
    await vi.advanceTimersByTimeAsync(WATCH_EVERY_MS);
    interfaces = {
      lo0: [address('::1', 'IPv6', true)],
      en0: [
        address('febf::abcd', 'IPv6'),
        address('2001:0DB8:0001:0002:abcd::1', 'IPv6'),
        address('192.0.2.1'),
        address('2001:db8:1:2::9876', 'IPv6'),
      ],
      en1: [address('fe90::2', 'IPv6')],
    };
    await vi.advanceTimersByTimeAsync(WAKE_GRACE_MS + WATCH_EVERY_MS);
    expect(warning).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(STALL_MS);
    expect(warning.mock.calls[0]?.[4]).toContain('20 minutes');
  });

  it.each(['IPv4 address', 'IPv6 prefix', 'interface removed', 'interface changed'])(
    'detects a changed %s',
    async (change) => {
      start();
      await vi.advanceTimersByTimeAsync(WATCH_EVERY_MS);
      if (change === 'IPv4 address')
        interfaces.en0 = [address('192.0.2.2'), address('2001:db8:1:2::1234', 'IPv6')];
      else if (change === 'IPv6 prefix')
        interfaces.en0 = [address('192.0.2.1'), address('2001:db8:1:3::1234', 'IPv6')];
      else if (change === 'interface removed') interfaces = {};
      else interfaces = { en1: interfaces.en0 };
      await vi.advanceTimersByTimeAsync(WATCH_EVERY_MS + WAKE_GRACE_MS);
      expect(warning.mock.calls[0]?.[4]).toContain('2 minutes after the network changed');
    },
  );

  it('keeps the normal deadline for activity after a detected network change', async () => {
    start();
    await vi.advanceTimersByTimeAsync(WATCH_EVERY_MS);
    interfaces = {};
    await vi.advanceTimersByTimeAsync(WATCH_EVERY_MS);
    watchdog.activity(CANVAS, AGENT);
    await vi.advanceTimersByTimeAsync(WAKE_GRACE_MS);
    expect(warning).not.toHaveBeenCalled();
    expect(watchdog.items(CANVAS)).toEqual([]);
    await vi.advanceTimersByTimeAsync(STALL_MS - WAKE_GRACE_MS);
    expect(warning.mock.calls[0]?.[4]).toContain('20 minutes');
  });

  it('gives grace when activity arrives just before a network change between samples', async () => {
    start();
    await vi.advanceTimersByTimeAsync(WATCH_EVERY_MS);
    await vi.advanceTimersByTimeAsync(1000);
    watchdog.activity(CANVAS, AGENT);
    interfaces = {};
    await vi.advanceTimersByTimeAsync(WATCH_EVERY_MS - 1000);
    await vi.advanceTimersByTimeAsync(WAKE_GRACE_MS);
    expect(warning.mock.calls[0]?.[4]).toContain('2 minutes after the network changed');
  });

  it('uses the first reading only as a baseline', async () => {
    start();
    expect(network).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(WAKE_GRACE_MS + WATCH_EVERY_MS);
    expect(network).toHaveBeenCalled();
    expect(warning).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(STALL_MS);
    expect(warning.mock.calls[0]?.[4]).toContain('20 minutes');
  });

  it.each([
    ['2001:db8::1', '2001:0DB8:0:0:abcd::9876'],
    ['::1:2:3:4:192.0.2.1', '0:0:1:2::ffff'],
    ['::ffff:192.0.2.1', '0:0:0:0:0:ffff:c000:202'],
  ])('normalizes equivalent /64 prefixes: %s → %s', async (before, after) => {
    interfaces = { en0: [address(before, 'IPv6')] };
    start();
    await vi.advanceTimersByTimeAsync(WATCH_EVERY_MS);
    interfaces = { en0: [address(after, 'IPv6')] };
    await vi.advanceTimersByTimeAsync(WAKE_GRACE_MS + WATCH_EVERY_MS);
    expect(warning).not.toHaveBeenCalled();
  });

  it('does not keep extending grace when the network changes repeatedly', async () => {
    start();
    await vi.advanceTimersByTimeAsync(WATCH_EVERY_MS);
    interfaces = {};
    await vi.advanceTimersByTimeAsync(WATCH_EVERY_MS);
    for (let i = 0; i < WAKE_GRACE_MS / WATCH_EVERY_MS; i++) {
      interfaces = { en0: [address(`192.0.2.${String(i + 2)}`)] };
      await vi.advanceTimersByTimeAsync(WATCH_EVERY_MS);
    }
    expect(warning).toHaveBeenCalledOnce();
    expect(warning.mock.calls[0]?.[4]).toContain('2 minutes after the network changed');
  });

  it('uses network wording when a late timer also observes a changed network', async () => {
    start();
    await vi.advanceTimersByTimeAsync(WATCH_EVERY_MS);
    interfaces = {};
    vi.setSystemTime(Date.now() + 60 * 60_000);
    await vi.advanceTimersByTimeAsync(WATCH_EVERY_MS);
    expect(warning).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(WAKE_GRACE_MS);
    expect(warning.mock.calls[0]?.[4]).toContain('2 minutes after the network changed');
  });

  it('retains the last good identity and says a failing reader only once', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      start();
      await vi.advanceTimersByTimeAsync(WATCH_EVERY_MS);
      network.mockImplementation(() => {
        throw new Error('interfaces unavailable');
      });
      interfaces = {};
      await vi.advanceTimersByTimeAsync(WAKE_GRACE_MS + WATCH_EVERY_MS);
      expect(warning).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledOnce();
      expect(error.mock.calls.flat().join(' ')).toContain('interfaces unavailable');
      network.mockImplementation(() => interfaces);
      await vi.advanceTimersByTimeAsync(WATCH_EVERY_MS + WAKE_GRACE_MS);
      expect(warning.mock.calls[0]?.[4]).toContain('2 minutes after the network changed');
      expect(error).toHaveBeenCalledOnce();
    } finally {
      network.mockImplementation(() => interfaces);
      error.mockRestore();
    }
  });

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
