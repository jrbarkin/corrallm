import { afterEach, describe, expect, it, vi } from 'vitest';

import { withProcesses } from '../process';
import { spawnPty } from './pty';

const { nativeSpawn } = vi.hoisted(() => ({ nativeSpawn: vi.fn() }));
vi.mock('node-pty', () => ({ spawn: nativeSpawn }));
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('owned ptys', () => {
  it('refuses a pty before the native spawn once closing, including during module loading', async () => {
    let closing = false;
    const owner = {
      node: vi.fn(),
      pty: vi.fn(),
      stop: vi.fn(),
      beforeSpawn: () => {
        if (closing) throw new Error('closing');
      },
    };
    const starting = withProcesses(owner, () =>
      spawnPty('fake-cli', [], { cwd: '/project', env: {}, cols: 80, rows: 24 }),
    );
    closing = true;
    await expect(starting).rejects.toThrow('closing');
    expect(nativeSpawn).not.toHaveBeenCalled();
    expect(owner.pty).not.toHaveBeenCalled();
  });

  it.each(['darwin', 'win32'] as const)(
    'records the native pty on %s, keeping the ConPTY DLL on Windows',
    async (platform) => {
      vi.stubGlobal('process', { ...process, platform });
      const child = { pid: 42, kill: vi.fn(), onExit: vi.fn() };
      nativeSpawn.mockReturnValue(child);
      const owner = { beforeSpawn: vi.fn(), node: vi.fn(), pty: vi.fn(), stop: vi.fn() };
      await withProcesses(owner, () =>
        spawnPty('fake-cli', [], { cwd: '/project', env: {}, cols: 80, rows: 24 }),
      );
      expect(owner.pty).toHaveBeenCalledExactlyOnceWith(child);
      if (platform === 'win32')
        expect(nativeSpawn.mock.calls.at(-1)?.[2]).toMatchObject({ useConptyDll: true });
    },
  );
});
