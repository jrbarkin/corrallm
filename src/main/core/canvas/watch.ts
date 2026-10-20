import { watch } from 'node:fs';
import path from 'node:path';

import type { CanvasId } from '../../../shared/canvas';

/*
 * The files of the canvases open, watched (Core Server §5.10, B9 Design §5): through `fs.watch` of
 * each file's folder, since a file written whole is renamed into place, which a watch of the file
 * itself would lose track of. A change said of a canvas's file is checked once SETTLE_MS have passed
 * with no other said of it, so an editor's writes in a row are checked once, whole. One watch per
 * folder, shared by the canvases whose files are in it, closed once none open needs it, and all as
 * the core closes. A lost watch is retried with a bounded backoff, checking every file once it is
 * re-armed so changes during the gap are seen too. It runs under plain Node (`corrallm serve`)
 * as in the app's core process.
 */

/** How long a canvas's file is left after a change is said of it before it is checked, in ms. */
export const SETTLE_MS = 200;

/** First retry after a watch is lost; later failures back off to at most ten seconds. */
export const RETRY_MS = 250;

/**
 * Watches `folder`, saying the name of each entry a change is said of (null: some entry, unnamed),
 * until it errors or closes (`stopped`), or its owner closes it.
 */
export type WatchFolder = (
  folder: string,
  changed: (name: string | null) => void,
  stopped: () => void,
) => { close(): void };

/** `fs.watch` of a folder, holding no process open; a failed watch says why and is re-armed. */
export const watchFolder: WatchFolder = (folder, changed, stopped) => {
  const watcher = watch(folder, { persistent: false }, (_event, name) => {
    changed(typeof name === 'string' ? name : null);
  });
  watcher.on('error', (error) => {
    console.error(`Could not go on watching ${folder} for canvas files changed on disk:`, error);
    stopped();
  });
  watcher.on('close', stopped);
  return watcher;
};

export interface FileWatchDeps {
  /** Checks a canvas's file, which a change was said of. */
  check: (canvas: CanvasId) => void;
  /** What watches a folder: `fs.watch`, but in tests. */
  watch?: WatchFolder;
  settle?: number;
}

/** A folder watched: what watches it, and the canvases whose files are in it, by their names. */
interface Folder {
  watcher: { close(): void } | undefined;
  files: Map<CanvasId, string>;
  generation: number;
  retry: ReturnType<typeof setTimeout> | undefined;
  delay: number;
}

export class FileWatch {
  readonly #deps: FileWatchDeps;
  readonly #watch: WatchFolder;
  readonly #settle: number;
  /** Each folder watched, by its path. */
  readonly #folders = new Map<string, Folder>();
  /** Each canvas's file watched, by the canvas. */
  readonly #files = new Map<CanvasId, string>();
  /** Each canvas's check waiting for its file to settle. */
  readonly #timers = new Map<CanvasId, ReturnType<typeof setTimeout>>();
  #closed = false;

  constructor(deps: FileWatchDeps) {
    this.#deps = deps;
    this.#watch = deps.watch ?? watchFolder;
    this.#settle = deps.settle ?? SETTLE_MS;
  }

  /** Watches the files `files` names (each open canvas's, by the canvas) from now, and no others. */
  follow(files: ReadonlyMap<CanvasId, string>): void {
    if (this.#closed) return;
    for (const [canvas, file] of this.#files) {
      if (files.get(canvas) !== file) this.#unwatch(canvas, file);
    }
    for (const [canvas, file] of files) {
      if (this.#files.get(canvas) !== file) this.#add(canvas, file);
    }
  }

  /** Stops watching every file, its checks waiting dropped. */
  close(): void {
    this.#closed = true;
    for (const [canvas, file] of this.#files) this.#unwatch(canvas, file);
  }

  #add(canvas: CanvasId, file: string): void {
    const folder = path.dirname(file);
    let watched = this.#folders.get(folder);
    if (watched === undefined) {
      watched = {
        watcher: undefined,
        files: new Map(),
        generation: 0,
        retry: undefined,
        delay: RETRY_MS,
      };
      this.#folders.set(folder, watched);
      watched.files.set(canvas, path.basename(file));
      this.#arm(folder, watched, false);
    }
    watched.files.set(canvas, path.basename(file));
    this.#files.set(canvas, file);
  }

  /** Starts exactly one watch; callbacks from a retired watch cannot retire its replacement. */
  #arm(folder: string, watched: Folder, recovered: boolean): void {
    if (this.#folders.get(folder) !== watched || this.#closed) return;
    const generation = ++watched.generation;
    const current = () =>
      this.#folders.get(folder) === watched && watched.generation === generation;
    try {
      const watcher = this.#watch(
        folder,
        (name) => {
          if (!current()) return;
          // Linux's IN_DELETE_SELF can report only the folder's own name, with no error or close.
          if (name === path.basename(folder)) this.#retry(folder, watched);
          else
            for (const [canvas, named] of watched.files) {
              if (name === null || name === named) this.#soon(canvas);
            }
        },
        () => {
          if (current()) this.#retry(folder, watched);
        },
      );
      if (!current()) {
        watcher.close();
        return;
      }
      watched.watcher = watcher;
      watched.delay = RETRY_MS;
      if (recovered) for (const canvas of watched.files.keys()) this.#soon(canvas);
    } catch (error) {
      console.error(`Could not watch ${folder} for canvas files changed on disk:`, error);
      if (current()) this.#retry(folder, watched);
    }
  }

  #retry(folder: string, watched: Folder): void {
    // Invalidate first: closing it may synchronously say it stopped too.
    watched.generation++;
    const watcher = watched.watcher;
    watched.watcher = undefined;
    watcher?.close();
    if (watched.retry !== undefined) return;
    watched.retry = setTimeout(() => {
      watched.retry = undefined;
      this.#arm(folder, watched, true);
    }, watched.delay);
    watched.retry.unref();
    watched.delay = Math.min(watched.delay * 2, 10_000);
  }

  #unwatch(canvas: CanvasId, file: string): void {
    this.#files.delete(canvas);
    clearTimeout(this.#timers.get(canvas));
    this.#timers.delete(canvas);
    const folder = path.dirname(file);
    const watched = this.#folders.get(folder);
    if (watched === undefined) return;
    watched.files.delete(canvas);
    if (watched.files.size > 0) return;
    this.#folders.delete(folder);
    clearTimeout(watched.retry);
    watched.watcher?.close();
  }

  /** Checks the canvas's file once SETTLE_MS pass with nothing more said of it. */
  #soon(canvas: CanvasId): void {
    clearTimeout(this.#timers.get(canvas));
    const timer = setTimeout(() => {
      this.#timers.delete(canvas);
      if (!this.#closed && this.#files.has(canvas)) this.#deps.check(canvas);
    }, this.#settle);
    timer.unref();
    this.#timers.set(canvas, timer);
  }
}
