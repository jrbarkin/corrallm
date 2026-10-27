import type { NotificationRequest, NotificationResult, Presence } from './presence';

/*
 * What the core asks of the app that hosts it: whatever needs the desktop. The core never imports
 * Electron (ESLint's app/boundaries-core), so its dialogs come through `HostServices`: in the app,
 * main's (src/main/host/services.ts); in tests, a fake. Each phase adds what it needs.
 */

declare const trusted: unique symbol;
/**
 * A path the user picked in one of the app's dialogs, one the core wrote itself and read back, or a
 * workspace's checkout the core made of a picked repository, verified: the only paths a canvas is
 * opened from or saved to, and the only folders agents work in.
 */
export type TrustedPath = string & { readonly [trusted]: true };

/**
 * Brands a path as trusted. Only its mint sites call it: the host’s dialog answers (core/host/app.ts),
 * the stores reading back paths they wrote (memory.ts, run-journal.ts), and a workspace's checkout
 * once verified as the one the core made, at every use (core/workspaces/checkout.ts). Never a
 * command line.
 */
export function mintTrustedPath(path: string): TrustedPath {
  return path as TrustedPath;
}

/** A window, by its web contents' id: the window a dialog belongs to. */
export type WindowId = number;

/** Whether to open a link, and to open its site's links from now on. */
export interface LinkAnswer {
  open: boolean;
  always: boolean;
}

export interface HostServices {
  /** Replaces the native presence snapshot; no-op without a desktop. */
  presence(snapshot: Presence): void;
  /** Asks the native host to show one bounded notification. */
  notify(notification: NotificationRequest): Promise<NotificationResult>;
  /** Withdraws a native notification by its opaque handle. */
  unnotify(handle: string): void;
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
  /** Asks before opening a site the user has not allowed, parented to its window. */
  askOpenLink(window: WindowId, host: string, url: string): Promise<LinkAnswer>;
  /** Opens a URL the core checked in the user's browser. */
  openExternal(url: string): Promise<null>;
  /** Shows a project file the core checked in the file manager, never opening it. */
  showFile(file: string): Promise<null>;
}
