import { execFileSync } from 'node:child_process';

import { afterEach, expect, it, vi } from 'vitest';

import { TEST_GROUP_SYSTEM } from './test-process-groups';

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

it.each([true, false])('uses a conclusive kill(0) probe without ps (alive: %s)', (alive) => {
  vi.spyOn(process, 'kill').mockImplementation(() => {
    if (!alive) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    return true;
  });
  expect(TEST_GROUP_SYSTEM.alive(42)).toBe(alive);
  expect(execFileSync).not.toHaveBeenCalled();
});
