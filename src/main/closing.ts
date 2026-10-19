/*
 * Quitting, or closing a window: first the run is saved (each renderer freezes it, the core
 * journals it). If that fails, the user is asked whether to close
 * anyway, losing what wasn't saved, or keep the app open and try again later; asking to close again
 * while it saves closes at once, as a way out of a save that hangs.
 */

export interface ClosingDeps {
  /** Saves the run while keeping the core usable: rejects saying why it could not. */
  save: () => Promise<void>;
  /** Closes what it can without saving (the sessions, the stores): never rejects. */
  abandon: () => Promise<void>;
  /** Asks whether to close anyway, saying why saving failed: true if the user says so. */
  ask: (why: string) => Promise<boolean>;
  /** Closes: quits the app, or closes the window. */
  done: () => void;
}

export class Closing {
  readonly #deps: ClosingDeps;
  #state: 'open' | 'saving' | 'asking' | 'closing' = 'open';

  constructor(deps: ClosingDeps) {
    this.#deps = deps;
  }

  /** Whether it is saving, or asking what to do after it could not. */
  get busy(): boolean {
    return this.#state === 'saving' || this.#state === 'asking';
  }

  /** Whether it may close now: once true, closing goes through. */
  get approved(): boolean {
    return this.#state === 'closing';
  }

  /** Asked to close: true if it may close now; otherwise it saves first, then closes itself. */
  request(): boolean {
    switch (this.#state) {
      case 'closing':
        return true;
      case 'saving':
        void this.#close(this.#deps.abandon());
        return false;
      case 'asking':
        return false;
      case 'open':
        this.#state = 'saving';
        this.#deps.save().then(
          () => {
            void this.#close(Promise.resolve());
          },
          (error: unknown) => {
            void this.#failed(error);
          },
        );
        return false;
    }
  }

  async #failed(error: unknown): Promise<void> {
    if (this.#state !== 'saving') return;
    this.#state = 'asking';
    // While it asks, nothing else closes it (request() waits for the answer).
    const anyway = await this.#deps
      .ask(error instanceof Error ? error.message : String(error))
      .catch(() => false);
    if (anyway) await this.#close(this.#deps.abandon());
    else this.#state = 'open';
  }

  async #close(closed: Promise<void>): Promise<void> {
    if (this.#state === 'closing') return;
    this.#state = 'closing';
    await closed;
    this.#deps.done();
  }
}
