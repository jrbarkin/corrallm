import { MessageChannel } from 'node:worker_threads';
import type { MessagePort } from 'node:worker_threads';

import type { CoreGuiSide, GuiSide } from '../../shared/gui-link';
import { CoreLink } from '../../shared/link';
import type { LinkPort } from '../../shared/link';
import type { WindowPorts, WindowPort } from './gui';
import type { WindowId } from './host';

/*
 * A window's port for the core's tests, over a MessageChannel pair: the core's end as core/gui.ts
 * holds it, the window's linked as the preload links it.
 */

/** A port's end as a link's port: gone once either end closes. */
function linkPortOf(port: MessagePort): LinkPort {
  return {
    post: (message) => {
      port.postMessage(message);
    },
    start: (receive, gone) => {
      port.on('message', receive);
      port.once('close', () => {
        gone('the port closed');
      });
    },
  };
}

/** The core's end of a window's port. */
export function coreEnd(port: MessagePort): WindowPort {
  return {
    ...linkPortOf(port),
    close: () => {
      port.close();
    },
  };
}

/**
 * Serves a new port as `window`'s: the window's end of it, and a function that closes it. Its
 * drafts flush at once, unless `flush` says how.
 */
export function openWindow(
  served: WindowPorts,
  window: WindowId,
  flush: () => Promise<null> | null = () => null,
): { link: CoreLink<GuiSide, CoreGuiSide>; close: () => void } {
  const { port1, port2 } = new MessageChannel();
  served.open(window, coreEnd(port1));
  return {
    link: new CoreLink<GuiSide, CoreGuiSide>(linkPortOf(port2), { 'drafts.flush': flush }),
    close: () => {
      port2.close();
    },
  };
}
