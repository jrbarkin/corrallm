import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { canvasIdOf, newCanvasId } from '../shared/canvas';
import type { CanvasId } from '../shared/canvas';
import { CANVAS_EXTENSION, MAX_CANVAS_BYTES } from '../shared/canvas';
import type { HostServices, TrustedPath, WindowId } from './core/host';
import type { Documents } from './core/canvas/documents';
import type { CanvasMemory } from './memory';

/*
 * Canvas files on disk, for canvas.open and canvas.saveAs (core/canvas/lifecycle.ts): the Open and
 * Save dialogs, and which canvas a file is. No caller names a path: the core remembers which file
 * each canvas is (memory.ts, by the canvas's id), so a save can only write where the user picked in
 * a dialog, and the core reads and saves its own document (core/canvas/documents.ts).
 *
 * A canvas's id is in its file. Opening a file makes it that canvas, unless the canvas is kept in
 * another file that still holds its id (the original after Save As, or a copy made in the Finder):
 * then it opens as a copy, with an id of its own, which it keeps the next time it opens. A moved or
 * renamed file keeps its canvas. A file that isn't a canvas this corrallm reads is refused before
 * any of that, and no canvas takes it as its file.
 */

export interface CanvasFilesDeps {
  /** The Open and Save dialogs (host/dialogs.ts). */
  host: Pick<HostServices, 'pickCanvasToOpen' | 'pickCanvasToSave'>;
  memory: CanvasMemory;
  /** Each canvas's document, which the core reads from its file and saves to it. */
  documents: Pick<Documents, 'read' | 'open' | 'save'>;
}

/** A canvas file opened: its canvas, its name, and why it opened as a copy, if it did. */
export interface OpenedCanvas {
  id: CanvasId;
  name: string;
  copy?: string;
}

export class CanvasFiles {
  readonly #deps: CanvasFilesDeps;

  constructor(deps: CanvasFilesDeps) {
    this.#deps = deps;
  }

  /**
   * The Open dialog on `window`, then the file picked, as a canvas, its document read. Null if
   * cancelled. Rejects, naming the file and saying why, for one that isn't a canvas.
   */
  async open(window: WindowId): Promise<OpenedCanvas | null> {
    const file = await this.#deps.host.pickCanvasToOpen(window);
    if (file === null) return null;
    const name = path.basename(file);
    const text = await read(file);
    const { memory, documents } = this.#deps;
    let own: CanvasId;
    try {
      own = documents.read(text).id;
    } catch (error) {
      throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
    const kept = await memory.canvasWithFile(file);
    let id = kept ?? own;
    let copy: string | undefined;
    const owner = kept === undefined ? (await memory.get(own)).file : undefined;
    if (owner !== undefined && owner !== file && (await holds(owner, own))) {
      id = newCanvasId();
      copy = `${name} is a copy of a canvas saved as ${path.basename(owner)}: it opened as a canvas of its own.`;
    }
    await documents.open(id, text, name);
    await memory.setFile(id, file);
    return { id, name, ...(copy === undefined ? {} : { copy }) };
  }

  /**
   * The Save dialog on `window`, starting at the canvas's file, then the canvas's document saved
   * to the file picked, which becomes its file (Save As, which keeps its id). Resolves with the
   * file's name, or null if cancelled.
   */
  async saveAs(window: WindowId, canvas: CanvasId): Promise<string | null> {
    const known = (await this.#deps.memory.get(canvas)).file;
    const file = await this.#deps.host.pickCanvasToSave(
      window,
      known ?? `Untitled.${CANVAS_EXTENSION}`,
    );
    if (file === null) return null;
    await this.#deps.documents.save(canvas, file);
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
