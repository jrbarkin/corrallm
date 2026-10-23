import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import type { CanvasId } from '../../../shared/canvas';
import { MAX_CANVAS_BYTES } from '../../../shared/ipc';
import type { ProjectFolder } from '../../../shared/ipc';
import type { CanvasNode } from '../../../shared/model/canvas';
import { toFile } from '../../../shared/model/file';
import type { PartyId } from '../../../shared/model/messages';
import type { CanvasFiles } from '../../canvas';
import type { CanvasMemory } from '../../memory';
import type { ProjectFolders } from '../../project';
import type { RunJournal } from '../../run-journal';
import type { SessionManager } from '../../sessions/manager';
import { OpFailure } from '../call';
import type { Engines } from '../engines';
import type { WindowId } from '../host';
import type { Windows } from '../windows';
import type { Documents } from './documents';

/*
 * A canvas's lifetime in the core (B9 Design §1, §2, §5; Core Server §4 B, §5.8): opening a file
 * the user picks, saving to its file or to one the user picks, choosing its project folder, and
 * closing it. A canvas is open from when it is made or opened until it is closed (`open_canvas`),
 * whether or not a window shows it; the core keeps what it has of it after (its document's rows,
 * its run, its conversations), so a canvas opened again has its edits not saved. Closing it holds
 * and journals the run the core runs of it, ends its sessions, and shows each window that showed it
 * another canvas: the one open used last, else a new draft. Discarding its edits reverts it to its
 * file, as one change, or forgets a draft. A path is only ever one a dialog the user completed gave
 * (main's, through the host), or one canvas memory kept from one.
 */

export interface LifecycleDeps {
  documents: Pick<
    Documents,
    | 'load'
    | 'loaded'
    | 'live'
    | 'edited'
    | 'read'
    | 'save'
    | 'revert'
    | 'forget'
    | 'hasRows'
    | 'keep'
    | 'review'
  >;
  memory: Pick<CanvasMemory, 'get' | 'keeps'>;
  journal: Pick<RunJournal, 'opened' | 'open' | 'close' | 'last' | 'saved'>;
  windows: Pick<Windows, 'canvasOf' | 'show' | 'showing' | 'shownIn'>;
  projects: Pick<ProjectFolders, 'choose' | 'restore' | 'of'>;
  sessions: Pick<SessionManager, 'closeCanvas' | 'projectChanged'>;
  engines: Pick<Engines, 'closeCanvas'>;
  /** The Open and Save dialogs, and which canvas a file opened is. */
  files: Pick<CanvasFiles, 'open' | 'saveAs'>;
}

const NO_FILE_YET =
  'This canvas has never been saved, so it has no file yet: the user saves it in corrallm, choosing where (canvas.saveAs).';

export class Lifecycle {
  readonly #deps: LifecycleDeps;

  constructor(deps: LifecycleDeps) {
    this.#deps = deps;
  }

  /** Whether the core keeps `canvas`: canvas memory does, or its document is loaded. */
  keeps(canvas: CanvasId): boolean {
    return this.#deps.documents.loaded(canvas) !== undefined || this.#deps.memory.keeps(canvas);
  }

  /** Throws not-found for a canvas the core doesn't keep. */
  kept(canvas: CanvasId): void {
    if (!this.keeps(canvas)) throw new OpFailure('not-found', `There is no canvas ${canvas}.`);
  }

  /** Whether a window shows `canvas`. */
  shown(canvas: CanvasId): boolean {
    return this.#deps.windows.showing(canvas).length > 0;
  }

  /** Whether `canvas`'s document has edits not saved (a draft: holds anything). */
  async edited(canvas: CanvasId): Promise<boolean> {
    await this.#deps.documents.load(canvas);
    return this.#deps.documents.edited(canvas);
  }

  /** The name a canvas goes by: its file's, or none for one never saved. */
  async nameOf(canvas: CanvasId): Promise<string | undefined> {
    const { file } = await this.#deps.memory.get(canvas);
    return file === undefined ? undefined : path.basename(file);
  }

  /**
   * The agents `canvas`'s file on disk has that its document lacks, which saving it would remove
   * (R4): none for a canvas with no file, or one no longer there; undefined for a file that isn't a
   * canvas this corrallm reads, whose agents can't be told.
   */
  async lostOnSave(canvas: CanvasId): Promise<CanvasNode[] | undefined> {
    const { documents } = this.#deps;
    const text = await this.#fileText(canvas);
    if (text === undefined) return [];
    let saved;
    try {
      saved = documents.read(text);
    } catch {
      return undefined;
    }
    const { document } = await documents.load(canvas);
    const agents = new Set(
      document.nodes.flatMap((node) => (node.type === 'agent' ? [node.id] : [])),
    );
    return saved.nodes.filter((node) => node.type === 'agent' && !agents.has(node.id));
  }

  /**
   * What a proposal of a canvas's (R4's: a close, a replace, a save) touched, as it is now, by its
   * key: its document's text (`document:<id>`), its file's bytes (`file:<id>`), each as a number
   * that differs once it changed. Undefined for a key it doesn't know.
   */
  async touched(key: string): Promise<number | undefined> {
    const [kind, canvas] = key.split(':') as [string, CanvasId | undefined];
    if (canvas === undefined || !this.keeps(canvas)) return undefined;
    if (kind === 'document') {
      const { document } = await this.#deps.documents.load(canvas);
      return fingerprint(toFile(document));
    }
    if (kind === 'file') {
      const text = await this.#fileText(canvas).catch(() => undefined);
      return text === undefined ? 0 : fingerprint(text);
    }
    return undefined;
  }

  /**
   * A canvas made (canvas.create) is open, its run's generation new; shown in `window`, if one,
   * the canvas it showed before leaving it.
   */
  async made(canvas: CanvasId, window: WindowId | undefined): Promise<void> {
    await this.#deps.journal.opened(canvas);
    if (window !== undefined) await this.#deps.windows.show(window, canvas);
  }

  /**
   * The Open dialog on `window`, then the file picked opened in it, as its canvas (or a copy of
   * it, saying so once), its folder restored: its id, or null if cancelled. Rejects, naming the
   * file and saying why, for one that isn't a canvas.
   */
  async open(window: WindowId): Promise<CanvasId | null> {
    const opened = await this.#deps.files.open(window);
    if (opened === null) return null;
    const { id, copy } = opened;
    // Opening the file already shown changes neither its native sessions nor its run generation.
    if (this.#deps.windows.shownIn(window) === id) return id;
    await this.#deps.journal.opened(id, copy);
    await this.#deps.windows.show(window, id);
    await this.#deps.projects.restore(id);
    return id;
  }

  /**
   * Shows `canvas` in `window` (window.show), its folder restored and its file checked as it opens
   * (B9 Design §5): open from now until it is closed, as a canvas opened is, the one the profile
   * used last. The canvas the window showed stays open.
   */
  async show(window: WindowId, canvas: CanvasId): Promise<void> {
    const { journal, windows, projects, documents } = this.#deps;
    await journal.open(canvas);
    // A document that can't be read is said so where it is read (canvas.get).
    await documents.review(canvas).catch(() => undefined);
    if ((await windows.canvasOf(window)) === canvas) return;
    await projects.restore(canvas);
    await windows.show(window, canvas);
  }

  /**
   * Saves `canvas` to its file: the file's name. Refused for a canvas never saved, which has none
   * (the user picks one in the Save dialog: `saveAs`).
   */
  async save(canvas: CanvasId): Promise<string> {
    const { file } = await this.#deps.memory.get(canvas);
    if (file === undefined) throw new OpFailure('refused', NO_FILE_YET);
    await this.#deps.documents.save(canvas, file);
    await this.#deps.journal.saved(canvas);
    return path.basename(file);
  }

  /**
   * The Save dialog on `window`, then `canvas` saved to the file picked, which becomes its file,
   * the canvas keeping its id: the file's name, or null if cancelled.
   */
  async saveAs(window: WindowId, canvas: CanvasId): Promise<string | null> {
    const name = await this.#deps.files.saveAs(window, canvas);
    if (name !== null) await this.#deps.journal.saved(canvas);
    return name;
  }

  /**
   * The folder dialog on `window`, starting at `canvas`'s folder, then the folder picked
   * remembered with it: its sessions end once it is another than the one it had. Null if
   * cancelled, keeping the folder it had.
   */
  async chooseProject(window: WindowId, canvas: CanvasId): Promise<ProjectFolder | null> {
    const { projects, sessions } = this.#deps;
    await projects.restore(canvas);
    const before = projects.of(canvas);
    const chosen = await projects.choose(window, canvas);
    if (chosen !== null && chosen.path !== before) await sessions.projectChanged(canvas);
    return chosen;
  }

  /** Checks a discard's file before any canvas is changed or made for its replacement. */
  async validateClose(canvas: CanvasId, discard: boolean): Promise<void> {
    if (!discard || !(await this.edited(canvas))) return;
    const { file } = await this.#deps.memory.get(canvas);
    if (file === undefined) return;
    const text = await this.#fileText(canvas);
    if (text === undefined) throw new Error('The canvas file to revert to is missing.');
    this.#deps.documents.read(text);
  }

  /**
   * Closes `canvas` (B9 Design §2, §5): its run the core runs held and journaled, its sessions
   * ended, each window showing it shown another canvas (the one open used last, else a new draft),
   * and it is no longer open. What the core keeps of it stays, unless `discard`: then its edits not
   * saved are reverted to its file, by `by`, as one change (rejecting before closing if
   * its file can't be read), or, for a canvas never saved, it is forgotten once closed (after its proposal settles).
   */
  async close(
    canvas: CanvasId,
    {
      discard,
      by,
      after,
    }: { discard: boolean; by: PartyId; after?: (cleanup: () => Promise<void>) => void },
  ): Promise<void> {
    const { documents, memory, journal, windows, sessions, engines } = this.#deps;
    const { file } = await memory.get(canvas);
    await this.validateClose(canvas, discard);
    await engines.closeCanvas(canvas);
    if (discard && file !== undefined && (await this.edited(canvas))) {
      await documents.revert(canvas, { op: 'canvas.close', by });
    }
    await journal.close(canvas);
    for (const window of windows.showing(canvas)) await windows.show(window, await journal.last());
    await sessions.closeCanvas(canvas);
    if (discard && file === undefined) {
      const forget = async () => {
        await documents.forget(canvas);
      };
      if (after) after(forget);
      else await forget();
    }
  }

  /**
   * Keeps `canvas`'s document in rows, if it isn't yet (a draft shown that holds nothing): what a
   * proposal of it refers to.
   */
  async keepRows(canvas: CanvasId): Promise<void> {
    const { documents } = this.#deps;
    await documents.load(canvas);
    if (!documents.hasRows(canvas)) await documents.keep(canvas);
  }

  /** The text of `canvas`'s file on disk: none for one with no file, or one no longer there. */
  async #fileText(canvas: CanvasId): Promise<string | undefined> {
    const { file } = await this.#deps.memory.get(canvas);
    if (file === undefined) return undefined;
    try {
      if ((await stat(file)).size > MAX_CANVAS_BYTES) {
        throw new Error(`${path.basename(file)} is too large to be a canvas`);
      }
      return await readFile(file, 'utf8');
    } catch (error) {
      if ((error as { code?: unknown }).code === 'ENOENT') return undefined;
      throw error;
    }
  }
}

/** A number that differs, all but surely, between two texts that differ: of their SHA-256. */
function fingerprint(text: string): number {
  return Number.parseInt(createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12), 16);
}
