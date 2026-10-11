import { app, ipcMain } from 'electron';
import type { WebContents } from 'electron';

import { MAX_CANVAS_BYTES } from '../shared/ipc';
import type { IpcArgs, IpcChannel, IpcResult } from '../shared/ipc';
import { forgetCanvas, openCanvas, saveCanvas } from './canvas';
import { isTrustedSender } from './security';

/** Turns the raw, untrusted arguments into the channel's contract tuple, or throws. */
export type ArgsParser<C extends IpcChannel> = (args: unknown[]) => IpcArgs<C>;
/** Who sent a message: the renderer's web contents (whose window a dialog belongs to). */
export interface IpcCaller {
  contents: WebContents;
}
export type IpcHandler<C extends IpcChannel> = (
  caller: IpcCaller,
  ...args: IpcArgs<C>
) => IpcResult<C> | Promise<IpcResult<C>>;

/**
 * Returns a typed `handle()` bound to the renderer's origin. Before any handler runs, every
 * message is checked:
 * 1. the sender must be the top-level frame of our own renderer (`trustedOrigin`);
 * 2. the arguments must pass the channel's `parseArgs`.
 * Errors thrown here reach the renderer as a rejected promise (message only).
 */
export function createIpcHandle(trustedOrigin: string) {
  return function handle<C extends IpcChannel>(
    channel: C,
    parseArgs: ArgsParser<C>,
    handler: IpcHandler<C>,
  ): void {
    ipcMain.handle(channel, (event, ...rawArgs: unknown[]) => {
      if (!isTrustedSender(event.senderFrame, trustedOrigin)) {
        throw new Error(`Rejected ${channel}: untrusted sender`);
      }
      return handler({ contents: event.sender }, ...parseArgs(rawArgs));
    });
  };
}

/** `ArgsParser` for channels that take no arguments. */
export function noArgs(args: unknown[]): [] {
  if (args.length !== 0) throw new TypeError('Expected no arguments');
  return [];
}

export function getVersionString(): string {
  const { electron, chrome, node } = process.versions;
  return `${app.getName()} ${app.getVersion()} (Electron ${electron}, Chromium ${chrome}, Node ${node})`;
}

/**
 * One entry per channel in the contract. The mapped type makes a missing channel a compile
 * error, and ties each channel's parser and handler to its contract types.
 */
type HandlerTable = {
  [C in IpcChannel]: { parseArgs: ArgsParser<C>; handler: IpcHandler<C> };
};

/** `ArgsParser` for canvas:save: the canvas's text (within the size limit), and `choose`. */
export function parseSaveArgs(args: unknown[]): IpcArgs<'canvas:save'> {
  const [text, choose] = args;
  if (args.length !== 2 || typeof text !== 'string' || typeof choose !== 'boolean') {
    throw new TypeError('Expected the canvas text and whether to choose a file');
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_CANVAS_BYTES) {
    throw new RangeError('The canvas is too large to save');
  }
  return [text, choose];
}

const handlers: HandlerTable = {
  'app:ping': { parseArgs: noArgs, handler: getVersionString },
  'canvas:open': { parseArgs: noArgs, handler: ({ contents }) => openCanvas(contents) },
  'canvas:save': {
    parseArgs: parseSaveArgs,
    handler: ({ contents }, text, choose) => saveCanvas(contents, text, choose),
  },
  'canvas:forget': {
    parseArgs: noArgs,
    handler: ({ contents }) => {
      forgetCanvas(contents);
      return null;
    },
  },
};

// Generic so each channel's parser and handler types stay linked while iterating the table.
function register<C extends IpcChannel>(
  handle: ReturnType<typeof createIpcHandle>,
  channel: C,
  { parseArgs, handler }: HandlerTable[C],
): void {
  handle(channel, parseArgs, handler);
}

/** Registers every channel in the IPC contract. Call once, after the app is ready. */
export function registerIpcHandlers(trustedOrigin: string): void {
  const handle = createIpcHandle(trustedOrigin);
  for (const channel of Object.keys(handlers) as IpcChannel[]) {
    register(handle, channel, handlers[channel]);
  }
}
