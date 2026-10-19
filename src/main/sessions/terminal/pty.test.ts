import { afterEach, describe, expect, it, vi } from 'vitest';

import { withProcesses } from '../process';
import { spawnPty } from './pty';

const { nativeSpawn } = vi.hoisted(() => ({ nativeSpawn: vi.fn() }));
vi.mock('node-pty', () => ({ spawn: nativeSpawn }));
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('owned ptys', () => {
  it.each(['darwin', 'win32'] as const)(
    'records the native pty on %s, keeping the ConPTY DLL on Windows',
    async (platform) => {
      vi.stubGlobal('process', { ...process, platform });
      const child = { pid: 42, kill: vi.fn(), onExit: vi.fn() };
      nativeSpawn.mockReturnValue(child);
      const owner = { node: vi.fn(), pty: vi.fn() };
      await withProcesses(owner, () =>
        spawnPty('fake-cli', [], { cwd: '/project', env: {}, cols: 80, rows: 24 }),
      );
      expect(owner.pty).toHaveBeenCalledExactlyOnceWith(child);
      if (platform === 'win32')
        expect(nativeSpawn.mock.calls.at(-1)?.[2]).toMatchObject({ useConptyDll: true });
    },
  );
});
