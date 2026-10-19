import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Children } from './children';
import type { ChildSystem } from './children';

class Child extends EventEmitter {
  readonly kill = vi.fn();
  readonly pid: number;
  constructor(pid: number) {
    super();
    this.pid = pid;
  }
}

let profile: string;
let file: string;
let children: Children;
let live: Map<number, { started: number; group: number }>;
let groups: Set<number>;
let system: ChildSystem;

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-children-'));
  file = path.join(profile, 'sessions', 'pids.json');
  live = new Map([[42, { started: 1000, group: 42 }]]);
  groups = new Set([42]);
  system = {
    platform: 'linux',
    inspect: vi.fn<ChildSystem['inspect']>((pid) => live.get(pid)),
    alive: vi.fn<ChildSystem['alive']>((group) => groups.has(group)),
    signal: vi.fn<ChildSystem['signal']>((group) => {
      live.delete(group);
      groups.delete(group);
    }),
    wait: vi.fn<ChildSystem['wait']>(() => Promise.resolve()),
    now: () => 2000,
  };
  children = new Children(profile, system);
  await children.recover();
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await rm(profile, { recursive: true, force: true });
});
const remembered = async () => JSON.parse(await readFile(file, 'utf8')) as unknown;

async function stale(pid = 42, started = 1000) {
  await writeFile(file, JSON.stringify({ version: 1, children: [{ pid, started }] }));
}

describe('the core’s CLI children', () => {
  it('records a spawned child before returning it, and removes it on exit', async () => {
    const child = new Child(42);
    children.node(child);
    expect(await remembered()).toEqual({ version: 1, children: [{ pid: 42, started: 1000 }] });
    child.emit('exit', 0);
    expect(await remembered()).toEqual({ version: 1, children: [] });
  });

  it('records a pty too, and removes it when its exit callback runs', async () => {
    let exit: (() => void) | undefined;
    children.pty({
      pid: 42,
      kill: vi.fn(),
      onExit: (listener) => {
        exit = listener;
      },
    });
    expect(await remembered()).toEqual({ version: 1, children: [{ pid: 42, started: 1000 }] });
    exit?.();
    expect(await remembered()).toEqual({ version: 1, children: [] });
  });

  it('keeps the record across a crash between spawn and exit, and ends the stale group at start', async () => {
    children.node(new Child(42));
    const restarted = new Children(profile, system);
    await restarted.recover();
    expect(system.signal).toHaveBeenCalledExactlyOnceWith(42, 'SIGTERM');
    expect(await remembered()).toEqual({ version: 1, children: [] });
  });

  it.each(['gone', 'reused', 'another group'] as const)(
    'never signals a stale entry whose process is %s',
    async (why) => {
      await stale();
      if (why === 'gone') live.delete(42);
      if (why === 'reused') live.set(42, { started: 3000, group: 42 });
      if (why === 'another group') live.set(42, { started: 1000, group: 7 });
      await children.recover();
      expect(system.signal).not.toHaveBeenCalled();
      expect(await remembered()).toEqual({ version: 1, children: [] });
    },
  );

  it('gives a surviving owned group three seconds after SIGTERM before SIGKILL', async () => {
    await stale();
    vi.useFakeTimers();
    system.wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    system.signal = vi.fn<ChildSystem['signal']>((group, signal) => {
      if (signal === 'SIGKILL') {
        live.delete(group);
        groups.delete(group);
      }
    });
    const recovering = children.recover();
    expect(system.signal).toHaveBeenCalledExactlyOnceWith(42, 'SIGTERM');
    await vi.advanceTimersByTimeAsync(2999);
    expect(system.signal).toHaveBeenCalledExactlyOnceWith(42, 'SIGTERM');
    await vi.advanceTimersByTimeAsync(1);
    expect(system.signal).toHaveBeenNthCalledWith(2, 42, 'SIGKILL');
    await vi.runAllTimersAsync();
    await recovering;
    expect(await remembered()).toEqual({ version: 1, children: [] });
  });

  it('ends descendants left in the group after SIGTERM ended its leader', async () => {
    await stale();
    system.signal = vi.fn<ChildSystem['signal']>((group, signal) => {
      live.delete(group);
      if (signal === 'SIGKILL') groups.delete(group);
    });
    await children.recover();
    expect(system.signal).toHaveBeenNthCalledWith(2, 42, 'SIGKILL');
  });

  it('does not escalate against a reused pid after the grace', async () => {
    await stale();
    system.signal = vi.fn<ChildSystem['signal']>(() => {
      live.set(42, { started: 3000, group: 42 });
    });
    await children.recover();
    expect(system.signal).toHaveBeenCalledExactlyOnceWith(42, 'SIGTERM');
  });

  it.each(['inspection', 'SIGTERM', 'group check', 'SIGKILL', 'survived'] as const)(
    'warns, retains the record and allows startup after failed cleanup: %s',
    async (failure) => {
      await stale();
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const denied = () => {
        throw new Error('EPERM');
      };
      system.signal = vi.fn();
      if (failure === 'inspection') system.inspect = denied;
      if (failure === 'SIGTERM') system.signal = denied;
      if (failure === 'group check') system.alive = denied;
      if (failure === 'SIGKILL') {
        system.signal = vi.fn<ChildSystem['signal']>((_group, signal) => {
          if (signal === 'SIGKILL') denied();
        });
      }
      await expect(children.recover()).resolves.toBeUndefined();
      expect(warning).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining('42'),
        expect.objectContaining({
          message: failure === 'survived' ? 'Process group 42 did not stop.' : 'EPERM',
        }),
      );
      expect(await remembered()).toEqual({ version: 1, children: [{ pid: 42, started: 1000 }] });
    },
  );

  it('retains a failed cleanup across new children’s exits, and retries it on the next start', async () => {
    await stale();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    system.signal = vi.fn<ChildSystem['signal']>(() => {
      throw new Error('EPERM');
    });
    await children.recover();
    live.set(43, { started: 2000, group: 43 });
    const child = new Child(43);
    children.node(child);
    expect(await remembered()).toEqual({
      version: 1,
      children: [
        { pid: 42, started: 1000 },
        { pid: 43, started: 2000 },
      ],
    });
    child.emit('exit', 0);
    expect(await remembered()).toEqual({ version: 1, children: [{ pid: 42, started: 1000 }] });
    system.signal = vi.fn<ChildSystem['signal']>((group) => {
      live.delete(group);
      groups.delete(group);
    });
    await new Children(profile, system).recover();
    expect(system.signal).toHaveBeenCalledExactlyOnceWith(42, 'SIGTERM');
    expect(await remembered()).toEqual({ version: 1, children: [] });
  });

  it('continues cleaning other stale children after one cannot be signalled', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    live.set(43, { started: 2000, group: 43 });
    groups.add(43);
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        children: [
          { pid: 42, started: 1000 },
          { pid: 43, started: 2000 },
        ],
      }),
    );
    system.signal = vi.fn<ChildSystem['signal']>((group) => {
      if (group === 42) throw new Error('EPERM');
      live.delete(group);
      groups.delete(group);
    });
    await children.recover();
    expect(system.signal).toHaveBeenCalledWith(43, 'SIGTERM');
    expect(await remembered()).toEqual({ version: 1, children: [{ pid: 42, started: 1000 }] });
  });

  it('allows startup when the cleaned registry cannot be written', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await stale();
    system.wait = async () => {
      await rm(file);
      await mkdir(file);
    };
    await expect(children.recover()).resolves.toBeUndefined();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining(file), expect.any(Error));
  });

  it('refuses to register a process outside its own group', async () => {
    live.set(42, { started: 1000, group: 7 });
    const child = new Child(42);
    expect(() => {
      children.node(child);
    }).toThrow(/process group/);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(await remembered()).toEqual({ version: 1, children: [] });
  });

  it('stops a new child if its record cannot reach disk', async () => {
    await rm(file);
    await mkdir(file);
    const child = new Child(42);
    expect(() => {
      children.node(child);
    }).toThrow();
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
  });

  it('keeps an unreadable process file, warns and allows startup', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await writeFile(file, '{broken');
    await expect(children.recover()).resolves.toBeUndefined();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining(file), expect.any(Error));
    expect(await readFile(file, 'utf8')).toBe('{broken');
  });

  it('warns and allows startup when the process file cannot be read', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await rm(file);
    await mkdir(file);
    await expect(children.recover()).resolves.toBeUndefined();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining(file), expect.any(Error));
  });

  it('does not signal groups on Windows, but still records and removes children', async () => {
    system.platform = 'win32';
    children.node(new Child(42));
    expect(await remembered()).toEqual({ version: 1, children: [{ pid: 42, started: 2000 }] });
    await new Children(profile, system).recover();
    expect(system.signal).not.toHaveBeenCalled();
    expect(await remembered()).toEqual({ version: 1, children: [] });
  });
});
