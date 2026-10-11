import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * Builds the production bundles the tests launch (`.vite/`), via `electron-forge package`
 * (Forge has no build-only command). Signing is skipped. `pnpm dev` replaces `.vite/` with a
 * dev build, so the suite always rebuilds unless E2E_SKIP_BUILD=1.
 */
export default function globalSetup(): void {
  const projectDir = path.dirname(import.meta.dirname);

  if (process.env.E2E_SKIP_BUILD === '1') {
    const renderer = path.join(projectDir, '.vite/renderer/main_window/index.html');
    if (!existsSync(renderer)) {
      throw new Error('No production build in .vite/. Run `pnpm package` or unset E2E_SKIP_BUILD.');
    }
    return;
  }

  const forgeCli = createRequire(import.meta.url).resolve(
    '@electron-forge/cli/dist/electron-forge.js',
  );
  execFileSync(process.execPath, [forgeCli, 'package'], {
    cwd: projectDir,
    stdio: 'inherit',
    // CI=1: plain log output instead of Forge's interactive terminal UI.
    env: { ...process.env, CORRALLM_UNSIGNED: '1', CI: '1' },
  });
}
