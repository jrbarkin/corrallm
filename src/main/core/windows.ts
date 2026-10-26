import type { CanvasId } from '../../shared/canvas';
import type { WindowId } from './host';

export interface WindowsDeps {
  /** The canvas a window shows when it first asks: the one the profile had open last. */
  restore: () => Promise<CanvasId>;
  /**
   * A window is to show `canvas`: the core runs it (B11 Design §8), before the window sees it, so
   * its runtime topics are there when the window subscribes. Rejects, saying why, if it can't.
   */
  shown: (canvas: CanvasId) => Promise<void>;
}

/**
 * Which canvas each window shows. The core keeps it; channel handlers look the canvas up here before
 * they call a service, which knows canvases by their ids and nothing of windows. A window only views
 * a canvas the core runs (B11 Design §8): one that reloads, crashes or closes, or shows another
 * canvas, ends nothing of the canvas it showed, which runs on in the core. A window that reloads or
 * crashes keeps its canvas for the page that reconnects; one that closes is forgotten.
 */
export class Windows {
  readonly #deps: WindowsDeps;
  /** The canvas each window shows, or is restoring. */
  readonly #canvases = new Map<WindowId, Promise<CanvasId>>();
  /** The canvas each window shows, once it has one. */
  readonly #shown = new Map<WindowId, CanvasId>();
  /** What hears which canvas a window shows change. */
  readonly #listeners = new Set<() => void>();

  constructor(deps: WindowsDeps) {
    this.#deps = deps;
  }

  /**
   * The canvas the window shows: for a window that shows none yet, the one the profile had open
   * last (restored once, however many ask), run by the core first. Rejects if that can't be
   * restored, which the next asking tries again. One the core can't run is shown all the same: its
   * runtime topics then say it isn't open, and the window offers New and Open.
   */
  async canvasOf(window: WindowId): Promise<CanvasId> {
    let canvas = this.#canvases.get(window);
    if (canvas === undefined) {
      const restoring = this.#deps.restore().then(async (id) => {
        await this.#deps.shown(id).catch((error: unknown) => {
          console.error('The core could not run the canvas a window restored:', error);
        });
        return id;
      });
      canvas = restoring;
      this.#canvases.set(window, restoring);
      restoring.then(
        (id) => {
          if (this.#canvases.get(window) !== restoring) return;
          this.#shown.set(window, id);
          this.#tell();
        },
        () => {
          if (this.#canvases.get(window) === restoring) this.#canvases.delete(window);
        },
      );
    }
    return canvas;
  }

  /**
   * The window shows `canvas` now (it opened or began it), once the core runs it: rejects, the
   * window showing what it showed, if the core can't. The canvas before runs on in the core.
   */
  async show(window: WindowId, canvas: CanvasId): Promise<void> {
    if (this.#shown.get(window) === canvas) return;
    await this.#deps.shown(canvas);
    this.#canvases.set(window, Promise.resolve(canvas));
    this.#shown.set(window, canvas);
    this.#tell();
  }

  /** Hears which canvas a window shows change. Returns what stops it hearing that. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** The canvas the window shows, if it shows one yet: never restoring one. */
  shownIn(window: WindowId): CanvasId | undefined {
    return this.#shown.get(window);
  }

  /** The canvases the windows show, each once. */
  canvases(): CanvasId[] {
    return [...new Set(this.#shown.values())];
  }

  /** Whether the window shows a canvas. */
  has(window: WindowId): boolean {
    return this.#shown.has(window);
  }

  /** The windows showing `canvas`: those that hear its sessions. */
  showing(canvas: CanvasId): WindowId[] {
    return [...this.#shown].flatMap(([window, shown]) => (shown === canvas ? [window] : []));
  }

  /**
   * The page is gone: its canvas runs on in the core, whatever went. Keep the canvas on a reload or
   * crash, for the page that reconnects; forget it only when main says the window itself closed.
   */
  gone(window: WindowId, closed = false): Promise<void> {
    if (closed) {
      this.#canvases.delete(window);
      if (this.#shown.delete(window)) this.#tell();
    }
    return Promise.resolve();
  }

  #tell(): void {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch (error) {
        console.error('Could not tell which canvas a window shows:', error);
      }
    }
  }
}
