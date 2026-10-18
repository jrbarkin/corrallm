import os from 'node:os';

import { app } from 'electron';

import { checkAgentSdk, checkTerminalScreen } from './selftest';
import { spawnPty } from './sessions/terminal/pty';

/**
 * Diagnostic only, not feature code: proves, inside this main process (including a packaged,
 * fused build), that what connected sessions need works, then exits with 0. Triggered by
 * CORRALLM_NATIVE_SELFTEST=1; see CLAUDE.md. Checked: node-pty loads and runs a shell in a
 * pseudo-terminal (as Terminal agents run Claude Code); main's copy of a terminal's screen
 * (@xterm/headless) works; and the bundled Agent SDK starts a query, against a fake `claude` of
 * its own (selftest.ts; it runs with `node`, which must be on the PATH). Any failure exits with 2.
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
  }, 60_000);

  const checks: [string, () => Promise<string>][] = [
    ['node-pty', checkPty],
    ['terminal screen', checkTerminalScreen],
    ['Agent SDK', () => checkAgentSdk()],
  ];
  for (const [name, check] of checks) {
    try {
      console.log(`[native-selftest] ${await check()}`);
    } catch (error) {
      clearTimeout(timeout);
      console.error(`[native-selftest] ${name} failed:`, error);
      app.exit(2);
      return;
    }
  }
  clearTimeout(timeout);
  setImmediate(() => {
    app.exit(0);
  });
}

/** Runs a shell that exits at once in a pseudo-terminal, as Terminal sessions run (pty.ts). */
async function checkPty(): Promise<string> {
  const isWindows = process.platform === 'win32';
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const child = await spawnPty(
    isWindows ? 'cmd.exe' : '/bin/sh',
    isWindows ? ['/d', '/c', 'exit 0'] : ['-c', 'exit 0'],
    { cwd: os.homedir(), env, cols: 80, rows: 24 },
  );
  const code = await new Promise<number>((resolve) => {
    child.onExit(({ exitCode }) => {
      resolve(exitCode);
    });
  });
  if (code !== 0) throw new Error(`the shell exited with ${String(code)}`);
  return `node-pty ok (pid ${String(child.pid)}, exit ${String(code)})`;
}
