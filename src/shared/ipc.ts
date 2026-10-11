/**
 * The IPC contract between the main process and the renderer.
 *
 * Every channel is declared here once, mapping its name to the argument tuple the renderer
 * sends and the value main resolves with. Main registers a handler for every channel
 * (src/main/ipc.ts), the preload exposes each one on `window.api` (src/preload/index.ts), and
 * the renderer calls `window.api`. The compiler checks both that the three agree on types and
 * that no channel is missing a handler or an `AppApi` method.
 *
 * Keep this module free of Node, Electron and DOM imports: it is compiled into every process.
 */
export interface IpcContract {
  /** Round-trip check. Resolves with a human-readable version string. */
  'app:ping': { args: []; result: string };
}

export type IpcChannel = keyof IpcContract;
export type IpcArgs<C extends IpcChannel> = IpcContract[C]['args'];
export type IpcResult<C extends IpcChannel> = IpcContract[C]['result'];

/** The API the preload script exposes to the renderer as `window.api`. */
export interface AppApi {
  ping(): Promise<IpcResult<'app:ping'>>;
}

/** Which channel each `AppApi` method invokes. */
export const API_CHANNELS = {
  ping: 'app:ping',
} as const satisfies Record<keyof AppApi, IpcChannel>;

type AssertNever<T extends never> = T;
/** Fails to compile, naming the channel, if a contract channel has no `AppApi` method. */
export type UnexposedChannels = AssertNever<
  Exclude<IpcChannel, (typeof API_CHANNELS)[keyof typeof API_CHANNELS]>
>;
