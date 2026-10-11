import { app, ipcMain } from 'electron';

import type { IpcArgs, IpcChannel, IpcResult } from '../shared/ipc';
import { isTrustedSender } from './security';

/** Turns the raw, untrusted arguments into the channel's contract tuple, or throws. */
export type ArgsParser<C extends IpcChannel> = (args: unknown[]) => IpcArgs<C>;
export type IpcHandler<C extends IpcChannel> = (
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
      return handler(...parseArgs(rawArgs));
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

/** Registers every channel in the IPC contract. Call once, after the app is ready. */
export function registerIpcHandlers(trustedOrigin: string): void {
  const handle = createIpcHandle(trustedOrigin);
  handle('app:ping', noArgs, getVersionString);
}
