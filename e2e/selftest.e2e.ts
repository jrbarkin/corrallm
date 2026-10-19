import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import { agentElectronExecutable } from './agent-electron';

/*
 * The native self-test (CORRALLM_NATIVE_SELFTEST=1) of the production build, unpackaged: the app
 * runs the checks in main and then in its core process (an Electron utility process, core.cjs),
 * and the CLI bundle (dist-cli/corrallm.cjs, built by the global setup) runs them under plain Node.
 * The packaged app's run (with its fuses, and child_process.fork refused) is CI's and
 * scripts/check-linux.sh's.
 */

const projectDir = path.dirname(import.meta.dirname);

/** Every check the self-test runs outside a packaged app, as each one reports passing. */
const PASSED = [
  /node-pty ok \(pid \d+, exit 0\)/,
  /@xterm\/headless ok \(40×5\)/,
  /Agent SDK ok \(the fake claude said “ok”\)/,
  /SQLite \d+\.\d+\.\d+, WAL, synchronous FULL(?:, fullfsync)?, its other pragmas as set, a write through the lane read back, a snapshot read back/,
  /loopback HTTP ok \(127\.0\.0\.1:\d+\)/,
  /spawn ok \(pid \d+, exit 0\)/,
];

function run(
  file: string,
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { cwd: projectDir, env: { ...process.env, CORRALLM_NATIVE_SELFTEST: '1' }, timeout: 90_000 },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === 'number' ? error.code : null) : 0,
          stdout,
          stderr,
        });
      },
    );
  });
}

/** The lines a self-test printed with `prefix` (after "[native-selftest] "). */
function linesOf(stdout: string, prefix: string): string[] {
  return stdout
    .split('\n')
    .filter((line) => line.startsWith(`[native-selftest] ${prefix}`))
    .map((line) => line.slice(`[native-selftest] ${prefix}`.length));
}

test('the built app passes the self-test in main and in its core process', async () => {
  test.setTimeout(120_000);
  const profile = mkdtempSync(path.join(tmpdir(), 'corrallm-e2e-'));
  try {
    const electron =
      agentElectronExecutable() ?? (createRequire(import.meta.url)('electron') as string);
    const { code, stdout, stderr } = await run(electron, ['.', `--user-data-dir=${profile}`]);

    expect(code, `${stdout}\n${stderr}`).toBe(0);
    const inMain = linesOf(stdout, '').filter((line) => !line.startsWith('core'));
    const inCore = linesOf(stdout, 'core: ');
    for (const passed of PASSED) {
      expect(
        inMain.some((line) => passed.test(line)),
        `main: ${passed.source}`,
      ).toBe(true);
      expect(
        inCore.some((line) => passed.test(line)),
        `core: ${passed.source}`,
      ).toBe(true);
    }
    expect(inCore).toContainEqual(expect.stringMatching(/^ready \d+ ms after fork \(rss \d+ MB/));
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
});

test('the CLI bundle passes the self-test under plain Node', async () => {
  const { code, stdout, stderr } = await run(process.execPath, ['dist-cli/corrallm.cjs']);

  expect(code, `${stdout}\n${stderr}`).toBe(0);
  const lines = linesOf(stdout, 'cli: ');
  for (const passed of PASSED) {
    expect(
      lines.some((line) => passed.test(line)),
      passed.source,
    ).toBe(true);
  }
});
