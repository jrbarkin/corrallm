/**
 * The IPC contract between the main process and the renderer.
 *
 * Every channel is declared here once, mapping its name to the argument tuple the renderer
 * sends and the value main resolves with. Main registers handlers with `handle()`
 * (src/main/ipc.ts), the preload exposes them on `window.api` via `invoke()`
 * (src/preload/index.ts), and the renderer calls `window.api`. All three are type-checked
 * against this file.
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
