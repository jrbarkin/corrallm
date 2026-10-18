import type { HostServices } from '../core/host';
import { folderDialog, openCanvasDialog, saveCanvasDialog } from './dialogs';

/**
 * What main gives the core of the desktop (core/host.ts), in main's process: its dialogs. Once the
 * core runs in its own process, main answers the same requests over its parent port.
 */
export const hostServices: HostServices = {
  pickCanvasToOpen: openCanvasDialog,
  pickCanvasToSave: saveCanvasDialog,
  pickFolder: folderDialog,
};
