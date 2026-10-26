import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import path from 'node:path';

import { _electron as electron } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';

import { agentElectronExecutable } from './agent-electron';

/**
 * Launches the production build ('.' resolves package.json "main", .vite/build/main.cjs) with its
 * window hidden (CORRALLM_HIDE_WINDOW: it renders, but never shows on screen or meets the real
 * mouse; on macOS there is no Dock icon either, see agent-electron.ts) and a throwaway profile.
 * The real one (~/Library/Application Support/corrallm or its equivalent) is shared with the
 * packaged app and keeps state such as a page zoom set with ⌘+, which would shrink the canvas
 * under the coordinate-based tests. `close()` quits the app and deletes the profile. `env` adds
 * to the app's environment (CORRALLM_FAKE_SESSIONS=1: connected agents run a fake, not Claude).
 * `profile`: a profile of the test's own instead, kept when the app quits (to launch it again, as
 * after a restart); the test deletes it. Connected agents find no `claude` or `codex` unless `env`
 * points CORRALLM_AGENT_PATHS at one (a fake): never the user's own.
 */
export async function launchApp({
  env: extra = {},
  profile: given,
  args = [],
  diagnoseFailure = () => false,
}: {
  env?: Record<string, string>;
  profile?: string;
  args?: string[];
  /** The spec supplies its outcome; global setup has no running test. */
  diagnoseFailure?: () => boolean;
} = {}): Promise<{
  app: ElectronApplication;
  close: () => Promise<void>;
}> {
  const profile = given ?? mkdtempSync(path.join(tmpdir(), 'corrallm-e2e-'));
  const remove = () => {
    if (given === undefined) rmSync(profile, { recursive: true, force: true });
  };
  const diagnostics = {
    FAKE_CLAUDE_DIAGNOSTICS: path.join(profile, 'fake-sdk-startup.jsonl'),
    FAKE_CODEX_DIAGNOSTICS: path.join(profile, 'fake-app-server-startup.jsonl'),
  };
  let app: ElectronApplication;
  try {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    const executablePath = agentElectronExecutable();
    // Docker has Mesa llvmpipe rather than a passed-through GPU. These switches belong only
    // to this unpackaged test launch, never main's defaults or the packaged-app checks. The
    // hidden window gets a frame only once a second here (rAF and every input event wait for
    // one: a mouse move took 1 s, a drag of 40 moves a minute) unless the frame rate limit is off.
    const graphics =
      platform() === 'linux' && env.CORRALLM_E2E_GL === 'mesa'
        ? [
            '--use-gl=angle',
            '--use-angle=gl',
            '--ignore-gpu-blocklist',
            '--ozone-platform=x11',
            '--disable-frame-rate-limit',
          ]
        : [];
    app = await electron.launch({
      // Playwright otherwise prepends --no-sandbox on Linux. Test the app's real sandbox,
      // including under xvfb in Docker (whose profiles allow unprivileged user namespaces).
      chromiumSandbox: true,
      ...(executablePath ? { executablePath } : {}),
      args: [...graphics, '.', `--user-data-dir=${profile}`, ...args],
      env: {
        ...env,
        // Paths with nothing there: only the CLIs a test gives are found (main looks nowhere else).
        CORRALLM_AGENT_PATHS: '{}',
        ...diagnostics,
        ...extra,
        CORRALLM_HIDE_WINDOW: '1',
      },
    });
  } catch (error) {
    remove();
    throw error;
  }
  // Keep bounded tails, not the environment (which can hold credentials). Startup failures
  // often become session notices rather than page errors; include the UI before teardown too.
  let output = '';
  for (const stream of ['stdout', 'stderr'] as const) {
    app.process()[stream]?.on('data', (chunk: Buffer) => {
      output = `${output}[${stream}] ${chunk.toString('utf8')}`.slice(-32_768);
    });
  }
  return {
    app,
    close: async () => {
      // Its process, read while the app is open: Playwright forgets it once the app closes.
      const child = app.process();
      try {
        if (diagnoseFailure()) {
          for (const [name, file] of Object.entries(diagnostics)) {
            let text: string;
            try {
              text = readFileSync(file, 'utf8').slice(-32_768);
            } catch {
              text = '(not started, or diagnostic variable did not reach the fake)';
            }
            console.error(`[e2e ${name}]\n${text}`);
          }
          console.error(`[e2e app output]\n${output || '(no output)'}`);
          for (const page of app.windows()) {
            const text = await page
              .locator('body')
              .innerText({ timeout: 2000 })
              .catch(() => '(window unavailable)');
            console.error(`[e2e window before close]\n${text.slice(-32_768)}`);
          }
        }
        await app.close();
        const code = child.exitCode;
        if (code !== 0) throw new Error(`corrallm exited with code ${String(code)} while closing.`);
      } finally {
        remove();
      }
    },
  };
}
