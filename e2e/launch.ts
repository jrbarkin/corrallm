import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
 * points CORRALLM_CLAUDE_PATH or CORRALLM_CODEX_PATH at one (a fake): never the user's own.
 */
export async function launchApp({
  env: extra = {},
  profile: given,
  args = [],
}: { env?: Record<string, string>; profile?: string; args?: string[] } = {}): Promise<{
  app: ElectronApplication;
  close: () => Promise<void>;
}> {
  const profile = given ?? mkdtempSync(path.join(tmpdir(), 'corrallm-e2e-'));
  const remove = () => {
    if (given === undefined) rmSync(profile, { recursive: true, force: true });
  };
  let app: ElectronApplication;
  try {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    const executablePath = agentElectronExecutable();
    app = await electron.launch({
      ...(executablePath ? { executablePath } : {}),
      args: ['.', `--user-data-dir=${profile}`, ...args],
      env: {
        ...env,
        // Paths with nothing there: only the CLIs a test gives are found (main looks nowhere else).
        CORRALLM_CLAUDE_PATH: path.join(profile, 'no-claude'),
        CORRALLM_CODEX_PATH: path.join(profile, 'no-codex'),
        ...extra,
        CORRALLM_HIDE_WINDOW: '1',
      },
    });
  } catch (error) {
    remove();
    throw error;
  }
  return {
    app,
    close: async () => {
      // Its process, read while the app is open: Playwright forgets it once the app closes.
      const child = app.process();
      try {
        await app.close();
        const code = child.exitCode;
        if (code !== 0) throw new Error(`corrallm exited with code ${String(code)} while closing.`);
      } finally {
        remove();
      }
    },
  };
}
