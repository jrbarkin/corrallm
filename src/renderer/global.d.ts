import type { AppApi } from '../shared/ipc';

declare global {
  interface Window {
    /** Exposed by the preload script (src/preload/index.ts). */
    readonly api: AppApi;
  }
}
