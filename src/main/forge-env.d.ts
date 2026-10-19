// Constants injected by @electron-forge/plugin-vite at build time, one pair per renderer in
// forge.config.mts. Declared here rather than via '@electron-forge/plugin-vite/forge-vite-env'
// because that file types the dev server URL as `string`, but it is `undefined` outside
// `electron-forge start` (production and packaged builds). And corrallm's own, from
// vite.main.config.mts's `define`.
import type { Distribution } from './sessions/codex/login';

declare global {
  const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
  const MAIN_WINDOW_VITE_NAME: string;
  /**
   * How this build is offered (sessions/codex/login.ts): 'local' unless built with
   * CORRALLM_DISTRIBUTION=commercial or hosted. Defined by vite.main.config.mts.
   */
  const CORRALLM_DISTRIBUTION: Distribution;
  /** corrallm's version, from package.json: what the CLI's core says it is. */
  const CORRALLM_VERSION: string;
}
