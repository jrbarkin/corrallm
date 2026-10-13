/*
 * Which Terminal session of a CLI starts first in a folder, while the folder may not be trusted
 * yet. Claude Code asks whether to trust a folder the first time it runs there (its folder trust
 * dialog, whose default is "No, exit"), in every process that starts before the user answers: so
 * several agents started at once in a new folder (as the queues' Run starts them) would each ask.
 * Instead one session starts first; the others wait until it is past its first-run dialogs (its
 * CLI reported its state, a hook posted, or its prompt showed: the folder is trusted), then all
 * start, and ask nothing. If it ends before that (the user picked "No, exit", or its agent went),
 * the next one waiting starts, and asks in its turn. Once one has got past, every later session in
 * the folder starts at once.
 */

/** A session's turn to start its CLI in a folder. */
export interface FirstRunTurn {
  /** Undefined if it may start now; otherwise, resolves once it may. */
  readonly ready: Promise<void> | undefined;
  /** Its CLI is past its first-run dialogs: the folder is trusted, and the others start. */
  passed(): void;
  /** It is gone (or never started its CLI) before that: the next one waiting starts. */
  done(): void;
}

interface Waiting {
  start: () => void;
}

interface Folder {
  /** Whether a session got past its first-run dialogs here. */
  trusted: boolean;
  /** The session started first, until it gets past them or goes. */
  first: Waiting | undefined;
  /** The others, in the order they asked to start. */
  waiting: Waiting[];
}

/** A turn that waits for nothing: the folder is trusted. */
const FREE: FirstRunTurn = { ready: undefined, passed: () => undefined, done: () => undefined };

export class FirstRuns {
  /** By folder (its real path). */
  readonly #folders = new Map<string, Folder>();

  /** A session's turn to start in `folder` (its real path). */
  take(folder: string): FirstRunTurn {
    let at = this.#folders.get(folder);
    if (!at) {
      at = { trusted: false, first: undefined, waiting: [] };
      this.#folders.set(folder, at);
    }
    if (at.trusted) return FREE;
    const place = at;
    let start: () => void = () => undefined;
    const me: Waiting = {
      start: () => {
        start();
      },
    };
    let ready: Promise<void> | undefined;
    if (place.first === undefined) place.first = me;
    else {
      ready = new Promise((resolve) => {
        start = resolve;
      });
      place.waiting.push(me);
    }
    return {
      ready,
      passed: () => {
        if (place.first !== me) return;
        place.trusted = true;
        place.first = undefined;
        for (const other of place.waiting.splice(0)) other.start();
      },
      done: () => {
        if (place.first !== me) {
          place.waiting = place.waiting.filter((other) => other !== me);
          return;
        }
        const next = place.waiting.shift();
        place.first = next;
        next?.start();
      },
    };
  }
}
