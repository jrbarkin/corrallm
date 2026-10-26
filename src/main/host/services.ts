import { BrowserWindow, dialog, shell, webContents } from 'electron';
import type { MessageBoxOptions } from 'electron';

import type { Handlers } from '../../shared/link';
import { NotificationRequest, NotificationResult, Presence } from '../core/presence';
import type { HostServices } from '../core/host';
import type { CoreProcess } from './core-process';
import type { HostSide } from '../core/protocol';
import { folderDialog, openCanvasDialog, saveCanvasDialog } from './dialogs';

/** What main answers of the desktop, with dialogs parented to the window the core names. */
export function hostServices(
  core: CoreProcess,
  current: (core: CoreProcess) => boolean,
  presentation: Pick<HostServices, 'presence' | 'notify' | 'unnotify'> = {
    presence: () => undefined,
    notify: () => Promise.resolve('unsupported'),
    unnotify: () => undefined,
  },
): Handlers<HostSide> {
  core.link.on('presence', (snapshot) => {
    if (!current(core)) return;
    const parsed = Presence.safeParse(snapshot);
    if (parsed.success) presentation.presence(parsed.data);
  });
  core.link.on('unnotify', (handle) => {
    if (current(core) && typeof handle === 'string' && handle.length <= 36)
      presentation.unnotify(handle);
  });
  const handlers: Handlers<HostSide> = {
    notify: async (notification) =>
      NotificationResult.parse(await presentation.notify(NotificationRequest.parse(notification))),
    pickCanvasToOpen: openCanvasDialog,
    pickCanvasToSave: saveCanvasDialog,
    pickFolder: folderDialog,
    askOpenLink: async (window, host, url) => {
      const options: MessageBoxOptions = {
        type: 'question',
        message: `Open ${host} in your browser?`,
        detail: url.length > 300 ? `${url.slice(0, 300)}…` : url,
        buttons: ['Open', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        checkboxLabel: 'Always for this site',
        noLink: true,
      };
      const contents = webContents.fromId(window);
      const owner = contents ? BrowserWindow.fromWebContents(contents) : null;
      const { response, checkboxChecked } = await (owner
        ? dialog.showMessageBox(owner, options)
        : dialog.showMessageBox(options));
      return { open: response === 0, always: response === 0 && checkboxChecked };
    },
    openExternal: async (url) => {
      await shell.openExternal(url);
      return null;
    },
    showFile: (file) => {
      shell.showItemInFolder(file);
      return null;
    },
  };
  // The identity is the process bound here, never an epoch supplied by its message.
  const requireCurrent = () => {
    if (!current(core)) throw new Error('This core has been replaced.');
  };
  return Object.fromEntries(
    Object.entries(handlers).map(([name, handler]) => [
      name,
      async (...args: unknown[]) => {
        requireCurrent();
        const value: unknown = await (handler as (...args: unknown[]) => unknown)(...args);
        requireCurrent();
        return value;
      },
    ]),
  ) as Handlers<HostSide>;
}
