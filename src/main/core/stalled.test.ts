import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import type { NetworkInterfaceInfo } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';

import type { SessionEvent } from '../../shared/session';
import { TerminalSession, TIMING } from '../sessions/terminal/session';
import type { TerminalCli } from '../sessions/terminal/cli';
import type { Pty } from '../sessions/terminal/pty';
import { HookServer } from '../sessions/terminal/hooks';
import type { CanvasId } from '../../shared/canvas';
import { CATALOG } from '../sessions/adapters';
import { ClaudeCode } from '../sessions/claude-code/claude-code';
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
  it.each(['normal deadline', 'wake', 'network change'])(
    'does not flag a permission wait past its %s, and restarts silence once working',
    async (disruption) => {
      start();
      watchdog.event(CANVAS, AGENT, 'codex.app-server', {
        type: 'permission',
        id: 'approval',
        tool: 'Run',
        summary: 'May I?',
        always: null,
      });
      watchdog.event(CANVAS, AGENT, 'codex.app-server', { type: 'status', status: 'waiting' });
      await vi.advanceTimersByTimeAsync(WATCH_EVERY_MS);
      if (disruption === 'wake') watchdog.resume();
      if (disruption === 'network change') interfaces = {};
      await vi.advanceTimersByTimeAsync(STALL_MS * 2);
      expect(warning).not.toHaveBeenCalled();
      expect(watchdog.items(CANVAS)).toEqual([]);
      // SDK answers close their prompt by reporting working, without a withdrawn event.
      watchdog.event(CANVAS, AGENT, 'codex.app-server', { type: 'status', status: 'working' });
      await vi.advanceTimersByTimeAsync(STALL_MS - WATCH_EVERY_MS);
      expect(warning).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(WATCH_EVERY_MS);
      expect(warning).toHaveBeenCalledOnce();
      expect(warning.mock.calls[0]?.[4]).toContain('20 minutes');
    },
  );

  it.each<SessionEvent>([
    { type: 'status', status: 'waiting' },
    { type: 'permission', id: 'p', tool: 'Run', summary: 'May I?', always: null },
    { type: 'question', id: 'p', questions: [] },
    { type: 'plan', id: 'p', plan: 'A plan' },
    { type: 'elicitation', id: 'p', server: 'server', message: 'A question' },
    { type: 'asking', asks: [{ kind: 'trust', id: 'trust' }] },
  ])('suspends silence on $type even without another waiting signal', async (event) => {
    start();
    watchdog.event(CANVAS, AGENT, 'codex.app-server', event);
    await vi.advanceTimersByTimeAsync(STALL_MS * 2);
    expect(warning).not.toHaveBeenCalled();
    expect(watchdog.items(CANVAS)).toEqual([]);
    if (event.type === 'asking') {
      watchdog.event(CANVAS, AGENT, 'codex.app-server', { type: 'asking', asks: [] });
    } else if ('id' in event) {
      watchdog.event(CANVAS, AGENT, 'codex.app-server', { type: 'withdrawn', id: event.id });
    } else {
      watchdog.event(CANVAS, AGENT, 'codex.app-server', { type: 'status', status: 'working' });
    }
    await vi.advanceTimersByTimeAsync(STALL_MS);
    expect(warning).toHaveBeenCalledOnce();
  });

  it('clears a stalled Need while the turn waits on the user, including after a wake', async () => {
    start();
    await vi.advanceTimersByTimeAsync(STALL_MS);
    expect(watchdog.items(CANVAS)).toHaveLength(1);
    watchdog.event(CANVAS, AGENT, 'codex.app-server', { type: 'status', status: 'waiting' });
    expect(watchdog.items(CANVAS)).toEqual([]);
    watchdog.resume();
    await vi.advanceTimersByTimeAsync(STALL_MS);
    expect(watchdog.items(CANVAS)).toEqual([]);
    expect(warning).toHaveBeenCalledOnce();
  });

  it('keeps waiting until every prompt closes, despite unrelated activity', async () => {
    start();
    watchdog.event(CANVAS, AGENT, 'codex.app-server', { type: 'plan', id: 'one', plan: 'Plan' });
    watchdog.event(CANVAS, AGENT, 'codex.app-server', {
      type: 'question',
      id: 'two',
      questions: [],
    });
    watchdog.event(CANVAS, AGENT, 'codex.app-server', { type: 'withdrawn', id: 'one' });
    watchdog.activity(CANVAS, AGENT);
    await vi.advanceTimersByTimeAsync(STALL_MS * 2);
    expect(warning).not.toHaveBeenCalled();
    watchdog.event(CANVAS, AGENT, 'codex.app-server', { type: 'withdrawn', id: 'two' });
    await vi.advanceTimersByTimeAsync(STALL_MS - WATCH_EVERY_MS);
    expect(warning).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(WATCH_EVERY_MS);
    expect(warning).toHaveBeenCalledOnce();
  });

  it('flags a silent Terminal turn despite a spinner frame every second for twenty minutes', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'corrallm-spinner-'));
    const hooks = new HookServer();
    const registration = vi.spyOn(hooks, 'register').mockResolvedValue({
      url: 'http://127.0.0.1/hook',
      statusUrl: 'http://127.0.0.1/status',
      token: 'test-token',
      release: () => undefined,
    });
    let output: (data: string) => void = () => undefined;
    let exit: (event: { exitCode: number }) => void = () => undefined;
    const pty: Pty = {
      pid: 4242,
      write: () => undefined,
      resize: () => undefined,
      pause: () => undefined,
      resume: () => undefined,
      kill: () => {
        exit({ exitCode: 0 });
      },
      onData: (listener) => {
        output = listener;
      },
      onExit: (listener) => {
        exit = listener;
      },
    };
    const cli: TerminalCli<never> = {
      name: 'Test CLI',
      words: {
        answer: '',
        mode: '',
        model: '',
        login: '',
        waiting: { permission: '', question: '', auth: '', none: '' },
      },
      newId: () => null,
      prepare: () => Promise.resolve(),
      args: () => [],
      resumeFailed: () => false,
      keystrokes: () => [],
      submitted: (text) => text,
      draft: () => undefined,
      hook: () => [],
      title: () => ({ state: 'working' }),
    };
    const session = new TerminalSession(
      { agentId: AGENT, cwd: dir, env: {}, model: null, mode: null, resume: null },
      {
        remember: () => undefined,
        emit: (event: SessionEvent) => {
          watchdog.event(CANVAS, AGENT, 'codex.terminal', event);
        },
        activity: () => {
          watchdog.activity(CANVAS, AGENT);
        },
      },
      {
        executable: '/fake/cli',
        cli,
        spawn: () => Promise.resolve(pty),
        hooks,
        tmp: dir,
        env: () => ({}),
        timing: { ...TIMING, kill: 1 },
      },
    );
    try {
      await session.launch();
      for (let second = 0; second <= STALL_MS / 1000; second++) {
        // Neither the changing activity title nor an identical Program Status proves progress.
        output(
          `\x1b]0;Working (${String(second)}s)\x07\x1b]7501;state=working:progress=0\x07\r${second % 2 ? '◐' : '◓'} Working ${String(second)}s`,
        );
        await vi.advanceTimersByTimeAsync(1000);
      }
      expect(watchdog.items(CANVAS)).toHaveLength(1);
      expect(warning).toHaveBeenCalledOnce();
      // Native progress still proves activity even without a hook or transcript event.
      output('\x1b]7501;state=working:progress=10\x07');
      await vi.advanceTimersByTimeAsync(1000);
      expect(watchdog.items(CANVAS)).toEqual([]);
    } finally {
      watchdog.close();
      const closing = session.close();
      await vi.advanceTimersByTimeAsync(100);
      await closing;
      registration.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('flags a silent Claude Code Terminal turn despite its status line refreshing every second for twenty minutes', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'corrallm-statusline-'));
    const hooks = new HookServer();
    let post: (input: Record<string, unknown>) => void = () => undefined;
    const registration = vi.spyOn(hooks, 'register').mockImplementation((_listener, status) => {
      post = (input) => status?.(input);
      return Promise.resolve({
        url: 'http://127.0.0.1/hook',
        statusUrl: 'http://127.0.0.1/status',
        token: 'test-token',
        release: () => undefined,
      });
    });
    let exit: (event: { exitCode: number }) => void = () => undefined;
    const pty: Pty = {
      pid: 4243,
      write: () => undefined,
      resize: () => undefined,
      pause: () => undefined,
      resume: () => undefined,
      kill: () => {
        exit({ exitCode: 0 });
      },
      onData: () => undefined,
      onExit: (listener) => {
        exit = listener;
      },
    };
    // Claude Code's own reading of its status line input; the rest of the CLI is a stand-in.
    const claude = new ClaudeCode({ cwd: dir, home: dir, env: {} });
    const cli: TerminalCli<never> = {
      name: 'Test CLI',
      words: {
        answer: '',
        mode: '',
        model: '',
        login: '',
        waiting: { permission: '', question: '', auth: '', none: '' },
      },
      newId: () => null,
      prepare: () => Promise.resolve(),
      args: () => [],
      resumeFailed: () => false,
      keystrokes: () => [],
      submitted: (text) => text,
      draft: () => undefined,
      hook: () => [],
      statusLine: (input) => claude.statusLine(input),
    };
    const session = new TerminalSession(
      { agentId: AGENT, cwd: dir, env: {}, model: null, mode: null, resume: null },
      {
        remember: () => undefined,
        emit: (event: SessionEvent) => {
          watchdog.event(CANVAS, AGENT, 'claude-code.terminal', event);
        },
        activity: () => {
          watchdog.activity(CANVAS, AGENT);
        },
      },
      {
        executable: '/fake/cli',
        cli,
        spawn: () => Promise.resolve(pty),
        hooks,
        tmp: dir,
        env: () => ({}),
        timing: { ...TIMING, kill: 1 },
      },
    );
    // What Claude Code 2.1.310 gives its status line, as its refreshInterval re-runs it: only its
    // clock moves (and its limits, which other sessions of the account use too).
    const input = (second: number, output = 4521) => ({
      hook_event_name: 'Status',
      session_id: '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e11',
      model: { id: 'claude-opus-4-1', display_name: 'Opus' },
      cost: {
        total_cost_usd: 0.01234 + (output - 4521) / 1e6,
        total_duration_ms: 45_000 + second * 1000,
        total_api_duration_ms: 2300 + (output - 4521),
        total_lines_added: 156,
        total_lines_removed: 23,
      },
      context_window: {
        total_input_tokens: 15_234,
        total_output_tokens: output,
        context_window_size: 200_000,
        used_percentage: 8,
        remaining_percentage: 92,
      },
      rate_limits: {
        five_hour: { used_percentage: 23 + (second % 7), resets_at: 1_791_810_000 },
      },
    });
    try {
      await session.launch();
      watchdog.event(CANVAS, AGENT, 'claude-code.terminal', { type: 'user', id: 'm', text: 'Go' });
      watchdog.event(CANVAS, AGENT, 'claude-code.terminal', { type: 'status', status: 'working' });
      for (let second = 0; second <= STALL_MS / 1000; second++) {
        post(input(second));
        await vi.advanceTimersByTimeAsync(1000);
      }
      expect(watchdog.items(CANVAS)).toHaveLength(1);
      expect(warning).toHaveBeenCalledOnce();
      // Its model at work moves its tokens and API time: that is activity.
      post(input(STALL_MS / 1000 + 1, 4600));
      await vi.advanceTimersByTimeAsync(1000);
      expect(watchdog.items(CANVAS)).toEqual([]);
    } finally {
      watchdog.close();
      const closing = session.close();
      await vi.advanceTimersByTimeAsync(100);
      await closing;
      registration.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

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
      { value: 'resend', label: 'Interrupt and resend' },
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

  it('does not shorten a silent turn’s deadline when the snapshot gains a br-123 interface', async () => {
    start();
    await vi.advanceTimersByTimeAsync(WATCH_EVERY_MS);
    interfaces = { ...interfaces, 'br-123': [address('172.18.0.1')] };
    await vi.advanceTimersByTimeAsync(WATCH_EVERY_MS + WAKE_GRACE_MS);
    expect(warning).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(STALL_MS);
    expect(warning).toHaveBeenCalledOnce();
    expect(warning.mock.calls[0]?.[4]).toContain('20 minutes');
  });

  it.each(['docker0', 'br-0a1b2c3d4e5f', 'veth1a2b3c', 'virbr0', 'cni0', 'podman1', 'bridge100'])(
    'ignores the virtual bridge %s coming up and going down',
    async (name) => {
      start();
      await vi.advanceTimersByTimeAsync(WATCH_EVERY_MS);
      const host = interfaces;
      interfaces = {
        ...host,
        [name]: [address('172.18.0.1'), address('fd00:1:2:3::1', 'IPv6')],
      };
      await vi.advanceTimersByTimeAsync(WATCH_EVERY_MS);
      interfaces = { ...host, [name]: [address('172.19.0.1'), address('fd00:1:2:4::1', 'IPv6')] };
      await vi.advanceTimersByTimeAsync(WATCH_EVERY_MS);
      interfaces = host;
      await vi.advanceTimersByTimeAsync(WATCH_EVERY_MS + WAKE_GRACE_MS);
      expect(warning).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(STALL_MS);
      expect(warning).toHaveBeenCalledOnce();
      expect(warning.mock.calls[0]?.[4]).toContain('20 minutes');
    },
  );

  it('still watches a host bridge such as br0, which can carry the host’s own address', async () => {
    interfaces = { br0: [address('192.0.2.1')] };
    start();
    await vi.advanceTimersByTimeAsync(WATCH_EVERY_MS);
    interfaces = { br0: [address('192.0.2.2')] };
    await vi.advanceTimersByTimeAsync(WATCH_EVERY_MS + WAKE_GRACE_MS);
    expect(warning.mock.calls[0]?.[4]).toContain('2 minutes after the network changed');
  });

  it('counts only a lost address as a change, not a new one, including one that later goes', async () => {
    start();
    await vi.advanceTimersByTimeAsync(WATCH_EVERY_MS);
    const before = interfaces;
    interfaces = {
      en0: [...(before.en0 ?? []), address('192.0.2.7')],
      utun4: [address('10.8.0.2')],
    };
    await vi.advanceTimersByTimeAsync(WATCH_EVERY_MS + WAKE_GRACE_MS);
    expect(warning).not.toHaveBeenCalled();
    interfaces = { en0: interfaces.en0 };
    await vi.advanceTimersByTimeAsync(WATCH_EVERY_MS + WAKE_GRACE_MS);
    expect(warning).toHaveBeenCalledOnce();
    expect(warning.mock.calls[0]?.[4]).toContain('2 minutes after the network changed');
  });

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
        choices: [
          { value: 'interrupt', label: 'Interrupt' },
          { value: 'resend', label: 'Interrupt and resend' },
        ],
      }),
    ]);
    await vi.advanceTimersByTimeAsync(STALL_MS);
    expect(warning).toHaveBeenCalledTimes(1);
  });

  it('counts session events and meaningful connector activity, clearing a warning on activity', async () => {
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
