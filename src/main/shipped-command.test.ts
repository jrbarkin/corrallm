import path from 'node:path';

import { expect, it, vi } from 'vitest';

import { checkShippedCommand } from './shipped-command';

it('checks the packaged launcher with no Node on PATH and propagates failures', async () => {
  const execute = vi.fn(() => Promise.resolve({ stdout: 'node-pty ok\nall passed\n', stderr: '' }));
  await expect(checkShippedCommand('/Resources', execute)).resolves.toContain('node-pty ok');
  expect(execute).toHaveBeenCalledWith(
    path.join('/Resources', 'bin/corrallm'),
    expect.objectContaining({
      env: expect.objectContaining({
        PATH: '',
        CORRALLM_NATIVE_SELFTEST: '1',
        NODE_OPTIONS: '',
      }) as unknown,
      timeout: 60_000,
    }),
  );
  execute.mockRejectedValueOnce(new Error('shipped pty failed'));
  await expect(checkShippedCommand('/Resources', execute)).rejects.toThrow('shipped pty failed');
});
