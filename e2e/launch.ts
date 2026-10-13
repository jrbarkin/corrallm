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
 */
export async function launchApp({
  env: extra = {},
}: { env?: Record<string, string> } = {}): Promise<{
  app: ElectronApplication;
  close: () => Promise<void>;
}> {
  const profile = mkdtempSync(path.join(tmpdir(), 'corrallm-e2e-'));
  const remove = () => {
    rmSync(profile, { recursive: true, force: true });
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
      args: ['.', `--user-data-dir=${profile}`],
      env: { ...env, ...extra, CORRALLM_HIDE_WINDOW: '1' },
    });
  } catch (error) {
    remove();
    throw error;
  }
  return {
    app,
    close: async () => {
      try {
        await app.close();
      } finally {
        remove();
      }
    },
  };
}
