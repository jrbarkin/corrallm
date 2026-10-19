import path from 'node:path';

import { app } from 'electron';

import { memoryText, runChecks, SELFTEST_TIMEOUT_MS, selfTestChecks } from './core/selftest';
import type { CheckResult } from './core/selftest';
import { forkCore } from './host/core-process';
import { hostServices } from './host/services';

/**
 * Diagnostic only, not feature code: proves, in the app as built (including a packaged, fused
 * build), that what the core needs works, first in this main process, then in a forked core process (an Electron utility process, where the core runs).
 * Triggered by CORRALLM_NATIVE_SELFTEST=1; see CLAUDE.md. The checks are core/selftest.ts's:
 * node-pty, a terminal screen, an Agent SDK query against a fake `claude` of its own (run with
 * `node`, which must be on the PATH), loopback HTTP, spawning, and, packaged, that
 * child_process.fork is refused. Exits 0 once every check passed in both, 2 if one failed (saying
 * which) or the core process failed, 3 on a timeout, 4 on an uncaught error.
 */
export async function runNativeSelfTest(): Promise<void> {
  // Log and exit instead of Electron's default handler, which shows a modal error dialog that
  // nobody dismisses on a CI runner.
  const fail = (kind: string) => (error: unknown) => {
    console.error(`[native-selftest] ${kind}:`, error);
    app.exit(4);
  };
  process.on('uncaughtException', fail('uncaught exception'));
  process.on('unhandledRejection', fail('unhandled rejection'));

  const timeout = setTimeout(() => {
    console.error('[native-selftest] timed out');
    app.exit(3);
  }, SELFTEST_TIMEOUT_MS);

  const packaged = app.isPackaged;
  console.log(`[native-selftest] main: ${memoryText()}`);
  const inMain = report('', await runChecks(selfTestChecks({ packaged })));
  const inCore = await checkCoreProcess(packaged);
  clearTimeout(timeout);
  setImmediate(() => {
    app.exit(inMain && inCore ? 0 : 2);
  });
}

/** Logs each check's outcome, prefixed: true if every one passed. */
function report(prefix: string, results: readonly CheckResult[]): boolean {
  for (const { ok, said } of results) {
    if (ok) console.log(`[native-selftest] ${prefix}${said}`);
    else console.error(`[native-selftest] ${prefix}${said}`);
  }
  return results.every(({ ok }) => ok);
}

/** Forks the core process, as the app will, and runs the checks there: true if all passed. */
async function checkCoreProcess(packaged: boolean): Promise<boolean> {
  const forked = performance.now();
  const core = forkCore({
    entry: path.join(__dirname, 'core.cjs'),
    output: (line, stream) => {
      if (stream === 'stdout') console.log(`[native-selftest] core printed: ${line}`);
      else console.error(`[native-selftest] core printed: ${line}`);
    },
    check: MAIN_WINDOW_VITE_DEV_SERVER_URL !== undefined,
    host: hostServices(),
  });
  try {
    const memory = await new Promise<string>((resolve, reject) => {
      core.link.on('ready', resolve);
      void core.exited.then((code) => {
        reject(new Error(`it exited with code ${String(code)} before it was ready`));
      });
    });
    const startup = Math.round(performance.now() - forked);
    console.log(`[native-selftest] core: ready ${String(startup)} ms after fork (${memory})`);
    const answer = await core.link.request('selftest', { packaged });
    if (!answer.ok) throw new Error(answer.error.message);
    const passed = report('core: ', answer.value.checks);
    console.log(`[native-selftest] core: after the checks, ${answer.value.memory}`);
    return passed;
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    console.error(`[native-selftest] the core process failed: ${why}`);
    return false;
  } finally {
    core.kill();
  }
}
