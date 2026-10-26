import type { AppApi } from '../shared/gui-link';

declare global {
  interface Window {
    /** Exposed by the preload script (src/preload/index.ts). */
    readonly api: AppApi;
  }
}
