import { CoreLink } from '../../shared/link';
import type { LinkPort } from '../../shared/link';
import { createCore } from './core';
import type { Core } from './core';
import { Endpoint } from './endpoint';
import { appHost } from './host/app';
import { WindowPorts } from './gui';
import type { WindowPort } from './gui';
import type { WindowId } from './host';
import { lockProfile, ProfileLocked } from './lock';
import type { ProfileLock } from './lock';
import { isWindowMessage } from './protocol';
import type { CoreSide, HostSide } from './protocol';
import { memoryText, runChecks, selfTestChecks } from './selftest';
import { serveTokenSocket } from './token-socket';
import type { TokenSocket } from './token-socket';

/*
 * The core process's entry (.vite/build/core.cjs): main forks it with utilityProcess.fork
 * (host/core-process.ts) and talks to it over CoreLink on its parentPort. For the app, main asks it
 * `init`: it takes the profile (core.lock, one owner per profile: lock.ts) before it composes the
 * core on it, and holds it until the core closes or the process ends; while `corrallm serve` holds
 * it, init says who does and composes nothing. Main hands it each trusted window's port beside the
 * link (B8 Design §3), which it serves once composed (core/gui.ts).
 *
 * Once composed it always serves the profile's outside endpoint (B11 Design §9, §16.6: endpoint.ts),
 * here, beside the dispatcher, never in main or a window: MCP on 127.0.0.1 on the port the profile
 * keeps (chosen free once), with every check `corrallm serve` makes; with no outside token made,
 * nothing authenticates. One that can't listen (the port taken) is a status (`settings.get`, and
 * what `corrallm token` says), never a dialog, and the app runs on without it. It also serves the
 * profile's token socket (token-socket.ts), so `corrallm token new|renew|revoke` makes tokens while
 * the app runs, until the core closes, each naming the endpoint's URL; a socket it can't serve is
 * said, and the app runs on without it. Then it publishes api.json, naming this process. Main asks
 * it to prepare, cancel and commit the shutdown barrier (core.ts) as it quits or restarts to
 * update; committing closes the token socket and the endpoint (requests going on ended, api.json
 * removed) before the core closes. In the native self-test (CORRALLM_NATIVE_SELFTEST=1,
 * native-selftest.ts) main only asks it to run the checks, and it is never composed.
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
/** The profile's token socket, served while the core is up. */
let tokenSocket: TokenSocket | undefined;
/** The profile's outside endpoint, served while the core is up. */
let endpoint: Endpoint | undefined;
const release = () => {
  // Only the api.json it wrote: a newer core's (after this one) stays.
  endpoint?.removeSync();
  tokenSocket?.removeSync();
  tokenSocket = undefined;
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
      // Every canvas open runs in the core from now on, restored paused, whether or not a window
      // shows it (B11 Design §2, §8): `active` and the shutdown barrier cover the app's runs. In the
      // background: a window's canvas is run as it asks for it, sharing the same allocation.
      void core.engines.initialize().then(
        (initialized) => {
          for (const one of initialized)
            if ('error' in one) console.error(`corrallm: ${one.canvas} can’t run: ${one.error}`);
        },
        (error: unknown) => {
          console.error(`corrallm: its canvases couldn’t be opened: ${reasonOf(error)}`);
        },
      );
      // Its outside endpoint, always (B11 Design §16.6): one that can't listen is said, quietly.
      const outside = new Endpoint({
        profile: config.profile,
        core,
        clientOf: (token) => core.clientOf(token),
        stale: (token) => core.tokens.stale(token),
        settings: core.settings,
        changed: (status) => {
          core.served(status);
        },
      });
      endpoint = outside;
      const status = await outside
        .listen()
        .catch((error: unknown) =>
          outside.refused(`corrallm’s MCP server couldn’t start: ${reasonOf(error)}`),
        );
      if (status.state === 'unavailable') console.error(`corrallm: ${status.sentence}`);
      try {
        tokenSocket = await serveTokenSocket({
          profile: config.profile,
          answer: (request) =>
            core.tokenRequest(request, {
              owner: 'app',
              url: outside.url ?? null,
              ...(outside.status.state === 'unavailable'
                ? { unserved: outside.status.sentence }
                : {}),
            }),
        });
      } catch (error) {
        console.error(`corrallm token can’t reach the app: ${reasonOf(error)}`);
      }
      // Found from now on by `corrallm wait`: api.json, naming this process.
      if (status.state === 'listening') {
        await outside.publish().catch((error: unknown) => {
          console.error(`corrallm: could not write api.json: ${reasonOf(error)}`);
        });
      }
      return null;
    },
    openLink: async (window, url) => {
      await (await windows.promise).openLink(window, url);
      return null;
    },
    flushDrafts: async (asked) => ({
      unanswered: await (await windows.promise).flushDrafts(asked),
    }),
    prepareShutdown: async (reason) => (await ready.promise).prepareShutdown(reason),
    cancelShutdown: async () => {
      (await ready.promise).cancelShutdown();
      return null;
    },
    commitShutdown: async () => {
      try {
        // No token is made as the core closes, and no request is answered: those going on end,
        // a long wait included, and api.json goes, before any session does.
        await tokenSocket?.close();
        await endpoint?.close();
        await (await ready.promise).commitShutdown();
      } finally {
        release();
      }
      return null;
    },
    active: async () => (await ready.promise).active(),
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

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
