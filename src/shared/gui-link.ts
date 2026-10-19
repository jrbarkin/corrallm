import type { OpResult } from './api/errors';

/*
 * A window's link to the core (B8 Design §3, §4): CoreLink over the MessagePort main hands each
 * trusted window. The preload asks main for it as it loads ('core:connect', through main's sender
 * check), main posts it back as 'core:port', and the preload keeps it, never the page. The core's
 * side (src/main/core/gui.ts) makes every call on it yours, at that window.
 */

/** What main posts the window its port with, the port in the message's transfer list. */
export const CORE_PORT = 'core:port';

/** What comes with a window's port: which core it reaches, a new one each time the core starts. */
export interface CorePort {
  epoch: number;
}

/** What the core answers a window, over its port. */
export interface CoreGuiSide {
  requests: {
    /**
     * Calls a GUI operation (GUI_OPS, src/shared/api/surface.ts) as you: its result, or why it
     * failed. Any other is refused before it is dispatched.
     */
    call: { args: [op: string, args: unknown]; result: OpResult<unknown> };
    /**
     * A hand-written channel (src/shared/ipc.ts) the registry doesn't replace yet, by its name and
     * arguments. Not served yet: those channels still go to main.
     */
    channel: { args: [name: string, args: unknown[]]; result: unknown };
  };
  events: Record<string, never>;
}

/** What a window answers and tells the core: nothing yet. */
export interface GuiSide {
  requests: Record<string, never>;
  events: Record<string, never>;
}
