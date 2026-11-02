import type { ElectronApplication, Page } from '@playwright/test';

/** Crash the view without ending its core or native sessions. */
export async function crashRenderer(app: ElectronApplication, page: Page): Promise<void> {
  const crashed = page.waitForEvent('crash');
  const retired = app.evaluate(
    ({ BrowserWindow }) =>
      new Promise<void>((resolve, reject) => {
        const contents = BrowserWindow.getAllWindows()[0]?.webContents;
        if (!contents) throw new Error('No renderer to crash');
        const pid = contents.getOSProcessId();
        if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid)
          throw new Error('No separate renderer process to crash');
        // CDP can report the crash before Electron finishes retiring the child and its core port.
        const gone = () => {
          resolve();
        };
        contents.once('render-process-gone', gone);
        try {
          // Abrupt process death, without Electron's Linux hung-process crash-dump request.
          process.kill(pid, 'SIGKILL');
        } catch (error) {
          contents.removeListener('render-process-gone', gone);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      }),
  );
  await Promise.all([crashed, retired]);
}
