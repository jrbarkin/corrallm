import type { MessagePortMain } from 'electron';

import type { WindowId } from '../core/host';
import { ProfileLocked } from '../core/lock';
import type { CoreProcess } from './core-process';
import { RESTARTS, supervise } from './supervise';
import type { Supervision, SupervisionAction } from './supervise';

/*
 * The core process, supervised (Core Server §7.5): main forks it and asks it up. Once it is up, an
 * exit main didn't ask for is a crash, and supervise.ts's policy says what to do: fork a new core
 * and ask it up, as the next epoch (which every window's port names), or give up once it has
 * restarted RESTARTS times within WINDOW_MS. A new core that can't come up counts as another stop,
 * except one refused the profile (`corrallm serve` took it meanwhile), which gives up at once.
 * What asks the core goes to the one up now, and waits while a new one comes up.
 */

export interface SupervisorOptions {
  /** Forks a core process. */
  fork: () => CoreProcess;
  /** Asks a forked core up: rejects, saying why, if it can't come up (ProfileLocked, …). */
  init: (core: CoreProcess) => Promise<void>;
  /**
   * A new core is coming up, and why: the core stopped (a crash), or the last new one couldn't
   * come up.
   */
  restarting: (why: string) => void;
  /** A new core is up in place of one that crashed, as `epoch`: windows reconnect to it. */
  restarted: (epoch: number) => void;
  /** Main gives up on the core, saying why: it keeps stopping, or a new one can't hold the profile. */
  gaveUp: (why: Error) => void;
  /** The clock the policy reads (ms). */
  now?: () => number;
}

export class CoreSupervisor {
  readonly #options: SupervisorOptions;
  readonly #now: () => number;
  #supervision: Supervision = { restarts: [] };
  #epoch = 1;
  /** The core up now, or the one coming up; rejected once main gives up. */
  #current = Promise.withResolvers<CoreProcess>();
  /** Whether main stopped it (the app quits): an exit then is no crash. */
  #stopping = false;

  constructor(options: SupervisorOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    // Main may give up with nothing asking the core meanwhile.
    this.#current.promise.catch(() => undefined);
  }

  /** Which core a port made now reaches: each new core is the next. */
  get epoch(): number {
    return this.#epoch;
  }

  /** The core up now, or once a new one is up; rejects once main gives up on it. */
  get core(): Promise<CoreProcess> {
    return this.#current.promise;
  }

  /** Forks the first core and asks it up: rejects, saying why, if it can't come up. */
  async start(): Promise<void> {
    this.#up(await this.#bringUp());
  }

  /** Main is done with the core (the app quits): no exit from now on restarts it. */
  stop(): void {
    this.#stopping = true;
  }

  /** Hands the core `window`'s end of its port, once a core is up. */
  connect(window: WindowId, port: MessagePortMain): void {
    void this.core.then(
      (core) => {
        core.connect(window, port);
      },
      () => undefined,
    );
  }

  /** Tells the core `window` is gone, once a core is up. */
  windowGone(window: WindowId, closed?: boolean): void {
    void this.core.then(
      (core) => {
        if (closed === undefined) core.windowGone(window);
        else core.windowGone(window, closed);
      },
      () => undefined,
    );
  }

  /** Forks a core and asks it up; one that can't come up is killed. */
  async #bringUp(): Promise<CoreProcess> {
    const core = this.#options.fork();
    try {
      await this.#options.init(core);
    } catch (error) {
      core.kill();
      throw error;
    }
    return core;
  }

  /** `core` is up: what waited for it goes to it, and its exit is watched. */
  #up(core: CoreProcess): void {
    this.#current.resolve(core);
    void core.exited.then((code) => this.#exited(code));
  }

  async #exited(code: number): Promise<void> {
    if (this.#stopping) return;
    let action = this.#decide(code);
    // A clean exit (the core was asked to stop) is no crash: nothing to restart.
    if (action === 'none') return;
    // What asks the core from now on waits for the next one, the next epoch.
    this.#current = Promise.withResolvers<CoreProcess>();
    this.#current.promise.catch(() => undefined);
    this.#epoch++;
    let why = `the core process stopped (code ${String(code)})`;
    while (action === 'restart') {
      this.#options.restarting(why);
      let core: CoreProcess;
      try {
        core = await this.#bringUp();
      } catch (error) {
        if (error instanceof ProfileLocked) {
          this.#giveUp(error);
          return;
        }
        if (this.#stopped()) {
          // The app quit meanwhile: what still asks the core fails rather than waits.
          this.#current.reject(new Error('corrallm’s core stopped.'));
          return;
        }
        why = `the new core couldn’t come up (${error instanceof Error ? error.message : String(error)})`;
        action = this.#decide(1);
        continue;
      }
      this.#up(core);
      if (!this.#stopped()) this.#options.restarted(this.#epoch);
      return;
    }
    this.#giveUp(
      new Error(
        `corrallm’s core keeps stopping: it stopped ${String(RESTARTS + 1)} times within a minute.`,
      ),
    );
  }

  /** Asks the policy what to do about a stop with `code` now, remembering what it counted. */
  #decide(code: number): SupervisionAction {
    const { action, next } = supervise(this.#supervision, code, this.#now());
    this.#supervision = next;
    return action;
  }

  /** Whether main stopped it, read afresh: it may have, while a new core came up. */
  #stopped(): boolean {
    return this.#stopping;
  }

  #giveUp(why: Error): void {
    this.#current.reject(why);
    this.#options.gaveUp(why);
  }
}
