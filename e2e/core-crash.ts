import type { ElectronApplication, Page } from '@playwright/test';
import { expect } from '@playwright/test';

/** Kill the actual core, not its window: checkpoint recovery must have a new owner and epoch. */
export async function crashCore(application: ElectronApplication): Promise<void> {
  const old = await application.evaluate(({ app }) => {
    const core = app
      .getAppMetrics()
      .find((metric) => metric.serviceName === 'corrallm core' || metric.name === 'corrallm core');
    if (!core) throw new Error('No corrallm core process');
    process.kill(core.pid, 'SIGKILL');
    return core.pid;
  });
  await expect
    .poll(() =>
      application.evaluate(({ app }, previous) => {
        const pid = app
          .getAppMetrics()
          .find(
            (metric) => metric.serviceName === 'corrallm core' || metric.name === 'corrallm core',
          )?.pid;
        return pid !== undefined && pid !== previous;
      }, old),
    )
    .toBe(true);
}

/**
 * Kills the core and waits for the window to reload into its replacement. Main still reloads every
 * window once a new core is up (host/ports.ts `reconnect`), so the page starts over: its views
 * (an open All queues, selections) are gone, and it shows the canvas the new core restored,
 * paused.
 */
export async function crashCoreAndReload(
  application: ElectronApplication,
  page: Page,
): Promise<void> {
  const reloaded = page.waitForEvent('load');
  await crashCore(application);
  await reloaded;
}
