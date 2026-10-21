import { CoreLink } from '../../shared/link';
import type { LinkPort } from '../../shared/link';
import { createCore } from './core';
import type { Core } from './core';
import { appHost } from './host/app';
import { WindowPorts } from './gui';
import type { WindowPort } from './gui';
import type { WindowId } from './host';
import { lockProfile, ProfileLocked } from './lock';
import type { ProfileLock } from './lock';
import { isWindowMessage } from './protocol';
import type { CoreSide, HostSide } from './protocol';
import { memoryText, runChecks, selfTestChecks } from './selftest';

/*
 * The core process's entry (.vite/build/core.cjs): main forks it with utilityProcess.fork
 * (host/core-process.ts) and talks to it over CoreLink on its parentPort. For the app, main asks it
 * `init`: it takes the profile (core.lock, one owner per profile: lock.ts) before it composes the
 * core on it, and holds it until the core closes or the process ends; while `corrallm serve` holds
 * it, init says who does and composes nothing. Main hands it each trusted window's port beside the
 * link (B8 Design §3), which it serves once composed (core/gui.ts). In the native self-test
 * (CORRALLM_NATIVE_SELFTEST=1, native-selftest.ts) main only asks it to run the checks, and it is
 * never composed.
 */

// Checking that only plain data crosses costs a walk of every value: only under `pnpm dev`.
const check = MAIN_WINDOW_VITE_DEV_SERVER_URL !== undefined;

/**
 * The utility process's port to main, as a link's port: main outlives it, so it never goes. A
 * window's port, which main posts beside the link, goes to `window` instead.
 */
function parentPortOf(
  parent: Electron.ParentPort,
  window: (id: WindowId, port: WindowPort) => void,
): LinkPort {
  return {
    post: (message) => {
      parent.postMessage(message);
    },
    start: (receive) => {
      parent.on('message', ({ data, ports }) => {
        const [port] = ports;
        if (isWindowMessage(data) && port !== undefined && ports.length === 1) {
          window(data.window, windowPortOf(port));
        } else {
          receive(data);
        }
      });
    },
  };
}

/** The core's end of a window's port: gone once the window's end is. */
function windowPortOf(port: Electron.MessagePortMain): WindowPort {
  return {
    post: (message) => {
      port.postMessage(message);
    },
    start: (receive, gone) => {
      port.on('message', ({ data }) => {
        receive(data);
      });
      port.once('close', () => {
        gone('the window’s port closed');
      });
      port.start();
    },
    close: () => {
      port.close();
    },
  };
}

// Undefined unless this runs as a utility process (as under plain Node).
const parent = process.parentPort as Electron.ParentPort | undefined;
if (!parent) {
  console.error('core.cjs runs only as corrallm’s core process, forked by the app.');
  process.exit(1);
}

/** The windows' ports, served once the core is composed: a window's that comes before waits. */
const windows = Promise.withResolvers<WindowPorts>();
let composed = false;
const ready = Promise.withResolvers<Core>();
/** The profile, once init holds it: let go once the core closes, or as the process ends. */
let held: ProfileLock | undefined;
const release = () => {
  held?.release();
  held = undefined;
};
process.once('exit', release);

const link = new CoreLink<CoreSide, HostSide>(
  parentPortOf(parent, (window, port) => {
    void windows.promise.then((served) => {
      served.open(window, port);
    });
  }),
  {
    init: async (config) => {
      if (composed) throw new Error('corrallm’s core is up already.');
      composed = true;
      let core: Core;
      try {
        held = await lockProfile(config.profile, 'app');
        core = await createCore({ ...config, check }, appHost(link));
      } catch (error) {
        release();
        composed = false;
        if (!(error instanceof ProfileLocked)) throw error;
        return { profileLocked: { holder: error.holder ?? null } };
      }
      ready.resolve(core);
      windows.resolve(new WindowPorts(core, { check }));
      return null;
    },
    shown: async (asked) => (await ready.promise).shown(asked),
    flush: async () => {
      await (await ready.promise).flush();
      return null;
    },
    close: async () => {
      try {
        await (await ready.promise).close();
      } finally {
        release();
      }
      return null;
    },
    selftest: async ({ packaged }) => ({
      checks: await runChecks(selfTestChecks({ packaged })),
      memory: memoryText(),
    }),
  },
  { check },
);
link.on('windowGone', (window, closed) => {
  void windows.promise.then((served) => {
    served.gone(window, closed);
  });
});
link.on('windowFocused', (window) => {
  void ready.promise.then((core) => core.focused(window));
});
link.on('resumed', () => {
  void ready.promise.then((core) => {
    core.resumed();
  });
});
link.emit('ready', memoryText());
