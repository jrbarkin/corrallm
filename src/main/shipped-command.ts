import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import { SELFTEST_TIMEOUT_MS } from './core/selftest';

const execute = promisify(execFile);
type Run = (
  file: string,
  options: { env: NodeJS.ProcessEnv; timeout: number },
) => Promise<{ stdout: string; stderr: string }>;

/** The shipped command must need neither a checkout nor a Node on its caller's PATH. */
export async function checkShippedCommand(
  resources: string,
  run: Run = (file, options) => execute(file, [], { ...options, maxBuffer: 4 * 1024 * 1024 }),
): Promise<string> {
  const { stdout } = await run(path.join(resources, 'bin/corrallm'), {
    env: { ...process.env, PATH: '', NODE_OPTIONS: '', CORRALLM_NATIVE_SELFTEST: '1' },
    timeout: SELFTEST_TIMEOUT_MS,
  });
  return stdout.trim();
}
