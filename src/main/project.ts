import { stat } from 'node:fs/promises';
import path from 'node:path';

import type { CanvasId } from '../shared/canvas';
import type { ProjectFolder } from '../shared/ipc';
import type { HostServices, TrustedPath, WindowId } from './core/host';
import type { CanvasMemory } from './memory';

export interface ProjectFoldersDeps {
  /** The folder dialog (host/dialogs.ts): the trust gate. */
  host: Pick<HostServices, 'pickFolder'>;
  /** Where each canvas's folder is remembered. */
  memory: CanvasMemory;
}

/**
 * The folder each canvas's agents work in: the user picks it in the folder dialog, so agents only
 * ever run where the user chose (the renderer never names a path). It is remembered with the canvas
 * (memory.ts), and comes back when the canvas is shown again.
 */
export class ProjectFolders {
  readonly #folders = new Map<CanvasId, TrustedPath>();
  readonly #deps: ProjectFoldersDeps;
  readonly #listeners = new Map<CanvasId, Set<() => void>>();
  readonly #unsubscribe: () => void;

  constructor(deps: ProjectFoldersDeps) {
    this.#deps = deps;
    this.#unsubscribe = deps.memory.subscribe((canvas) => {
      if (canvas !== undefined) return;
      for (const id of this.#folders.keys()) {
        if (!deps.memory.keeps(id)) this.#set(id, undefined);
      }
    });
  }

  /** The folder a canvas's agents work in, if one was chosen (and the canvas restored). */
  of(canvas: CanvasId): TrustedPath | undefined {
    return this.#folders.get(canvas);
  }

  /** Hears the picked folder change, restore or be forgotten, for this canvas only. */
  onAvailability(canvas: CanvasId, listener: () => void): () => void {
    const listeners = this.#listeners.get(canvas) ?? new Set<() => void>();
    this.#listeners.set(canvas, listeners);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(canvas);
    };
  }

  close(): void {
    this.#unsubscribe();
    this.#listeners.clear();
  }

  #set(canvas: CanvasId, folder: TrustedPath | undefined): void {
    if (this.#folders.get(canvas) === folder) return;
    if (folder === undefined) this.#folders.delete(canvas);
    else this.#folders.set(canvas, folder);
    for (const listener of this.#listeners.get(canvas) ?? []) {
      try {
        listener();
      } catch (error) {
        console.error('Could not tell of a project folder change:', error);
      }
    }
  }

  /**
   * The folder dialog, on `window`, then the folder picked, remembered with the canvas. Null if
   * cancelled, keeping the folder it had.
   */
  async choose(window: WindowId, canvas: CanvasId): Promise<ProjectFolder | null> {
    const folder = await this.#deps.host.pickFolder(window, this.#folders.get(canvas));
    if (folder === null) return null;
    this.#set(canvas, folder);
    await this.#deps.memory.update(canvas, (remembered) => ({ ...remembered, project: folder }));
    return describe(folder);
  }

  /** As a canvas is shown: the folder remembered with it, if it is still there. */
  async restore(canvas: CanvasId): Promise<ProjectFolder | undefined> {
    const { project } = await this.#deps.memory.get(canvas);
    if (project === undefined || !(await isFolder(project))) {
      this.#set(canvas, undefined);
      return undefined;
    }
    this.#set(canvas, project);
    return describe(project);
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
