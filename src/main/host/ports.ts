import { MessageChannelMain } from 'electron';
import type { WebContents } from 'electron';

import { CORE_PORT } from '../../shared/gui-link';
import type { CorePort } from '../../shared/gui-link';
import { originKey } from '../url-policy';
import type { CoreSupervisor } from './supervisor';

/*
 * Windows' ports to the core (B8 Design §3), main's half of the handshake. A window's preload asks
 * for its port as it loads (core:connect, which ipc.ts's handle() admits only from the top-level
 * frame of the app's own origin); main makes a channel, hands the core one end, tagged with the
 * window, and posts the window the other, which the preload keeps from the page. The core makes
 * every call on it yours, at that window (core/gui.ts). Main tells the core when the window is
 * gone: closed, crashed or reloaded. Each port names the epoch of the core it reaches.
 *
 * When a core crashes, the supervisor brings up a new one (host/supervisor.ts) and every window
 * is reloaded: until the canvas and its run live in the core (B9, B11), a window's page holds
 * them, so its page restores its canvas from the new core's journal, paused, as after any reload,
 * and asks for a port to the new core as it loads.
 */

/** The core windows' ports reach: the one up now (supervised), as its epoch. */
export type CoreEnd = Pick<CoreSupervisor, 'connect' | 'windowGone' | 'epoch'>;

export class CorePorts {
  readonly #core: CoreEnd;
  readonly #origin: string;
  /** The windows followed, whose going the core hears, until they are destroyed. */
  readonly #followed = new Set<WebContents>();

  constructor(core: CoreEnd, origin: string) {
    this.#core = core;
    this.#origin = origin;
  }

  /** Gives the window a port to the core: a new one each time it asks, as after a reload. */
  connect(contents: WebContents): void {
    this.#follow(contents);
    const { port1, port2 } = new MessageChannelMain();
    // Read first: a port made while a new core comes up reaches the new one.
    const epoch = this.#core.epoch;
    this.#core.connect(contents.id, port1);
    contents.postMessage(CORE_PORT, { epoch } satisfies CorePort, [port2]);
  }

  /** A new core is up after one crashed: every window reloads, and so reconnects to it. */
  reconnect(): void {
    for (const contents of this.#followed) {
      if (!contents.isDestroyed()) contents.reload();
    }
  }

  #follow(contents: WebContents): void {
    if (this.#followed.has(contents)) return;
    this.#followed.add(contents);
    // Read now: a destroyed window's contents has no id to read.
    const window = contents.id;
    const gone = (closed = false) => {
      this.#core.windowGone(window, closed);
    };
    contents.on('did-start-navigation', (event) => {
      // This precedes will-navigate: a foreign navigation will be blocked, keeping this page
      // and its port alive. Only a reload of our own renderer leaves its sessions.
      if (event.isMainFrame && !event.isSameDocument && originKey(event.url) === this.#origin)
        gone();
    });
    contents.on('render-process-gone', () => {
      gone();
    });
    contents.once('destroyed', () => {
      this.#followed.delete(contents);
      gone(true);
    });
  }
}
