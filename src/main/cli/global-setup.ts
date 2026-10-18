import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * The vitest `main` project's global setup: builds the CLI bundle (dist-cli/corrallm.cjs, as `pnpm
 * build:cli` does), so the tests that run it (serve.test.ts) always run the current code.
 */
export default function globalSetup(): void {
  const projectDir = path.resolve(import.meta.dirname, '..', '..', '..');
  const require = createRequire(import.meta.url);
  // Vite's package exports no bin: found beside its package.json.
  const viteCli = path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js');
  execFileSync(
    process.execPath,
    [viteCli, 'build', '--config', 'vite.cli.config.mts', '--logLevel', 'warn'],
    {
      cwd: projectDir,
      stdio: 'inherit',
    },
  );
}
