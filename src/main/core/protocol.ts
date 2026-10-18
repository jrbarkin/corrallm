import type { CheckResult } from './selftest';

/*
 * What main and the core process ask and tell each other, over CoreLink on the core's parentPort
 * (entry.ts in the core, host/core-process.ts in main). For now the core only runs the native
 * self-test; main answers nothing yet.
 */

/** What the core process answers and sends. */
export interface CoreSide {
  requests: {
    /** Runs the native self-test's checks (`packaged`: whether the app is) and reports them. */
    selftest: { args: [options: { packaged: boolean }]; result: SelfTestReport };
  };
  events: {
    /** The core is up and listening, using this much memory. */
    ready: [memory: string];
  };
}

/** What main answers and sends the core process. */
export interface HostSide {
  requests: Record<string, never>;
  events: Record<string, never>;
}

export interface SelfTestReport {
  checks: CheckResult[];
  /** The core's memory once the checks have run. */
  memory: string;
}
