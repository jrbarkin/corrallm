import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { ChildSystem } from '../core/children';
import { recordTestProcess, watchTestLifetime } from './test-lifetime';

let directory: string;
beforeEach(async () => {
  const cache = path.resolve('node_modules/.cache/probes');
  await mkdir(cache, { recursive: true });
  directory = await mkdtemp(path.join(cache, 'test-lifetime-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function fixture() {
  const groups = new Set([42, 84]);
  let now = 0;
  const system: ChildSystem = {
    platform: 'darwin',
    inspect: (pid) => (groups.has(pid) ? { group: pid, started: 1000 } : undefined),
    alive: (pid) => groups.has(pid),
    signal: vi.fn((pid: number) => {
      groups.delete(pid);
    }),
    wait: (ms) => {
      now += ms;
      return Promise.resolve();
    },
    now: () => now,
  };
  return { system, groups };
}

it.each(['end', 'close'] as const)(
  'ends owned servers, their groups and recorded native CLIs when the worker pipe emits %s',
  async (event) => {
    const { system, groups } = fixture();
    const profile = path.join(directory, 'profile');
    await mkdir(path.join(profile, 'sessions'), { recursive: true });
    await writeFile(
      path.join(profile, 'sessions/pids.json'),
      JSON.stringify({
        version: 1,
        children: [{ pid: 84, started: 1000 }],
      }),
    );
    recordTestProcess(directory, 42, profile, system.inspect);
    const owner = new PassThrough();
    const watching = watchTestLifetime(directory, owner, system);
    expect(system.signal).not.toHaveBeenCalled();
    if (event === 'end') owner.end();
    else owner.destroy();
    await watching;
    expect(existsSync(path.join(directory, 'closed'))).toBe(true);
    expect(system.signal).toHaveBeenCalledWith(42, 'SIGTERM');
    expect(system.signal).toHaveBeenCalledWith(84, 'SIGTERM');
    expect(groups.size).toBe(0);
    expect(() => {
      recordTestProcess(directory, 42, profile, system.inspect);
    }).toThrow(/ended/);
  },
);

it('records a terminal server before readiness or any pid header is delivered', () => {
  const { system } = fixture();
  recordTestProcess(directory, 42, undefined, system.inspect);
  expect(JSON.parse(readFileSync(path.join(directory, '42.json'), 'utf8'))).toEqual({
    pid: 42,
    started: 1000,
  });
});

it('refuses a late CLI startup after its owner ended', () => {
  const { system } = fixture();
  writeFileSync(path.join(directory, 'closed'), '');
  expect(() => {
    recordTestProcess(directory, 42, undefined, system.inspect);
  }).toThrow(/ended/);
  expect(existsSync(path.join(directory, '42.json'))).toBe(false);
});

it('does not signal a reused pid and retains its diagnostic records', async () => {
  const { system } = fixture();
  recordTestProcess(directory, 42, undefined, system.inspect);
  system.inspect = () => ({ group: 42, started: 2000 });
  const owner = new PassThrough();
  const failed = expect(watchTestLifetime(directory, owner, system)).rejects.toThrow(/identity/);
  owner.end();
  await failed;
  expect(system.signal).not.toHaveBeenCalled();
  expect(existsSync(path.join(directory, '42.json'))).toBe(true);
});

it('cleans records of exited servers without inspecting their identities', async () => {
  const { system, groups } = fixture();
  for (const pid of [42, 84]) recordTestProcess(directory, pid, undefined, system.inspect);
  groups.clear();
  system.inspect = vi.fn(() => {
    throw new Error('spawnSync ps ETIMEDOUT');
  });
  const owner = new PassThrough();
  const watching = watchTestLifetime(directory, owner, system);
  owner.end();
  await watching;
  expect(system.inspect).not.toHaveBeenCalled();
  expect(system.signal).not.toHaveBeenCalled();
});

it.each(['EPERM', 'ETIMEDOUT'])(
  'confirms a recorded group is gone after an inconclusive group probe (%s)',
  async (code) => {
    const { system } = fixture();
    recordTestProcess(directory, 42, undefined, system.inspect);
    system.alive = vi
      .fn()
      .mockImplementationOnce(() => {
        throw Object.assign(new Error(`group probe ${code}`), { code });
      })
      .mockReturnValue(false);
    system.inspect = () => {
      throw new Error('spawnSync ps ETIMEDOUT');
    };
    const owner = new PassThrough();
    const watching = watchTestLifetime(directory, owner, system);
    owner.end();
    await expect(watching).resolves.toBeUndefined();
    expect(system.signal).not.toHaveBeenCalled();
  },
);

it.each(['SIGTERM', 'SIGKILL'] as const)(
  'confirms a group is gone when %s itself reports EPERM',
  async (failedSignal) => {
    const { system, groups } = fixture();
    recordTestProcess(directory, 42, undefined, system.inspect);
    system.signal = vi.fn((_pid, signal) => {
      if (signal === failedSignal) {
        groups.delete(42);
        throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
      }
    });
    const owner = new PassThrough();
    const watching = watchTestLifetime(directory, owner, system);
    owner.end();
    await expect(watching).resolves.toBeUndefined();
  },
);

it.each([
  ['before SIGTERM', 'EIO'],
  ['before SIGTERM', 'ETIMEDOUT'],
  ['before SIGKILL', 'EIO'],
  ['before SIGKILL', 'ETIMEDOUT'],
] as const)('cleans a group that exits during a failed ps read %s (%s)', async (stage, code) => {
  const { system, groups } = fixture();
  recordTestProcess(directory, 42, undefined, system.inspect);
  system.signal = vi.fn();
  system.inspect = () => {
    if (stage === 'before SIGKILL' && system.now() === 0) return { group: 42, started: 1000 };
    // The group was alive immediately before ps ran, but exited while it was scheduled.
    groups.delete(42);
    throw Object.assign(new Error(`spawnSync ps ${code}`), { code });
  };
  const owner = new PassThrough();
  const watching = watchTestLifetime(directory, owner, system);
  owner.end();
  await expect(watching).resolves.toBeUndefined();
  expect(vi.mocked(system.signal).mock.calls).toEqual(
    stage === 'before SIGTERM' ? [] : [[42, 'SIGTERM']],
  );
});

it('waits for an exiting group after ps fails without signalling an unverified identity', async () => {
  const { system, groups } = fixture();
  recordTestProcess(directory, 42, undefined, system.inspect);
  system.inspect = () => {
    throw new Error('spawnSync ps ETIMEDOUT');
  };
  const wait = system.wait;
  system.wait = async (ms) => {
    await wait(ms);
    if (system.now() >= 800) groups.delete(42);
  };
  const owner = new PassThrough();
  const watching = watchTestLifetime(directory, owner, system);
  owner.end();
  await expect(watching).resolves.toBeUndefined();
  expect(system.now()).toBe(800);
  expect(system.signal).not.toHaveBeenCalled();
});

it.each(['before SIGTERM', 'before SIGKILL'] as const)(
  'names a surviving group and the failed ps read %s while retaining its record',
  async (stage) => {
    const { system } = fixture();
    recordTestProcess(directory, 42, undefined, system.inspect);
    system.signal = vi.fn();
    system.inspect = () => {
      if (stage === 'before SIGKILL' && system.now() === 0) return { group: 42, started: 1000 };
      throw new Error('spawnSync ps ETIMEDOUT');
    };
    const owner = new PassThrough();
    const failed = expect(watchTestLifetime(directory, owner, system)).rejects.toThrow(
      /Test group 42.*spawnSync ps ETIMEDOUT.*folder was kept/,
    );
    owner.end();
    await failed;
    expect(system.now()).toBe(stage === 'before SIGTERM' ? 5000 : 10_000);
    expect(vi.mocked(system.signal).mock.calls).toEqual(
      stage === 'before SIGTERM' ? [] : [[42, 'SIGTERM']],
    );
    expect(existsSync(path.join(directory, '42.json'))).toBe(true);
  },
);

it('retains a real survivor after the complete grace and kill wait', async () => {
  const { system } = fixture();
  recordTestProcess(directory, 42, undefined, system.inspect);
  system.signal = vi.fn();
  const owner = new PassThrough();
  const failed = expect(watchTestLifetime(directory, owner, system)).rejects.toThrow(
    /did not stop/,
  );
  owner.end();
  await failed;
  expect(system.now()).toBe(10_000);
  expect(system.signal).toHaveBeenCalledWith(42, 'SIGKILL');
  expect(existsSync(path.join(directory, '42.json'))).toBe(true);
});

it('fails with the pid and signal error when a verified group survives denied signals', async () => {
  const { system } = fixture();
  recordTestProcess(directory, 42, undefined, system.inspect);
  system.signal = vi.fn(() => {
    throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
  });
  const owner = new PassThrough();
  const failed = expect(watchTestLifetime(directory, owner, system)).rejects.toThrow(
    /Test group 42 did not stop; SIGKILL failed \(kill EPERM\).*folder was kept/,
  );
  owner.end();
  await failed;
  expect(system.now()).toBe(10_000);
  expect(system.signal).toHaveBeenCalledWith(42, 'SIGTERM');
  expect(system.signal).toHaveBeenCalledWith(42, 'SIGKILL');
  expect(existsSync(path.join(directory, '42.json'))).toBe(true);
});

it('keeps an unverified group when neither its identity nor its liveness can be read', async () => {
  const { system } = fixture();
  recordTestProcess(directory, 42, undefined, system.inspect);
  system.inspect = () => undefined;
  system.alive = () => {
    throw new Error('spawnSync ps ETIMEDOUT');
  };
  const owner = new PassThrough();
  const failed = expect(watchTestLifetime(directory, owner, system)).rejects.toThrow(
    /Test group 42 has no matching process identity; group probe failed \(spawnSync ps ETIMEDOUT\).*folder was kept/,
  );
  owner.end();
  await failed;
  expect(system.now()).toBe(5000);
  expect(system.signal).not.toHaveBeenCalled();
  expect(existsSync(path.join(directory, '42.json'))).toBe(true);
});

it('refuses application startup if the owner ends during registration', () => {
  const { system } = fixture();
  const inspect: ChildSystem['inspect'] = (pid) => {
    writeFileSync(path.join(directory, 'closed'), '');
    return system.inspect(pid);
  };
  expect(() => {
    recordTestProcess(directory, 42, undefined, inspect);
  }).toThrow(/ended/);
});
