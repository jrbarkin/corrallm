import { describe, expect, it, vi } from 'vitest';

import type { AppApi } from '../shared/ipc';

const { exposeInMainWorld, invoke } = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn<(key: string, api: unknown) => void>(),
  invoke: vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>(),
}));
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld },
  ipcRenderer: { invoke },
}));

describe('preload', () => {
  it('exposes window.api, whose ping() invokes app:ping', async () => {
    // Import inside the test: Vitest clears mock calls recorded at module load between tests.
    await import('./index');

    expect(exposeInMainWorld).toHaveBeenCalledOnce();
    const [key, api] = exposeInMainWorld.mock.calls[0] ?? [];
    expect(key).toBe('api');

    invoke.mockResolvedValue('corrallm 0.1.0');
    await expect((api as AppApi).ping()).resolves.toBe('corrallm 0.1.0');
    expect(invoke).toHaveBeenCalledWith('app:ping');
  });
});
