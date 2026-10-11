import os from 'node:os';

import { app } from 'electron';

/**
 * Diagnostic only, not feature code: proves node-pty loads and can spawn a process inside this
 * main process (including a packaged, fused build), then exits with 0 on success.
 * Triggered by CORRALLM_NATIVE_SELFTEST=1; see CLAUDE.md.
 */
export async function runNativeSelfTest(): Promise<void> {
  const timeout = setTimeout(() => {
    console.error('[native-selftest] timed out waiting for the pty to exit');
    app.exit(3);
  }, 30_000);

  try {
    const pty = await import('node-pty');
    const isWindows = process.platform === 'win32';
    const child = pty.spawn(
      isWindows ? 'cmd.exe' : '/bin/sh',
      isWindows ? ['/d', '/c', 'exit 0'] : ['-c', 'exit 0'],
      {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: os.homedir(),
        env: process.env,
        // The RunAsNode fuse makes child_process.fork throw; node-pty's default Windows
        // kill path forks a helper, the bundled ConPTY DLL path does not.
        ...(isWindows ? { useConptyDll: true } : {}),
      },
    );
    child.onExit(({ exitCode }) => {
      clearTimeout(timeout);
      console.log(
        `[native-selftest] node-pty ok (pid ${String(child.pid)}, exit ${String(exitCode)})`,
      );
      setImmediate(() => {
        app.exit(exitCode === 0 ? 0 : 1);
      });
    });
  } catch (error) {
    clearTimeout(timeout);
    console.error('[native-selftest] node-pty failed:', error);
    app.exit(2);
  }
}
