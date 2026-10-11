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
  /** Asks for a canvas file to open (the Open dialog). Resolves with it, or null if cancelled. */
  'canvas:open': { args: []; result: CanvasFile | null };
  /**
   * Saves a canvas (its file's text) to the file it was opened from or last saved to, or, when it
   * has none or `choose` is true, to one picked in the Save dialog. Resolves with the file's name,
   * or null if cancelled.
   */
  'canvas:save': { args: [text: string, choose: boolean]; result: string | null };
  /** Forgets the canvas's file, for a new canvas: its next save asks where. Resolves with null. */
  'canvas:forget': { args: []; result: null };
}

/** A canvas file: its name (without folders) and its text (src/renderer/graph/file.ts). */
export interface CanvasFile {
  name: string;
  text: string;
}

/** The extension of canvas files. */
export const CANVAS_EXTENSION = 'corral';
/** The largest canvas file read or written, in bytes. */
export const MAX_CANVAS_BYTES = 10 * 1024 * 1024;

export type IpcChannel = keyof IpcContract;
export type IpcArgs<C extends IpcChannel> = IpcContract[C]['args'];
export type IpcResult<C extends IpcChannel> = IpcContract[C]['result'];

/** The API the preload script exposes to the renderer as `window.api`. */
export interface AppApi {
  ping(): Promise<IpcResult<'app:ping'>>;
  openCanvas(): Promise<IpcResult<'canvas:open'>>;
  saveCanvas(...args: IpcArgs<'canvas:save'>): Promise<IpcResult<'canvas:save'>>;
  forgetCanvas(): Promise<IpcResult<'canvas:forget'>>;
}

/** Which channel each `AppApi` method invokes. */
export const API_CHANNELS = {
  ping: 'app:ping',
  openCanvas: 'canvas:open',
  saveCanvas: 'canvas:save',
  forgetCanvas: 'canvas:forget',
} as const satisfies Record<keyof AppApi, IpcChannel>;

type AssertNever<T extends never> = T;
/** Fails to compile, naming the channel, if a contract channel has no `AppApi` method. */
export type UnexposedChannels = AssertNever<
  Exclude<IpcChannel, (typeof API_CHANNELS)[keyof typeof API_CHANNELS]>
>;
