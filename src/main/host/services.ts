import { BrowserWindow, dialog, shell, webContents } from 'electron';
import type { MessageBoxOptions } from 'electron';

import type { Handlers } from '../../shared/link';
import type { HostSide } from '../core/protocol';
import { folderDialog, openCanvasDialog, saveCanvasDialog } from './dialogs';

/** What main answers of the desktop, with dialogs parented to the window the core names. */
export function hostServices(): Handlers<HostSide> {
  return {
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
}
