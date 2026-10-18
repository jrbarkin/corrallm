/*
 * What the core asks of the app that hosts it: whatever needs the desktop. The core never imports
 * Electron (ESLint's app/boundaries-core), so its dialogs come through `HostServices`: in the app,
 * main's (src/main/host/services.ts); in tests, a fake. Each phase adds what it needs.
 */

declare const trusted: unique symbol;
/**
 * A path the user picked in one of the app's dialogs, or one main wrote itself and read back: the
 * only paths a canvas is opened from or saved to, and the only project folders agents work in.
 */
export type TrustedPath = string & { readonly [trusted]: true };

/**
 * Brands a path as trusted. Only its mint sites call it: the dialogs (src/main/host/dialogs.ts),
 * and the stores reading back paths they wrote (memory.ts, run-journal.ts). Never a command line.
 */
export function mintTrustedPath(path: string): TrustedPath {
  return path as TrustedPath;
}

/** A window, by its web contents' id: the window a dialog belongs to. */
export type WindowId = number;

export interface HostServices {
  /** The Open dialog for a canvas file: the file picked, or null if cancelled. */
  pickCanvasToOpen(window: WindowId): Promise<TrustedPath | null>;
  /**
   * The Save dialog for a canvas file, starting at `defaultPath`: the file picked, with the canvas
   * extension, or null if cancelled.
   */
  pickCanvasToSave(window: WindowId, defaultPath: string): Promise<TrustedPath | null>;
  /**
   * The folder dialog for a canvas's project folder (the trust gate), starting at `current` if
   * given: the folder picked, or null if cancelled.
   */
  pickFolder(window: WindowId, current?: string): Promise<TrustedPath | null>;
}
