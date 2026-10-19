import type { z } from 'zod';

import type { OpResult } from './api/errors';
import type { OPS, ResultOf } from './api/registry';
import type { GuiOp } from './api/surface';
import type { CoreEvent, IpcEventArgs } from './ipc';
import type { TerminalEvent } from './terminal';
import type { Change, TopicRequest, TopicSnapshot } from './api/topics';

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

/** Events on the window's port: the remaining channels, and its terminal stream. */
export type GuiEvent = CoreEvent | 'terminal';
export type GuiEventArgs<E extends GuiEvent> = E extends 'terminal'
  ? [agentId: string, event: TerminalEvent]
  : E extends CoreEvent
    ? IpcEventArgs<E>
    : never;

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
     * arguments, parsed and handled by the core for this window’s canvas.
     */
    channel: { args: [name: string, args: unknown[]]; result: unknown };
  };
  events: {
    /** The core's topic epoch, announced on each new port before topic changes. */
    epoch: [epoch: string];
    /** Changes in order, batched per window every 16 ms. */
    topic: [changes: Change[]];
    /** The terminal stream and remaining hand-written events, with no Electron event objects. */
    event: [name: GuiEvent, args: GuiEventArgs<GuiEvent>];
  };
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

/** What GUI operation `N` takes; the drop's paths come from files in the preload. */
type InputOf<N extends GuiOp> = N extends 'terminal.drop'
  ? Omit<z.input<(typeof OPS)[N]['input']>, 'paths'> & { files: readonly File[] }
  : N extends 'topics.subscribe' | 'topics.unsubscribe'
    ? TopicRequest
    : z.input<(typeof OPS)[N]['input']>;

/** The arguments of `T` that may not be left out (an index signature's never are). */
type RequiredKeys<T> = {
  [K in keyof T]-?: string extends K ? never : Pick<T, K> extends Required<Pick<T, K>> ? K : never;
}[keyof T];

/**
 * A function per GUI operation (GUI_OPS), as the renderer's client calls them: each resolves with
 * its value, or rejects with an error carrying the operation's code and sentence.
 */
type GuiCalls = {
  [N in GuiOp as GuiFunction<N>]: [RequiredKeys<InputOf<N>>] extends [never]
    ? (args?: InputOf<N>) => Promise<GuiResult<N>>
    : (args: InputOf<N>) => Promise<GuiResult<N>>;
};

type GuiResult<N extends GuiOp> = N extends 'topics.subscribe' ? TopicSnapshot : ResultOf<N>;

/** A view's event listener, over the same port as its operations. */
export interface GuiEventApi {
  topicsOnChange(listener: (changes: Change[]) => void): () => void;
  topicsOnEpoch(listener: (epoch: string) => void): () => void;
  terminalOnEvent(listener: (...args: GuiEventArgs<'terminal'>) => void): () => void;
}

export type GuiApi = GuiCalls & GuiEventApi;

/** Plain operation results cross contextBridge; the renderer's client unwraps them there. */
export type GuiBridge = {
  [K in keyof GuiCalls]: (
    ...args: Parameters<GuiCalls[K]>
  ) => Promise<OpResult<Awaited<ReturnType<GuiCalls[K]>>>>;
} & GuiEventApi;
