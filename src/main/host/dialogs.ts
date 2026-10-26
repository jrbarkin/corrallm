import path from 'node:path';
import { lstat } from 'node:fs/promises';

import { BrowserWindow, dialog, webContents } from 'electron';
import type {
  MessageBoxOptions,
  OpenDialogOptions,
  OpenDialogReturnValue,
  SaveDialogOptions,
} from 'electron';

import { CANVAS_EXTENSION } from '../../shared/canvas';
import type { WindowId } from '../core/host';
import type { HostSide } from '../core/protocol';
import type { Handlers } from '../../shared/link';

/*
 * The app's dialogs, each parented to the window it is for: what the user picks in them is a
 * TrustedPath, which the core opens, saves to or runs agents in (the folder dialog is the trust
 * gate). The core brands their answers as TrustedPaths (core/host/app.ts).
 */

const FILTERS = [{ name: 'corrallm canvas', extensions: [CANVAS_EXTENSION] }];

/** The window whose web contents' id is `window`, if it is still there. */
function parent(window: WindowId): BrowserWindow | null {
  const contents = webContents.fromId(window);
  return contents ? BrowserWindow.fromWebContents(contents) : null;
}

function showOpen(window: WindowId, options: OpenDialogOptions): Promise<OpenDialogReturnValue> {
  const owner = parent(window);
  return owner ? dialog.showOpenDialog(owner, options) : dialog.showOpenDialog(options);
}

/** The Open dialog for a canvas file (HostServices.pickCanvasToOpen). */
export const openCanvasDialog: Handlers<HostSide>['pickCanvasToOpen'] = async (window) => {
  const { canceled, filePaths } = await showOpen(window, {
    properties: ['openFile'],
    filters: FILTERS,
  });
  const [file] = filePaths;
  return canceled || file === undefined ? null : file;
};

/** The Save dialog for a canvas file, adding its extension (HostServices.pickCanvasToSave). */
export const saveCanvasDialog: Handlers<HostSide>['pickCanvasToSave'] = async (
  window,
  defaultPath,
): Promise<string | null> => {
  const options: SaveDialogOptions = {
    filters: FILTERS,
    defaultPath,
    properties: ['showOverwriteConfirmation'],
  };
  const owner = parent(window);
  const { canceled, filePath } = owner
    ? await dialog.showSaveDialog(owner, options)
    : await dialog.showSaveDialog(options);
  if (canceled || !filePath) return null;
  if (path.extname(filePath) === `.${CANVAS_EXTENSION}`) return filePath;
  const extended = `${filePath}.${CANVAS_EXTENSION}`;
  try {
    // The native dialog confirmed filePath, not the name after adding our extension. lstat also
    // catches a dangling symlink, which saving here would replace just like an existing file.
    await lstat(extended);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return extended;
    throw error;
  }
  const confirmation: MessageBoxOptions = {
    type: 'warning',
    message: `“${path.basename(extended)}” already exists. Replace it?`,
    detail: 'Saving here will replace the existing file.',
    buttons: ['Replace', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
  const { response } = owner
    ? await dialog.showMessageBox(owner, confirmation)
    : await dialog.showMessageBox(confirmation);
  return response === 0 ? extended : null;
};

/** The folder dialog for a canvas's project folder (HostServices.pickFolder). */
export const folderDialog: Handlers<HostSide>['pickFolder'] = async (window, current) => {
  const { canceled, filePaths } = await showOpen(window, {
    title: 'Project folder',
    message: 'Choose the folder this canvas’s agents work in',
    buttonLabel: 'Choose',
    properties: ['openDirectory', 'createDirectory'],
    ...(current === undefined ? {} : { defaultPath: current }),
  });
  const [folder] = filePaths;
  return canceled || folder === undefined ? null : folder;
};
