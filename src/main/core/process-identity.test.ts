import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type * as NodeFs from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';

import { readApiFile, writeApiFile } from '../cli/api-file';
import { Children } from './children';
import { lockProfile, processStart, ProfileLocked, stillRuns } from './lock';
import { inspectProcess, isProcessStart } from './process-identity';

const os = vi.hoisted(() => ({
  epoch: Date.UTC(2026, 9, 23),
  shift: 0,
  boot: '12345678-1234-1234-1234-123456789abc',
  ticks: '9876543210123456789',
  group: 42,
  live: true,
  readError: '',
  denyQuarantine: false,
}));

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn((_file: string, args: string[]) => {
    if (!os.live) throw Object.assign(new Error('gone'), { status: 1, stdout: '', stderr: '' });
    const start = new Date(os.epoch + os.shift).toUTCString();
    return args.includes('pgid=') ? `${start} ${String(os.group)}` : start;
  }),
}));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof NodeFs>();
  return {
    ...fs,
    renameSync: (...args: Parameters<typeof fs.renameSync>) => {
      if (os.denyQuarantine && String(args[0]).endsWith('/pids.json')) {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      }
      fs.renameSync(...args);
    },
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
      const file = String(args[0]);
      if (file.startsWith('/proc/') && os.readError) {
        throw Object.assign(new Error('denied'), { code: os.readError });
      }
      if (file === '/proc/sys/kernel/random/boot_id') return `${os.boot}\n`;
      if (/^\/proc\/\d+\/stat$/.test(file)) {
        if (!os.live) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
        const pid = file.split('/')[2] ?? '';
        // comm may contain spaces, newlines and parentheses; starttime is field 22.
        return `${pid} (a tricky) (name\n) S 1 ${String(os.group)} ${Array<string>(16).fill('0').join(' ')} ${os.ticks} 0\n`;
      }
      return fs.readFileSync(...args);
    },
  };
});

let profile: string;
let kill: MockInstance<typeof process.kill>;
beforeEach(async () => {
  os.shift = 0;
  os.boot = '12345678-1234-1234-1234-123456789abc';
  os.ticks = '9876543210123456789';
  os.group = 42;
  os.live = true;
  os.readError = '';
  os.denyQuarantine = false;
  vi.stubGlobal('process', { ...process, platform: 'linux' });
  vi.spyOn(Date, 'now').mockImplementation(() => os.epoch + os.shift);
  vi.spyOn(process, 'uptime').mockReturnValue(0);
  kill = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
    if (!os.live) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    if (signal === 'SIGTERM' || signal === 'SIGKILL') os.live = false;
    return true;
  });
  vi.mocked(execFileSync).mockClear();
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-process-identity-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await rm(profile, { recursive: true, force: true });
});

describe('Linux process identities', () => {
  it('keeps a live profile lock after a five-second wall-clock step', async () => {
    const started = processStart();
    const lock = await lockProfile(profile, 'app');
    try {
      os.shift = 5000;
      expect(stillRuns({ pid: process.pid, started })).toBe(true);
      await expect(lockProfile(profile, 'serve')).rejects.toBeInstanceOf(ProfileLocked);
    } finally {
      lock.release();
    }
  });

  it('still recognizes its CLI group after a five-second wall-clock step', async () => {
    const children = new Children(profile);
    await children.recover();
    const child = Object.assign(new EventEmitter(), { pid: 42, kill: vi.fn() });
    children.node(child);
    os.shift = 5000;
    await new Children(profile).recover();
    expect(kill).toHaveBeenCalledWith(-42, 'SIGTERM');
    expect(os.live).toBe(false);
    expect(JSON.parse(await readFile(path.join(profile, 'sessions/pids.json'), 'utf8'))).toEqual({
      version: 1,
      children: [],
    });
  });

  it('uses exact boot-relative ticks and never invokes ps on Linux', () => {
    expect(processStart()).toEqual({ bootId: os.boot, ticks: os.ticks });
    expect(inspectProcess(42)).toEqual({
      started: { bootId: os.boot, ticks: os.ticks },
      group: 42,
    });
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('discovers only the server whose exact Linux identity api.json holds', async () => {
    const api = { url: 'http://127.0.0.1:1234/mcp', port: 1234, pid: 42, started: processStart() };
    await writeApiFile(profile, api);
    expect(await readApiFile(profile)).toEqual(api);
    os.ticks = '9876543210123456790';
    expect(await readApiFile(profile)).toBeUndefined();
    // A wall-clock-only address cannot identify a Linux server without guessing.
    await writeApiFile(profile, { ...api, started: os.epoch });
    expect(await readApiFile(profile)).toBeUndefined();
  });

  it.each(['reused pid', 'another boot', 'another group'])(
    'never signals a recorded CLI from %s',
    async (why) => {
      const children = new Children(profile);
      await children.recover();
      children.node(Object.assign(new EventEmitter(), { pid: 42, kill: vi.fn() }));
      const started = processStart();
      if (why === 'reused pid') os.ticks = '9876543210123456790';
      if (why === 'another boot') os.boot = '87654321-1234-1234-1234-123456789abc';
      if (why === 'another group') os.group = 7;
      if (why !== 'another group') expect(stillRuns({ pid: 42, started })).toBe(false);
      await new Children(profile).recover();
      expect(kill).not.toHaveBeenCalledWith(-42, 'SIGTERM');
      expect(os.live).toBe(true);
    },
  );

  it('takes over a reused pid’s lock and an old release cannot remove the new lock', async () => {
    const old = await lockProfile(profile, 'app');
    os.ticks = '9876543210123456790';
    const current = await lockProfile(profile, 'app');
    old.release();
    expect(JSON.parse(await readFile(path.join(profile, 'core.lock'), 'utf8'))).toMatchObject({
      started: { ticks: os.ticks },
    });
    current.release();
    await expect(readFile(path.join(profile, 'core.lock'))).rejects.toThrow(/ENOENT/);
  });

  it('does not take a live lock or signal a stale CLI when proc cannot be inspected', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const lock = await lockProfile(profile, 'app');
    const children = new Children(profile);
    await children.recover();
    children.node(Object.assign(new EventEmitter(), { pid: 42, kill: vi.fn() }));
    os.readError = 'EACCES';
    try {
      await expect(lockProfile(profile, 'serve')).rejects.toThrow(/denied/);
      expect(stillRuns({ pid: 42, started: { bootId: os.boot, ticks: os.ticks } })).toBe(true);
      await new Children(profile).recover();
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('42'), expect.any(Error));
      expect(kill).not.toHaveBeenCalledWith(-42, 'SIGTERM');
      expect(execFileSync).not.toHaveBeenCalled();
    } finally {
      lock.release();
    }
  });

  it('never uses a wall-clock-only record to take a live Linux lock', async () => {
    await writeFile(
      path.join(profile, 'core.lock'),
      JSON.stringify({ owner: 'app', pid: 42, started: os.epoch - 60_000 }),
    );
    await expect(lockProfile(profile, 'serve')).rejects.toBeInstanceOf(ProfileLocked);
  });

  it('uses ps start time and group on macOS', () => {
    vi.stubGlobal('process', { ...process, platform: 'darwin' });
    expect(inspectProcess(42)).toEqual({ started: os.epoch, group: 42 });
    expect(stillRuns({ pid: 42, started: os.epoch })).toBe(true);
    expect(execFileSync).toHaveBeenCalledWith(
      'ps',
      expect.arrayContaining(['lstart=', 'pgid=']),
      expect.any(Object),
    );
  });

  it.each([
    null,
    {},
    { bootId: 'bad', ticks: '10' },
    { bootId: os.boot, ticks: '-1' },
    { bootId: os.boot, ticks: '1.5' },
  ])('rejects a malformed recorded start identity: %j', (value) => {
    expect(isProcessStart(value)).toBe(false);
  });
});

describe('an unread CLI registry', () => {
  it('refuses a new CLI when the unread registry cannot be preserved', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const children = new Children(profile);
    await children.recover();
    const file = path.join(profile, 'sessions/pids.json');
    const unread = '{"version":2,"children":[{"pid":99,"started":500}]}';
    await writeFile(file, unread);
    os.denyQuarantine = true;
    await children.recover();
    expect(() => {
      children.beforeSpawn();
    }).toThrow(/could not be preserved/);
    const child = Object.assign(new EventEmitter(), { pid: 42, kill: vi.fn() });
    expect(() => {
      children.node(child);
    }).toThrow(/could not be preserved/);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
    await children.close();
    expect(await readFile(file, 'utf8')).toBe(unread);
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('refusing new CLIs'),
      expect.any(Error),
    );
  });
});
