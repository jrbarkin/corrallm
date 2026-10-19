import { ipcMain } from 'electron';
import type { WebContents } from 'electron';

import type { IpcEventArgs } from '../shared/ipc';
import type { CorePorts } from './host/ports';
import { isTrustedSender } from './security';

/** Only a trusted top-level renderer can ask main for its window's port to the core. */
export function registerIpcHandlers(trustedOrigin: string, core: Pick<CorePorts, 'connect'>): void {
  ipcMain.handle('core:connect', (event, ...args: unknown[]) => {
    if (!isTrustedSender(event.senderFrame, trustedOrigin)) {
      throw new Error('Rejected core:connect: untrusted sender');
    }
    if (args.length !== 0) throw new TypeError('Expected no arguments');
    core.connect(event.sender);
    return null;
  });
}

/** Main still asks the renderer to freeze and save before closing its window. */
export function sendEvent(
  contents: WebContents,
  event: 'run:stopping',
  ...args: IpcEventArgs<'run:stopping'>
): void {
  if (!contents.isDestroyed()) contents.send(event, ...args);
}
