import type { WebContents } from 'electron';

import type { CanvasId } from '../../shared/canvas';
import { originKey } from '../url-policy';

export interface WindowsDeps {
  /** The canvas a window shows when it first asks: the one the profile had open last. */
  restore: () => Promise<CanvasId>;
  /** A window left the canvas (closed, crashed, reloaded, or showed another): its sessions end. */
  left: (canvas: CanvasId) => Promise<void>;
}

/**
 * Which canvas each window shows. The host keeps it; IPC handlers look the canvas up here before
 * they call a service, which knows canvases by their ids and nothing of windows. A window that
 * reloads keeps its canvas: its sessions end, and the page restores it once they have. One that
 * crashes or closes, or shows another canvas, leaves its canvas, and its sessions end.
 */
export class Windows {
  readonly #origin: string;
  readonly #deps: WindowsDeps;
  /** The canvas each window shows, or is restoring. */
  readonly #canvases = new Map<WebContents, Promise<CanvasId>>();
  /** The canvas each window shows, once it has one. */
  readonly #shown = new Map<WebContents, CanvasId>();
  /** A reloading window's canvas's sessions, closing: its page restores it once they have. */
  readonly #reloading = new WeakMap<WebContents, Promise<void>>();

  /** `origin`: the app's renderer's, whose navigations are reloads (security.ts blocks others). */
  constructor(origin: string, deps: WindowsDeps) {
    this.#origin = origin;
    this.#deps = deps;
  }

  /**
   * The canvas the window shows, once a reload's sessions have closed: for a window that shows none
   * yet, the one the profile had open last (restored once, however many ask). Rejects if that
   * can't be restored, which the next asking tries again.
   */
  async canvasOf(contents: WebContents): Promise<CanvasId> {
    await this.#reloading.get(contents);
    let canvas = this.#canvases.get(contents);
    if (canvas === undefined) {
      const restoring = this.#deps.restore();
      canvas = restoring;
      this.#canvases.set(contents, restoring);
      restoring.then(
        (id) => {
          if (this.#canvases.get(contents) === restoring) this.#shown.set(contents, id);
        },
        () => {
          if (this.#canvases.get(contents) === restoring) this.#canvases.delete(contents);
        },
      );
    }
    return canvas;
  }

  /** The window shows `canvas` now (it opened or began it): the canvas before leaves it. */
  async show(contents: WebContents, canvas: CanvasId): Promise<void> {
    const before = this.#shown.get(contents);
    this.#canvases.set(contents, Promise.resolve(canvas));
    this.#shown.set(contents, canvas);
    if (before !== undefined) await this.#deps.left(before);
  }

  /** Whether the window shows a canvas. */
  has(contents: WebContents): boolean {
    return this.#shown.has(contents);
  }

  /** The windows showing `canvas`: those that hear its sessions. */
  showing(canvas: CanvasId): WebContents[] {
    return [...this.#shown].flatMap(([contents, shown]) => (shown === canvas ? [contents] : []));
  }

  /** Follows a new window: its reloads, its crash and its going. */
  watch(contents: WebContents): void {
    contents.on('did-start-navigation', (event) => {
      const canvas = this.#shown.get(contents);
      if (
        canvas === undefined ||
        !event.isMainFrame ||
        event.isSameDocument ||
        originKey(event.url) !== this.#origin
      ) {
        return;
      }
      this.#reloading.set(
        contents,
        this.#deps.left(canvas).catch((error: unknown) => {
          console.error('Could not close before reload:', error);
        }),
      );
    });
    contents.on('render-process-gone', () => {
      this.#leave(contents);
    });
    contents.once('destroyed', () => {
      this.#leave(contents);
      this.#canvases.delete(contents);
      this.#shown.delete(contents);
    });
  }

  #leave(contents: WebContents): void {
    const canvas = this.#shown.get(contents);
    if (canvas === undefined) return;
    this.#deps.left(canvas).catch((error: unknown) => {
      console.error('Could not close the canvas’s sessions:', error);
    });
  }
}
