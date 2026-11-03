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

/**
 * A recorded group (leader 42, started 1000) whose leader has exited (no process has its pid) while
 * descendants in its group live on, as `ps` reads them, until the signal `until` reaches the group
 * (none: they never stop).
 */
function leaderless(until?: NodeJS.Signals) {
  let now = 0;
  let left = true;
  vi.spyOn(process, 'kill').mockReturnValue(true);
  vi.mocked(execFileSync).mockImplementation(() => (left ? ' 42 Z\n 42 S+\n 84 S\n' : ' 84 S\n'));
  const signal = vi.fn((_pid: number, sent: NodeJS.Signals | number) => {
    if (sent === until) left = false;
  });
  const system = {
    ...TEST_GROUP_SYSTEM,
    inspect: () => undefined,
    signal,
    now: () => now,
    wait: (ms: number) => {
      now += ms;
      return Promise.resolve();
    },
  };
  return { system, signal, now: () => now };
}

it.each(['SIGTERM', 'SIGKILL'] as const)(
  'stops the living descendants of a group whose leader exited, with %s',
  async (until) => {
    // G3's crash test: a fake codex's sleeping command outlived the codex that started it, in its
    // group. No process can take a pid that still names a living group: they are ours to stop.
    const { system, signal, now } = leaderless(until);
    expect(TEST_GROUP_SYSTEM.alive(42)).toBe(true);
    await expect(stopTestGroup({ pid: 42, started: 1000 }, system)).resolves.toBeUndefined();
    expect(signal.mock.calls).toEqual(
      until === 'SIGTERM'
        ? [[42, 'SIGTERM']]
        : [
            [42, 'SIGTERM'],
            [42, 'SIGKILL'],
          ],
    );
    expect(now()).toBe(until === 'SIGTERM' ? 0 : 5000);
  },
);

it('still fails when the descendants of a group whose leader exited survive SIGKILL', async () => {
  const { system, signal, now } = leaderless();
  await expect(stopTestGroup({ pid: 42, started: 1000 }, system)).rejects.toThrow(
    /Test group 42 did not stop.*folder was kept/,
  );
  expect(signal.mock.calls).toEqual([
    [42, 'SIGTERM'],
    [42, 'SIGKILL'],
  ]);
  expect(now()).toBe(10_000);
});

it('cleans a group whose last process exits between its liveness probe and its identity read', async () => {
  const { system, signal, now } = leaderless();
  const inspect = vi.fn(() => {
    // The leader, the group's last process, exited while ps was scheduled; zombies remain.
    vi.mocked(execFileSync).mockReturnValue(' 42 Z\n 84 S\n');
    return undefined;
  });
  system.inspect = inspect;
  await expect(stopTestGroup({ pid: 42, started: 1000 }, system)).resolves.toBeUndefined();
  expect(inspect).toHaveBeenCalledOnce();
  expect(signal).not.toHaveBeenCalled();
  expect(now()).toBe(0);
});

it('never signals a group whose leader pid now names another process', async () => {
  const { system, signal, now } = leaderless();
  system.inspect = () => ({ group: 42, started: 2000 }) as never;
  await expect(stopTestGroup({ pid: 42, started: 1000 }, system)).rejects.toThrow(
    /Test group 42 has no matching process identity; its folder was kept/,
  );
  expect(signal).not.toHaveBeenCalled();
  expect(now()).toBe(5000);
});

it('never signals a leaderless group whose membership read is inconclusive', async () => {
  const { system, signal, now } = leaderless();
  vi.mocked(execFileSync).mockImplementation(() => {
    throw Object.assign(new Error('spawnSync ps ETIMEDOUT'), { code: 'ETIMEDOUT' });
  });
  await expect(stopTestGroup({ pid: 42, started: 1000 }, system)).rejects.toThrow(
    /Test group 42 has no matching process identity; group probe failed \(spawnSync ps ETIMEDOUT\)/,
  );
  expect(signal).not.toHaveBeenCalled();
  expect(now()).toBe(5000);
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
