import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * Test files that run the CLI bundle or the test-lifetime guardian this setup builds. Keep this
 * in step with the files that name dist-cli, test-children or test-lifetime (global-setup.test.ts
 * fails when a test file outside it uses them).
 */
export const CLI_BUILD_USERS = /^src\/main\/(?:cli\/|core\/entry\.test|e2e-build\.test|shipped-)/;

/**
 * Whether a run needs the build: always for a full run or for a filter that is not one exact test
 * file path (a directory or a word could select any file), otherwise only when a named file uses it.
 */
export function needsCliBuild(filters: readonly string[]): boolean {
  if (filters.length === 0) return true;
  return filters.some((filter) => {
    const file = filter.replace(/^\.\//, '');
    return !/\.test\.tsx?$/.test(file) || CLI_BUILD_USERS.test(file);
  });
}

/** Flags whose next argument is a value, not a filter. */
const VALUE_FLAGS = new Set(['--project', '--maxWorkers', '--reporter', '--exclude', '-t']);

/**
 * The positional filters of a `vitest run ...` command line. Anything that is not a `run` (watch,
 * the API) gives a filter that is no test file, which makes the build run.
 */
export function filtersFromArgv(argv: readonly string[]): string[] {
  const start = argv.indexOf('run');
  if (start < 0) return ['?'];
  const filters: string[] = [];
  for (let i = start + 1; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (VALUE_FLAGS.has(arg)) i++;
    else if (!arg.startsWith('-')) filters.push(arg);
  }
  return filters;
}

/**
 * The vitest `main` project's global setup: builds the CLI bundle (dist-cli/corrallm.cjs, as `pnpm
 * build:cli` does), so the tests that run it (serve.test.ts) always run the current code, plus
 * the independent test-process guardian and its worker-death fixture (never shipping outputs).
 */
export default function globalSetup(): void {
  if (!needsCliBuild(filtersFromArgv(process.argv))) return;
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
  execFileSync(
    process.execPath,
    [viteCli, 'build', '--config', 'vite.test-lifetime.config.mts', '--logLevel', 'warn'],
    {
      cwd: projectDir,
      stdio: 'inherit',
    },
  );
}
