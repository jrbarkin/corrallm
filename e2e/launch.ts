import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { _electron as electron } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';

/**
 * Launches the production build ('.' resolves package.json "main", .vite/build/main.cjs) with a
 * throwaway profile. The real one (~/Library/Application Support/corrallm or its equivalent) is
 * shared with the packaged app and keeps state such as a page zoom set with ⌘+, which would shrink
 * the canvas under the coordinate-based tests. `close()` quits the app and deletes the profile.
 */
export async function launchApp(): Promise<{
  app: ElectronApplication;
  close: () => Promise<void>;
}> {
  const profile = mkdtempSync(path.join(tmpdir(), 'corrallm-e2e-'));
  const remove = () => {
    rmSync(profile, { recursive: true, force: true });
  };
  let app: ElectronApplication;
  try {
    app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`] });
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
