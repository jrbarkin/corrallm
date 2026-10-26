import type { DriverIO, SessionDriver, Turn } from './driver';

const UNAVAILABLE =
  'This agent has no supported connection yet. Choose Claude or Codex and a native connection to run this work.';

/** Unsupported agents keep work unsent; no turn, tool activity, or completion is fabricated. */
export class UnavailableDriver implements SessionDriver {
  readonly #io: DriverIO;

  constructor(io: DriverIO) {
    this.#io = io;
  }

  start(turn: Turn): void {
    this.open();
    this.#io.refused(turn.id, { text: UNAVAILABLE });
  }

  open(): void {
    this.#io.dispatch({
      type: 'add',
      entry: { id: this.#io.newId(), kind: 'notice', level: 'error', text: UNAVAILABLE },
    });
  }

  answer(): void {
    /* No native prompt exists. */
  }
  stop(): void {
    /* Unsent messages are withdrawn by the store. */
  }
  setMode(): void {
    /* There is no native session to configure. */
  }
  setModel(): void {
    /* There is no native session to configure. */
  }
  setEffort(): void {
    /* There is no native session to configure. */
  }
  stopTask(): void {
    /* No background task exists. */
  }
  close(): void {
    /* No native process was started. */
  }
}
