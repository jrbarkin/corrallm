import { ipcMain } from 'electron';

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
