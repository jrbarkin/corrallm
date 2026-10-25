import type { ElectronApplication } from '@playwright/test';
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
