import { GUI_OPS } from '../../shared/api/surface';
import type { GuiOp } from '../../shared/api/surface';
import type { CoreGuiSide, GuiSide } from '../../shared/gui-link';
import { CoreLink } from '../../shared/link';
import type { LinkOptions, LinkPort } from '../../shared/link';
import type { Dispatcher } from './call';
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
}

/** Every window's port the core serves, by window. */
export class WindowPorts {
  readonly #core: Pick<Dispatcher, 'call'>;
  readonly #options: LinkOptions;
  readonly #windows = new Map<WindowId, Served>();

  constructor(core: Pick<Dispatcher, 'call'>, options: LinkOptions = {}) {
    this.#core = core;
    this.#options = options;
  }

  /** Serves `port` as `window`'s, in place of the one it had (its page reloaded). */
  open(window: WindowId, port: WindowPort): void {
    this.gone(window);
    const caller = asHuman(window);
    const served: Served = { port, calls: new AbortController() };
    this.#windows.set(window, served);
    new CoreLink<CoreGuiSide, GuiSide>(
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
        channel: (name) => {
          throw new Error(`corrallm’s core doesn’t serve ${name} yet: it goes to main.`);
        },
      },
      this.#options,
    );
  }

  /** The window closed, crashed or reloaded: its port closes, and its calls going are cancelled. */
  gone(window: WindowId): void {
    const served = this.#windows.get(window);
    if (!served) return;
    this.#forget(window, served);
    served.port.close();
    served.end?.('the window went');
  }

  #forget(window: WindowId, served: Served): void {
    if (this.#windows.get(window) === served) this.#windows.delete(window);
    served.calls.abort();
  }
}

/** Whether a window may call `op` (what it sent may be anything). */
function isGuiOp(op: unknown): op is GuiOp {
  return typeof op === 'string' && (GUI_OPS as readonly string[]).includes(op);
}
