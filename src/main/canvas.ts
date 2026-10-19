import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { canvasIdOf, newCanvasId } from '../shared/canvas';
import type { CanvasId } from '../shared/canvas';
import { CANVAS_EXTENSION, MAX_CANVAS_BYTES } from '../shared/ipc';
import type { HostServices, TrustedPath, WindowId } from './core/host';
import type { CanvasMemory } from './memory';
import { writeWhole } from './whole-file';

/*
 * Canvas files on disk, for the canvas:* channels. The renderer never names a path: it gets a
 * file's name and text, and main remembers which file each canvas is (memory.ts, by the canvas's
 * id), so a save can only write where the user picked in a dialog.
 *
 * A canvas's id is in its file. Opening a file makes it that canvas, unless the canvas is kept in
 * another file that still holds its id (the original after Save As, or a copy made in the Finder):
 * then it opens as a copy, with an id of its own, which it keeps the next time it opens. A moved or
 * renamed file keeps its canvas.
 */

export interface CanvasFilesDeps {
  /** The Open and Save dialogs (host/dialogs.ts). */
  host: Pick<HostServices, 'pickCanvasToOpen' | 'pickCanvasToSave'>;
  memory: CanvasMemory;
}

/** A canvas file opened: its canvas, its name and text, and why it opened as a copy, if it did. */
export interface OpenedCanvas {
  id: CanvasId;
  name: string;
  text: string;
  copy?: string;
}

export class CanvasFiles {
  readonly #deps: CanvasFilesDeps;

  constructor(deps: CanvasFilesDeps) {
    this.#deps = deps;
  }

  /** The Open dialog on `window`, then the file picked, as a canvas. Null if cancelled. */
  async open(window: WindowId): Promise<OpenedCanvas | null> {
    const file = await this.#deps.host.pickCanvasToOpen(window);
    if (file === null) return null;
    const text = await read(file);
    const own = canvasIdOf(text);
    const { memory } = this.#deps;
    const kept = await memory.canvasWithFile(file);
    if (kept !== undefined) return { id: kept, name: path.basename(file), text };
    const owner = (await memory.get(own)).file;
    if (owner !== undefined && owner !== file && (await holds(owner, own))) {
      const id = newCanvasId();
      await memory.setFile(id, file);
      return {
        id,
        name: path.basename(file),
        text,
        copy: `${path.basename(file)} is a copy of a canvas saved as ${path.basename(owner)}: it opened as a canvas of its own.`,
      };
    }
    await memory.setFile(own, file);
    return { id: own, name: path.basename(file), text };
  }

  /**
   * Writes `text` (the canvas's, by its id) to the canvas's file, or to one picked in the Save
   * dialog on `window` when it has none or `choose` is true (Save As, which keeps its id). Resolves
   * with the file's name, or null if cancelled.
   */
  async save(
    window: WindowId,
    canvas: CanvasId,
    text: string,
    choose: boolean,
  ): Promise<string | null> {
    if (canvasIdOf(text) !== canvas) throw new Error('This canvas’s text is another canvas’s.');
    const known = (await this.#deps.memory.get(canvas)).file;
    let file = choose ? undefined : known;
    file ??=
      (await this.#deps.host.pickCanvasToSave(window, known ?? `Untitled.${CANVAS_EXTENSION}`)) ??
      undefined;
    if (file === undefined) return null;
    // Written beside the file, then moved over it, so a failed write never leaves half a canvas.
    await writeWhole(file, text);
    await this.#deps.memory.setFile(canvas, file);
    return path.basename(file);
  }
}

/** A canvas file's text, if it is not too large to be one. */
async function read(file: TrustedPath): Promise<string> {
  if ((await stat(file)).size > MAX_CANVAS_BYTES) {
    throw new Error(`${path.basename(file)} is too large to be a canvas`);
  }
  return readFile(file, 'utf8');
}

/** Whether `file` still holds canvas `id`. */
async function holds(file: TrustedPath, id: CanvasId): Promise<boolean> {
  try {
    return canvasIdOf(await read(file)) === id;
  } catch {
    return false;
  }
}
