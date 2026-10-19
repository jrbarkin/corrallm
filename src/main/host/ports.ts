import { MessageChannelMain } from 'electron';
import type { WebContents } from 'electron';

import { CORE_PORT } from '../../shared/gui-link';
import type { CorePort } from '../../shared/gui-link';
import type { CoreProcess } from './core-process';
import { originKey } from '../url-policy';

/*
 * Windows' ports to the core (B8 Design §3), main's half of the handshake. A window's preload asks
 * for its port as it loads (core:connect, which ipc.ts's handle() admits only from the top-level
 * frame of the app's own origin); main makes a channel, hands the core one end, tagged with the
 * window, and posts the window the other, which the preload keeps from the page. The core makes
 * every call on it yours, at that window (core/gui.ts). Main tells the core when the window is
 * gone: closed, crashed or reloaded.
 */

export class CorePorts {
  readonly #core: Pick<CoreProcess, 'connect' | 'windowGone'>;
  readonly #origin: string;
  /**
   * Which core a port reaches. There is one until supervision restarts a core that stops, each
   * restart a new epoch (B8 Design §6).
   */
  readonly #epoch = 1;
  /** The windows followed, whose going the core hears. */
  readonly #followed = new WeakSet<WebContents>();

  constructor(core: Pick<CoreProcess, 'connect' | 'windowGone'>, origin: string) {
    this.#core = core;
    this.#origin = origin;
  }

  /** Gives the window a port to the core: a new one each time it asks, as after a reload. */
  connect(contents: WebContents): void {
    this.#follow(contents);
    const { port1, port2 } = new MessageChannelMain();
    this.#core.connect(contents.id, port1);
    contents.postMessage(CORE_PORT, { epoch: this.#epoch } satisfies CorePort, [port2]);
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
      gone(true);
    });
  }
}
