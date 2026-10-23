import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { ChildSystem } from '../core/children';
import { cleanupCrash } from './test-crash-cleanup';

let directory: string;
let profile: string;
let registry: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'corrallm-crash-cleanup-'));
  profile = path.join(directory, 'profile');
  await mkdir(path.join(profile, 'sessions'), { recursive: true });
  registry = path.join(profile, 'sessions', 'pids.json');
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function fixture() {
  const groups = new Set<number>();
  const system: ChildSystem = {
    platform: 'darwin',
    inspect: (pid) => (groups.has(pid) ? { started: 1000, group: pid } : undefined),
    alive: (pid) => groups.has(pid),
    signal: vi.fn((pid: number) => {
      groups.delete(pid);
    }),
    wait: () => Promise.resolve(),
    now: Date.now,
  };
  const record = async (pids: number[]) => {
    for (const pid of pids) groups.add(pid);
    await writeFile(
      registry,
      JSON.stringify({ version: 1, children: pids.map((pid) => ({ pid, started: 1000 })) }),
    );
  };
  return { groups, system, record };
}

it('waits for serve and a recorded CLI’s late writes before removing the folder', async () => {
  const { groups, system, record } = fixture();
  const parent = Promise.withResolvers<undefined>();
  const cli = Promise.withResolvers<undefined>();
  const children = { close: vi.fn(() => parent.promise) };
  system.signal = vi.fn();
  system.wait = () => cli.promise;
  const cleanup = cleanupCrash(directory, profile, children, system);
  expect(children.close).toHaveBeenCalledOnce();
  // The last CLI can be recorded while startup/shutdown still belongs to serve.
  await record([42]);
  expect(system.signal).not.toHaveBeenCalled();
  parent.resolve(undefined);
  await vi.waitFor(() => {
    expect(system.signal).toHaveBeenCalledWith(42, 'SIGTERM');
  });
  expect(existsSync(directory)).toBe(true);
  await writeFile(path.join(directory, 'codex.log'), 'initialize\n');
  groups.clear();
  cli.resolve(undefined);
  await cleanup;
  expect(existsSync(directory)).toBe(false);
});

it('stops every recorded group and escalates one that ignores SIGTERM', async () => {
  const { groups, system, record } = fixture();
  await record([42, 84]);
  system.signal = vi.fn((pid: number, signal: NodeJS.Signals | number) => {
    if (pid === 42 || signal === 'SIGKILL') groups.delete(pid);
  });
  await cleanupCrash(directory, profile, { close: () => Promise.resolve() }, system);
  expect(vi.mocked(system.signal).mock.calls).toEqual([
    [42, 'SIGTERM'],
    [84, 'SIGTERM'],
    [84, 'SIGKILL'],
  ]);
  expect(existsSync(directory)).toBe(false);
});

it('keeps the folder and record when a CLI group cannot be stopped', async () => {
  const { system, record } = fixture();
  await record([42]);
  system.signal = vi.fn();
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    await expect(
      cleanupCrash(directory, profile, { close: () => Promise.resolve() }, system),
    ).rejects.toThrow(/kept/);
    expect(existsSync(directory)).toBe(true);
    expect(JSON.parse(await readFile(registry, 'utf8'))).toMatchObject({ children: [{ pid: 42 }] });
  } finally {
    warning.mockRestore();
  }
});

it('removes a profile whose owner never got far enough to record a CLI', async () => {
  await cleanupCrash(directory, profile, { close: () => Promise.resolve() });
  expect(existsSync(directory)).toBe(false);
});

it('keeps the folder if serve itself cannot be confirmed stopped', async () => {
  const { system, record } = fixture();
  await record([42]);
  await expect(
    cleanupCrash(
      directory,
      profile,
      { close: () => Promise.reject(new Error('serve still runs')) },
      system,
    ),
  ).rejects.toThrow('serve still runs');
  expect(system.signal).not.toHaveBeenCalled();
  expect(existsSync(directory)).toBe(true);
});

it.each(['missing', 'reused'] as const)(
  'keeps the folder if a %s leader leaves a live group that cannot be safely signalled',
  async (kind) => {
    const { system, record } = fixture();
    await record([42]);
    system.inspect = () => (kind === 'missing' ? undefined : { started: 2000, group: 42 });
    await expect(
      cleanupCrash(directory, profile, { close: () => Promise.resolve() }, system),
    ).rejects.toThrow(/folder was kept/);
    expect(system.signal).not.toHaveBeenCalled();
    expect(existsSync(directory)).toBe(true);
  },
);
