import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import { agentElectronExecutable } from './agent-electron';
import { launchApp } from './launch';

/*
 * One owner per profile (<profile>/core.lock), both ways, with the built app: `corrallm serve`
 * (the CLI bundle, built by the global setup) refuses a profile the app holds (its core process
 * holds the lock), and the app refuses to start on a profile `corrallm serve` holds, saying so (in
 * a dialog; the hidden e2e app, which may show nothing on screen, says it on stderr only) and
 * leaving the lock as it was.
 */

const projectDir = path.dirname(import.meta.dirname);

let profile: string;

test.beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-e2e-lock-'));
});

test.afterEach(async () => {
  await rm(profile, { recursive: true, force: true });
});

function run(
  file: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { cwd: projectDir, env: { ...process.env, ...env }, timeout: 60_000 },
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

test('corrallm serve refuses a profile the app holds', async () => {
  const { app, close } = await launchApp({ profile });
  try {
    await app.firstWindow();
    // The app's core process holds the profile, not its main process.
    const [pid, ...others] = await app.evaluate(({ app: electronApp }) =>
      electronApp
        .getAppMetrics()
        .filter((metric) => metric.type === 'Utility' && metric.name === 'corrallm core')
        .map((metric) => metric.pid),
    );
    expect(others).toEqual([]);
    expect(pid).not.toBe(app.process().pid);
    const lock = JSON.parse(await readFile(path.join(profile, 'core.lock'), 'utf8')) as unknown;
    expect(lock).toMatchObject({ owner: 'app', pid });

    const { code, stderr } = await run(process.execPath, [
      'dist-cli/corrallm.cjs',
      'serve',
      '--profile',
      profile,
      '--canvas',
      path.join(profile, 'none.corral'),
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain(`The corrallm app (process ${String(pid)}) is using this profile.`);
  } finally {
    await close();
  }
  // Quitting lets it go.
  await expect(readFile(path.join(profile, 'core.lock'), 'utf8')).rejects.toThrow(/ENOENT/);
});

test('the app refuses to start on a profile corrallm serve holds, and says so', async () => {
  test.setTimeout(90_000);
  // Held by a live process: this one, standing in for `corrallm serve`.
  const held = JSON.stringify({
    owner: 'serve',
    pid: process.pid,
    started: Date.now() - process.uptime() * 1000,
  });
  await writeFile(path.join(profile, 'core.lock'), held);
  const electron =
    agentElectronExecutable() ?? (createRequire(import.meta.url)('electron') as string);
  const { code, stderr } = await run(electron, ['.', `--user-data-dir=${profile}`], {
    CORRALLM_HIDE_WINDOW: '1',
  });
  expect(code).toBe(1);
  expect(stderr).toContain(
    `corrallm serve (process ${String(process.pid)}) is using this profile.`,
  );
  expect(await readFile(path.join(profile, 'core.lock'), 'utf8')).toBe(held);
});
