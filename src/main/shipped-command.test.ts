import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, expect, it, vi } from 'vitest';

import { checkShippedCommand } from './shipped-command';

const executeFile = promisify(execFile);
const root = path.resolve(import.meta.dirname, '../..');
let folder: string | undefined;
afterEach(async () => {
  if (folder !== undefined) await rm(folder, { recursive: true, force: true });
  folder = undefined;
});

it('checks the packaged launcher with no Node on PATH and propagates failures', async () => {
  const execute = vi.fn<
    (
      file: string,
      options: {
        env: NodeJS.ProcessEnv;
        timeout: number;
      },
    ) => Promise<{ stdout: string; stderr: string }>
  >(() => Promise.resolve({ stdout: 'node-pty ok\nall passed\n', stderr: '' }));
  await expect(checkShippedCommand('/Resources', execute)).resolves.toContain('node-pty ok');
  // Assert individual fields so a failure never prints the inherited environment.
  expect(execute.mock.calls[0]?.[0]).toBe(path.join('/Resources', 'bin/corrallm'));
  const options = execute.mock.calls[0]?.[1];
  expect(options?.env.PATH).toBe('');
  expect(options?.env.CORRALLM_NATIVE_SELFTEST).toBe('1');
  expect(options?.env.NODE_OPTIONS).toBe('--require=/corrallm-selftest-must-not-preload.cjs');
  expect(options?.timeout).toBe(60_000);
  execute.mockRejectedValueOnce(new Error('shipped pty failed'));
  await expect(checkShippedCommand('/Resources', execute)).rejects.toThrow('shipped pty failed');
});

it.skipIf(process.platform === 'win32')(
  'runs the launcher with hostile Node preloads, keeping them out of its runtime',
  async () => {
    const cache = path.join(root, 'node_modules/.cache/probes');
    await mkdir(cache, { recursive: true });
    folder = await mkdtemp(path.join(cache, 'shipped-command-'));
    const resources = path.join(folder, 'Resources');
    const launcher = path.join(resources, 'bin/corrallm');
    await mkdir(path.dirname(launcher), { recursive: true });
    await copyFile(path.join(root, 'build/corrallm'), launcher);
    await chmod(launcher, 0o755);
    await mkdir(path.join(resources, 'cli'));
    await symlink(process.execPath, path.join(resources, 'cli/node'));
    // The runtime is real Node; its CLI is a tiny stand-in, never a native module or agent CLI.
    await writeFile(
      path.join(resources, 'cli/corrallm.cjs'),
      `console.log(JSON.stringify({
        options: process.env.NODE_OPTIONS,
        search: process.env.NODE_PATH,
        repl: process.env.NODE_REPL_EXTERNAL_MODULE,
        path: process.env.PATH,
        selfTest: process.env.CORRALLM_NATIVE_SELFTEST,
      }));`,
    );
    const result = await checkShippedCommand(resources, (file, options) =>
      executeFile(file, [], {
        ...options,
        env: {
          ...options.env,
          NODE_OPTIONS: `--require=${JSON.stringify(path.join(resources, 'missing.cjs'))}`,
          NODE_PATH: path.join(resources, 'untrusted-modules'),
          NODE_REPL_EXTERNAL_MODULE: path.join(resources, 'untrusted-repl.cjs'),
        },
      }),
    );
    expect(JSON.parse(result)).toEqual({ path: '', selfTest: '1' });
  },
);
