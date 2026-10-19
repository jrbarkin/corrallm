import { OPS } from '../../shared/api/registry';
import { SURFACE } from '../../shared/api/surface';
import { CoreLink } from '../../shared/link';
import type { LinkPort } from '../../shared/link';
import { createDispatcher } from './call';
import { WindowPorts } from './gui';
import type { WindowPort } from './gui';
import type { WindowId } from './host';
import { appOps } from './ops/app';
import { isWindowMessage } from './protocol';
import type { CoreSide, HostSide } from './protocol';
import { memoryText, runChecks, selfTestChecks } from './selftest';

/*
 * The core process's entry (.vite/build/core.cjs): main forks it with utilityProcess.fork
 * (host/core-process.ts) and talks to it over CoreLink on its parentPort. For the app, main asks it
 * `init`, then hands it each trusted window's port beside the link (B8 Design §3), which it serves
 * once composed (core/gui.ts). In the native self-test (CORRALLM_NATIVE_SELFTEST=1,
 * native-selftest.ts) main only asks it to run the checks, and it is never composed.
 *
 * Until main's services move into this process, main keeps the profile's stores (the journal,
 * memory, settings, usage, tokens) and runs the agents' sessions, so the core composes none of
 * them: only the operations that read no store, app.info. Any other a window may call answers that
 * there is no such operation until then.
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

const link = new CoreLink<CoreSide, HostSide>(
  parentPortOf(parent, (window, port) => {
    void windows.promise.then((served) => {
      served.open(window, port);
    });
  }),
  {
    init: ({ app }) => {
      if (composed) throw new Error('corrallm’s core is up already.');
      composed = true;
      const core = createDispatcher(
        { surface: SURFACE, ops: OPS, implementations: appOps({ app }), rules: {} },
        { check },
      );
      windows.resolve(new WindowPorts(core, { check }));
      return null;
    },
    selftest: async ({ packaged }) => ({
      checks: await runChecks(selfTestChecks({ packaged })),
      memory: memoryText(),
    }),
  },
  { check },
);
link.on('windowGone', (window) => {
  void windows.promise.then((served) => {
    served.gone(window);
  });
});
link.emit('ready', memoryText());
