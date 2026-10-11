import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { BrowserWindow, dialog } from 'electron';
import type { OpenDialogOptions, SaveDialogOptions, WebContents } from 'electron';

import { CANVAS_EXTENSION, MAX_CANVAS_BYTES } from '../shared/ipc';
import type { CanvasFile } from '../shared/ipc';

/*
 * Canvas files on disk, for the canvas:* channels. The renderer never names a path: it gets a
 * file's name and text, and main remembers, per renderer, which file its canvas is, so a save can
 * only write where the user picked in a dialog.
 */

const FILTERS = [{ name: 'corrallm canvas', extensions: [CANVAS_EXTENSION] }];

/** The file each renderer's canvas was opened from or last saved to. */
const files = new WeakMap<WebContents, string>();

/** The Open dialog, then the file picked: its name and text. Null if cancelled. */
export async function openCanvas(contents: WebContents): Promise<CanvasFile | null> {
  const options: OpenDialogOptions = { properties: ['openFile'], filters: FILTERS };
  const window = BrowserWindow.fromWebContents(contents);
  const { canceled, filePaths } = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options);
  const [file] = filePaths;
  if (canceled || file === undefined) return null;
  if ((await stat(file)).size > MAX_CANVAS_BYTES) {
    throw new Error(`${path.basename(file)} is too large to be a canvas`);
  }
  const text = await readFile(file, 'utf8');
  files.set(contents, file);
  return { name: path.basename(file), text };
}

/**
 * Writes `text` to the canvas's file, or to one picked in the Save dialog when it has none or
 * `choose` is true (Save As). Resolves with the file's name, or null if cancelled.
 */
export async function saveCanvas(
  contents: WebContents,
  text: string,
  choose: boolean,
): Promise<string | null> {
  const known = files.get(contents);
  let file = choose ? undefined : known;
  if (file === undefined) {
    const options: SaveDialogOptions = {
      filters: FILTERS,
      defaultPath: known ?? `Untitled.${CANVAS_EXTENSION}`,
    };
    const window = BrowserWindow.fromWebContents(contents);
    const { canceled, filePath } = window
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options);
    if (canceled || !filePath) return null;
    file =
      path.extname(filePath) === `.${CANVAS_EXTENSION}`
        ? filePath
        : `${filePath}.${CANVAS_EXTENSION}`;
  }
  // Written beside the file, then moved over it, so a failed write never leaves half a canvas.
  const partial = `${file}.${String(process.pid)}.partial`;
  try {
    await writeFile(partial, text, 'utf8');
    await rename(partial, file);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
  files.set(contents, file);
  return path.basename(file);
}

/** Forgets the canvas's file: its next save asks where. */
export function forgetCanvas(contents: WebContents): void {
  files.delete(contents);
}
