import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from 'vitest';

const execute = promisify(execFile);
it.each(['--help', '-h'])('prints help and exits successfully for %s', async (flag) => {
  const file = path.resolve('dist-cli/corrallm.cjs');
  const result = await execute(process.execPath, [file, flag], {
    env: { ...process.env, CORRALLM_AGENT_PATHS: '{}', CORRALLM_NATIVE_SELFTEST: '0' },
    timeout: 10_000,
  });
  expect(result.stdout).toContain('Usage:');
  expect(result.stdout).toContain('corrallm serve');
  expect(result.stderr).toBe('');
});
