import { execFileSync } from 'node:child_process';

import { afterEach, expect, it, vi } from 'vitest';

import { stopTestGroup, TEST_GROUP_SYSTEM } from './test-process-groups';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(execFileSync).mockReset();
});

it.each(['', ' 84 S\n', ' 42 Z+\n 84 S\n'])(
  'confirms an exited group after kill(0) reports EPERM (ps: %j)',
  (table) => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
    });
    vi.mocked(execFileSync).mockReturnValue(table);
    expect(TEST_GROUP_SYSTEM.alive(42)).toBe(false);
    expect(execFileSync).toHaveBeenCalledWith(
      'ps',
      ['-A', '-o', 'pgid=', '-o', 'stat='],
      expect.objectContaining({ encoding: 'utf8', timeout: 1000 }),
    );
  },
);

it('still sees a group with living descendants when its leader is gone and kill(0) reports EPERM', () => {
  vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
  });
  vi.mocked(execFileSync).mockReturnValue(' 42 Z\n 42 S+\n 84 S\n');
  expect(TEST_GROUP_SYSTEM.alive(42)).toBe(true);
});

it.each(['EIO', 'ETIMEDOUT'])(
  'does not mistake a failed ps read (%s) for an empty group',
  (code) => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
    });
    vi.mocked(execFileSync).mockImplementation(() => {
      throw Object.assign(new Error(`spawnSync ps ${code}`), { code });
    });
    expect(() => TEST_GROUP_SYSTEM.alive(42)).toThrow(`spawnSync ps ${code}`);
  },
);

it('does not mistake malformed ps output for an empty group', () => {
  vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
  });
  vi.mocked(execFileSync).mockReturnValue('not a process table');
  expect(() => TEST_GROUP_SYSTEM.alive(42)).toThrow(/process groups/);
});

it('uses a missing kill(0) group without a membership read', () => {
  vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
  });
  expect(TEST_GROUP_SYSTEM.alive(42)).toBe(false);
  expect(execFileSync).not.toHaveBeenCalled();
});

it('still sees living descendants after a successful kill(0) when the leader is gone', async () => {
  vi.spyOn(process, 'kill').mockReturnValue(true);
  vi.mocked(execFileSync).mockReturnValue(' 42 Z\n 42 S+\n 84 S\n');
  expect(TEST_GROUP_SYSTEM.alive(42)).toBe(true);
  let now = 0;
  const signal = vi.fn();
  await expect(
    stopTestGroup(
      { pid: 42, started: 1000 },
      {
        ...TEST_GROUP_SYSTEM,
        inspect: () => undefined,
        signal,
        now: () => now,
        wait: (ms) => {
          now += ms;
          return Promise.resolve();
        },
      },
    ),
  ).rejects.toThrow(/no matching process identity.*folder was kept/);
  expect(signal).not.toHaveBeenCalled();
  expect(now).toBe(5000);
});

it.each(['EIO', 'ETIMEDOUT', 'malformed'])(
  'keeps a successful kill(0) probe inconclusive after a membership read is %s',
  (code) => {
    vi.spyOn(process, 'kill').mockReturnValue(true);
    vi.mocked(execFileSync).mockImplementation(() => {
      if (code === 'malformed') return 'not a process table';
      throw Object.assign(new Error(`spawnSync ps ${code}`), { code });
    });
    expect(() => TEST_GROUP_SYSTEM.alive(42)).toThrow(
      code === 'malformed' ? /process groups/ : code,
    );
  },
);

it.each(['', ' 42 Z+\n', ' 42 Z\n 84 S\n'])(
  'cleans an already exited group after a successful kill(0) probe (ps: %j)',
  async (table) => {
    vi.spyOn(process, 'kill').mockReturnValue(true);
    vi.mocked(execFileSync).mockReturnValue(table);
    let now = 0;
    const inspect = vi.fn(() => undefined);
    const signal = vi.fn();
    await expect(
      stopTestGroup(
        { pid: 42, started: 1000 },
        {
          ...TEST_GROUP_SYSTEM,
          inspect,
          signal,
          now: () => now,
          wait: (ms) => {
            now += ms;
            return Promise.resolve();
          },
        },
      ),
    ).resolves.toBeUndefined();
    expect(inspect).not.toHaveBeenCalled();
    expect(signal).not.toHaveBeenCalled();
    expect(now).toBe(0);
  },
);
