import { stat } from 'node:fs/promises';
import path from 'node:path';

import { BrowserWindow, dialog } from 'electron';
import type { OpenDialogOptions, WebContents } from 'electron';

import type { ProjectFolder } from '../shared/ipc';
import type { CanvasMemory } from './memory';

/**
 * The folder each renderer's canvas's agents work in: the user picks it in a folder dialog, so
 * agents only ever run where the user chose (the renderer never names a path). It is remembered
 * with the canvas's file (memory.ts), and comes back when that file opens again.
 */
export class ProjectFolders {
  readonly #folders = new WeakMap<WebContents, string>();
  readonly #memory: CanvasMemory;
  /** The file a renderer's canvas was opened from or saved to (canvas.ts). */
  readonly #canvasOf: (contents: WebContents) => string | undefined;

  constructor(memory: CanvasMemory, canvasOf: (contents: WebContents) => string | undefined) {
    this.#memory = memory;
    this.#canvasOf = canvasOf;
  }

  /** The folder the renderer's canvas's agents work in, if one was chosen. */
  of(contents: WebContents): string | undefined {
    return this.#folders.get(contents);
  }

  /** The folder dialog, then the folder picked. Null if cancelled, keeping the folder it had. */
  async choose(contents: WebContents): Promise<ProjectFolder | null> {
    const current = this.#folders.get(contents);
    const options: OpenDialogOptions = {
      title: 'Project folder',
      message: 'Choose the folder this canvas’s agents work in',
      buttonLabel: 'Choose',
      properties: ['openDirectory', 'createDirectory'],
      ...(current === undefined ? {} : { defaultPath: current }),
    };
    const window = BrowserWindow.fromWebContents(contents);
    const { canceled, filePaths } = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    const [folder] = filePaths;
    if (canceled || folder === undefined) return null;
    this.#folders.set(contents, folder);
    await this.remember(contents);
    return describe(folder);
  }

  /** After a canvas opens: the folder remembered with its file, if it is still there. */
  async restore(contents: WebContents): Promise<ProjectFolder | undefined> {
    this.#folders.delete(contents);
    const file = this.#canvasOf(contents);
    if (file === undefined) return undefined;
    const { project } = await this.#memory.get(file);
    if (project === undefined || !(await isFolder(project))) return undefined;
    this.#folders.set(contents, project);
    return describe(project);
  }

  /** Remembers the folder with the canvas's file: after it is chosen, and after a save. */
  async remember(contents: WebContents): Promise<void> {
    const file = this.#canvasOf(contents);
    if (file === undefined) return;
    const project = this.#folders.get(contents);
    await this.#memory.update(file, ({ sessions }) => ({
      ...(project === undefined ? {} : { project }),
      sessions,
    }));
  }

  /** Forgets the folder, for a new canvas. */
  forget(contents: WebContents): void {
    this.#folders.delete(contents);
  }
}

function describe(folder: string): ProjectFolder {
  return { name: path.basename(folder) || folder, path: folder };
}

async function isFolder(folder: string): Promise<boolean> {
  try {
    return (await stat(folder)).isDirectory();
  } catch {
    return false;
  }
}
