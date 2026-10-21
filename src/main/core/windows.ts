import type { CanvasId } from '../../shared/canvas';
import type { WindowId } from './host';

export interface WindowsDeps {
  /** The canvas a window shows when it first asks: the one the profile had open last. */
  restore: () => Promise<CanvasId>;
  /** A window left the canvas (closed, crashed, reloaded, or showed another): its sessions end. */
  left: (canvas: CanvasId) => Promise<void>;
}

/**
 * Which canvas each window shows. The core keeps it; channel handlers look the canvas up here before
 * they call a service, which knows canvases by their ids and nothing of windows. A window that
 * reloads keeps its canvas: its sessions end, and the page restores it once they have. One that
 * crashes or closes, or shows another canvas, leaves its canvas, and its sessions end.
 */
export class Windows {
  readonly #deps: WindowsDeps;
  /** The canvas each window shows, or is restoring. */
  readonly #canvases = new Map<WindowId, Promise<CanvasId>>();
  /** The canvas each window shows, once it has one. */
  readonly #shown = new Map<WindowId, CanvasId>();
  /** A reloading window's canvas's sessions, closing: its page restores it once they have. */
  readonly #reloading = new Map<WindowId, Promise<void>>();
  /** What hears which canvas a window shows change. */
  readonly #listeners = new Set<() => void>();

  constructor(deps: WindowsDeps) {
    this.#deps = deps;
  }

  /**
   * The canvas the window shows, once a reload's sessions have closed: for a window that shows none
   * yet, the one the profile had open last (restored once, however many ask). Rejects if that
   * can't be restored, which the next asking tries again.
   */
  async canvasOf(window: WindowId): Promise<CanvasId> {
    const leaving = this.#reloading.get(window);
    if (leaving) await leaving;
    let canvas = this.#canvases.get(window);
    if (canvas === undefined) {
      const restoring = this.#deps.restore();
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

  /** The window shows `canvas` now (it opened or began it): the canvas before leaves it. */
  async show(window: WindowId, canvas: CanvasId): Promise<void> {
    const before = this.#shown.get(window);
    this.#canvases.set(window, Promise.resolve(canvas));
    this.#shown.set(window, canvas);
    this.#tell();
    if (before !== undefined) await this.#deps.left(before);
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
   * The page is gone: close its sessions before the next page restores. Keep the canvas on a
   * reload or crash; forget it only when main says the window itself closed.
   */
  async gone(window: WindowId, closed = false): Promise<void> {
    const canvas = this.#shown.get(window);
    let leaving = this.#reloading.get(window);
    if (canvas !== undefined && leaving === undefined) {
      leaving = this.#deps.left(canvas);
      this.#reloading.set(window, leaving);
      void leaving
        .finally(() => {
          if (this.#reloading.get(window) === leaving) this.#reloading.delete(window);
        })
        .catch(() => undefined);
    }
    if (closed) {
      this.#canvases.delete(window);
      if (this.#shown.delete(window)) this.#tell();
    }
    await leaving;
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
