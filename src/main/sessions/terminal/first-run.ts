/** A session's turn to start its CLI in a folder. */
export interface FirstRunTurn {
  /** Undefined if it may start now; otherwise, resolves once it may. */
  readonly ready: Promise<void> | undefined;
  /** Its CLI is past its first-run dialogs: the folder is trusted, and the others start. */
  passed(): void;
  /** It is gone (or never started its CLI) before that: the next one waiting starts. */
  done(): void;
}
