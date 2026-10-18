import { CoreLink } from './link';
import type { LinkPort } from './link';
import type { CoreSide, HostSide } from './protocol';
import { memoryText, runChecks, selfTestChecks } from './selftest';

/*
 * The core process's entry (.vite/build/core.cjs): main forks it with utilityProcess.fork
 * (host/core-process.ts) and talks to it over CoreLink on its parentPort. For now it has only a
 * self-test mode: it says it is ready, then runs the native self-test's checks when main asks
 * (CORRALLM_NATIVE_SELFTEST=1, native-selftest.ts).
 */

/** The utility process's port to main, as a link's port: main outlives it, so it never goes. */
function parentPortOf(parent: Electron.ParentPort): LinkPort {
  return {
    post: (message) => {
      parent.postMessage(message);
    },
    start: (receive) => {
      parent.on('message', ({ data }) => {
        receive(data);
      });
    },
    close: () => {
      parent.removeAllListeners('message');
    },
  };
}

// Undefined unless this runs as a utility process (as under plain Node).
const parent = process.parentPort as Electron.ParentPort | undefined;
if (!parent) {
  console.error('core.cjs runs only as corrallm’s core process, forked by the app.');
  process.exit(1);
}

const link = new CoreLink<CoreSide, HostSide>(
  parentPortOf(parent),
  {
    selftest: async ({ packaged }) => ({
      checks: await runChecks(selfTestChecks({ packaged })),
      memory: memoryText(),
    }),
  },
  // Checking that only plain data crosses costs a walk of every value: only under `pnpm dev`.
  { check: MAIN_WINDOW_VITE_DEV_SERVER_URL !== undefined },
);
link.emit('ready', memoryText());
