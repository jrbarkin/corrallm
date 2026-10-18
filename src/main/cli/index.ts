import { memoryText, runChecks, SELFTEST_TIMEOUT_MS, selfTestChecks } from '../core/selftest';

/*
 * `corrallm`, one Node CLI on the same code as the app's core, run under plain Node rather than
 * Electron. `pnpm build:cli` builds it (vite.cli.config.mts) into dist-cli/corrallm.cjs, and
 * `pnpm corrallm` runs it. For now it only runs the native self-test (CORRALLM_NATIVE_SELFTEST=1):
 * the core's checks, as the app runs them in its core process, exiting the same way: 0 once every
 * check passed, 2 if one failed, 3 on a timeout, 4 on an uncaught error.
 */

const USAGE = 'Usage: CORRALLM_NATIVE_SELFTEST=1 corrallm (the native self-test, under plain Node)';

/** Exits with `code` once what was printed has been written out (a pipe may lag). */
function exit(code: number): void {
  process.exitCode = code;
  process.stdout.write('', () => {
    process.stderr.write('', () => {
      process.exit(code);
    });
  });
}

async function selfTest(): Promise<void> {
  const fail = (kind: string) => (error: unknown) => {
    console.error(`[native-selftest] ${kind}:`, error);
    exit(4);
  };
  process.on('uncaughtException', fail('uncaught exception'));
  process.on('unhandledRejection', fail('unhandled rejection'));
  const timeout = setTimeout(() => {
    console.error('[native-selftest] timed out');
    exit(3);
  }, SELFTEST_TIMEOUT_MS);

  // Since this process started: Node's own start, and loading the bundle.
  const startup = Math.round(performance.now());
  console.log(`[native-selftest] cli: ready ${String(startup)} ms after start (${memoryText()})`);
  const results = await runChecks(selfTestChecks({ packaged: false }));
  for (const { ok, said } of results) {
    if (ok) console.log(`[native-selftest] cli: ${said}`);
    else console.error(`[native-selftest] cli: ${said}`);
  }
  console.log(`[native-selftest] cli: after the checks, ${memoryText()}`);
  clearTimeout(timeout);
  exit(results.every(({ ok }) => ok) ? 0 : 2);
}

if (process.env.CORRALLM_NATIVE_SELFTEST === '1') {
  void selfTest();
} else {
  console.error(USAGE);
  exit(1);
}
