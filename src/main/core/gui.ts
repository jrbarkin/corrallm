import { GUI_OPS } from '../../shared/api/surface';
import type { GuiOp } from '../../shared/api/surface';
import type { CoreGuiSide, GuiSide } from '../../shared/gui-link';
import { CoreLink } from '../../shared/link';
import type { LinkOptions, LinkPort } from '../../shared/link';
import type { Dispatcher } from './call';
import type { Channels } from './channels';
import type { HumanCaller } from './caller';
import type { WindowId } from './host';

/*
 * Windows' ports, the core's side (B8 Design §4, Core Server §6.1): the one place a human caller is
 * made. Main hands the core a window's port only after its sender check (core:connect, through
 * ipc.ts's handle(): the top-level frame of the app's own origin), over the core process's
 * parentPort, which only main posts to; and only the core process's entry loads this file, so
 * under plain Node no human caller can exist. Every call on a window's port is yours, at that
 * window, through core.call like any transport's; an operation a window may not call (GUI_OPS) is
 * refused before it is dispatched.
 */

/** You, at `window` (or main's own native UI: 'host'): only ever for a port main made. */
export function asHuman(window: WindowId | 'host'): HumanCaller {
  return { kind: 'human', window } as HumanCaller;
}

/** The core's end of a window's port: a link's port that it can close. */
export interface WindowPort extends LinkPort {
  close(): void;
}

interface Served {
  readonly port: WindowPort;
  /** Aborts the window's calls still going. */
  readonly calls: AbortController;
  /** Ends the window's link, once it has started: what it still answers goes nowhere. */
  end?: (why: string) => void;
  stop?: (() => void) | undefined;
}

/** A dispatcher, and the app’s hand-written channels when it hosts windows. */
type GuiCore = Pick<Dispatcher, 'call'> & { channels?: Pick<Channels, 'call' | 'listen' | 'gone'> };

/** Every window's port the core serves, by window. */
export class WindowPorts {
  readonly #core: GuiCore;
  readonly #options: LinkOptions;
  readonly #windows = new Map<WindowId, Served>();

  constructor(core: GuiCore, options: LinkOptions = {}) {
    this.#core = core;
    this.#options = options;
  }

  /** Serves `port` as `window`'s, in place of the one it had (its page reloaded). */
  open(window: WindowId, port: WindowPort): void {
    this.gone(window);
    const caller = asHuman(window);
    const served: Served = { port, calls: new AbortController() };
    this.#windows.set(window, served);
    const link = new CoreLink<CoreGuiSide, GuiSide>(
      {
        post: (message) => {
          port.post(message);
        },
        start: (receive, gone) => {
          served.end = gone;
          port.start(receive, (why) => {
            this.#forget(window, served);
            gone(why);
          });
        },
      },
      {
        call: (op, args) =>
          isGuiOp(op)
            ? this.#core.call(op, args, caller, served.calls.signal)
            : {
                ok: false,
                error: {
                  code: 'not-found',
                  sentence: `corrallm’s window has no operation named ${op}.`,
                },
              },
        channel: (name, args) => {
          if (!this.#core.channels)
            throw new Error(`corrallm’s window has no channel named ${name}.`);
          return this.#core.channels.call(window, name, args);
        },
      },
      this.#options,
    );
    served.stop = this.#core.channels?.listen(window, (name, args) => {
      link.emit('event', name, args);
    });
  }

  /** The window closed, crashed or reloaded: its port closes, and its calls going are cancelled. */
  gone(window: WindowId, closed = false): void {
    const served = this.#windows.get(window);
    if (!served) {
      if (closed) this.#core.channels?.gone(window, true);
      return;
    }
    this.#forget(window, served, closed);
    served.port.close();
    served.end?.('the window went');
  }

  #forget(window: WindowId, served: Served, closed = false): void {
    if (this.#windows.get(window) !== served) return;
    this.#windows.delete(window);
    served.calls.abort();
    served.stop?.();
    this.#core.channels?.gone(window, closed);
  }
}

/** Whether a window may call `op` (what it sent may be anything). */
function isGuiOp(op: unknown): op is GuiOp {
  return typeof op === 'string' && (GUI_OPS as readonly string[]).includes(op);
}
