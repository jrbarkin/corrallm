import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { makeAgentElectron } from './agent-electron';
import { checkWebGL2 } from './webgl';

/**
 * Builds the production bundles the tests launch (`.vite/`), via `electron-forge package`
 * (Forge has no build-only command); its prePackage hook builds the CLI bundle (`dist-cli/`).
 * Signing and shipped-command staging are skipped. `pnpm dev` replaces `.vite/` with a dev build,
 * so the suite always rebuilds unless E2E_SKIP_BUILD=1. On macOS it also makes the Electron copy
 * the tests launch so that no Dock icon appears (agent-electron.ts).
 */
export default async function globalSetup(): Promise<void> {
  const projectDir = path.dirname(import.meta.dirname);
  makeAgentElectron();

  if (process.env.E2E_SKIP_BUILD === '1') {
    const renderer = path.join(projectDir, '.vite/renderer/main_window/index.html');
    if (!existsSync(renderer)) {
      throw new Error('No production build in .vite/. Run `pnpm package` or unset E2E_SKIP_BUILD.');
    }
    if (!existsSync(path.join(projectDir, 'dist-cli/corrallm.cjs'))) {
      throw new Error('No CLI bundle in dist-cli/. Run `pnpm build:cli` or unset E2E_SKIP_BUILD.');
    }
  } else {
    const require = createRequire(import.meta.url);
    const forgeCli = require.resolve('@electron-forge/cli/dist/electron-forge.js');
    execFileSync(process.execPath, [forgeCli, 'package'], {
      cwd: projectDir,
      stdio: 'inherit',
      // CI=1: plain log output instead of Forge's interactive terminal UI.
      env: { ...process.env, CORRALLM_UNSIGNED: '1', CORRALLM_E2E_BUILD: '1', CI: '1' },
    });
  }

  // Probe the actual production renderer before spending an hour on specs that need xterm.
  // Reusing a build must still check this machine's current graphics environment.
  await checkWebGL2();
}
