import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CanvasId } from '../shared/canvas';
import { MAX_LINK_LENGTH } from '../shared/ipc';

/*
 * file:// links the user Cmd-clicks in a terminal (a CLI prints the files it names as OSC 8
 * links) are shown in the OS file manager (Finder), selected in their folder, if they are in the
 * canvas's project folder: the renderer only names the link (link:reveal). The core decides: the link
 * must be a file:// URL on this machine (no host), to a file or folder that exists, whose real
 * path (links resolved) is the project folder's real path or inside it. Anything else stays
 * inert. A file is only ever shown, never opened (no executable runs, whatever it is).
 */

export interface FileRevealerDeps {
  /** The project folder of a canvas, if one was chosen (project.ts). */
  folderOf: (canvas: CanvasId) => string | undefined;
  /** Shows a file or folder in the OS file manager, selected (shell.showItemInFolder). */
  show: (file: string) => void | Promise<void>;
}

export class FileRevealer {
  readonly #deps: FileRevealerDeps;

  constructor(deps: FileRevealerDeps) {
    this.#deps = deps;
  }

  /** Shows the file the user clicked in a canvas's agent, if it may. Resolves with whether it was shown. */
  async reveal(canvas: CanvasId, raw: string): Promise<boolean> {
    const folder = this.#deps.folderOf(canvas);
    if (folder === undefined) return false;
    const file = await revealTarget(raw, folder);
    if (file === null) return false;
    await this.#deps.show(file);
    return true;
  }
}

/**
 * The real path of the file or folder the file:// link `raw` names, if it exists and is the
 * project folder (`folder`) or in it, both with their links resolved; null otherwise.
 */
export async function revealTarget(raw: string, folder: string): Promise<string | null> {
  if (raw.length > MAX_LINK_LENGTH) return null;
  let file: string;
  try {
    const url = new URL(raw);
    // "localhost" is no host in a file URL; any other is another machine's.
    if (url.protocol !== 'file:' || url.host !== '' || url.username !== '' || url.password !== '') {
      return null;
    }
    file = fileURLToPath(url);
  } catch {
    return null;
  }
  if (!path.isAbsolute(file)) return null;
  let real: string;
  let realFolder: string;
  try {
    [real, realFolder] = await Promise.all([realpath(file), realpath(folder)]);
  } catch {
    return null;
  }
  const relative = path.relative(realFolder, real);
  const inside =
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  return inside ? real : null;
}
