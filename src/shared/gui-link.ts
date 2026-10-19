import type { z } from 'zod';

import type { OpResult } from './api/errors';
import type { OPS, ResultOf } from './api/registry';
import type { GuiOp } from './api/surface';

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

/** The name of a GUI operation's function on `window.api`: its name camel-cased (app.info → appInfo). */
export type GuiFunction<N extends string> = N extends `${infer Area}.${infer Verb}`
  ? `${Area}${Capitalize<Verb>}`
  : N;

/** The name of GUI operation `op`'s function on `window.api` (GuiFunction). */
export function guiFunction<N extends string>(op: N): GuiFunction<N> {
  return op.replace(/\.(.)/, (_dot, first: string) => first.toUpperCase()) as GuiFunction<N>;
}

/** What GUI operation `N` takes, as its caller writes it. */
type InputOf<N extends GuiOp> = z.input<(typeof OPS)[N]['input']>;

/** The arguments of `T` that may not be left out (an index signature's never are). */
type RequiredKeys<T> = {
  [K in keyof T]-?: string extends K ? never : Pick<T, K> extends Required<Pick<T, K>> ? K : never;
}[keyof T];

/**
 * A function per GUI operation (GUI_OPS), as the renderer's client calls them: each resolves with
 * its value, or rejects with an error carrying the operation's code and sentence.
 */
export type GuiApi = {
  [N in GuiOp as GuiFunction<N>]: [RequiredKeys<InputOf<N>>] extends [never]
    ? (args?: InputOf<N>) => Promise<ResultOf<N>>
    : (args: InputOf<N>) => Promise<ResultOf<N>>;
};

/** Plain operation results cross contextBridge; the renderer's client unwraps them there. */
export type GuiBridge = {
  [K in keyof GuiApi]: (
    ...args: Parameters<GuiApi[K]>
  ) => Promise<OpResult<Awaited<ReturnType<GuiApi[K]>>>>;
};
