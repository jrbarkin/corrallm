import type { SessionAnswer } from '../../shared/session';
import type { DriverIO, SessionDriver, Turn } from './driver';
import { play } from './player';
import type { Playback } from './player';
import { scriptedTurn } from './script';

/**
 * Drives a simulated agent's session: each turn is scripted (script.ts) and played in time
 * (player.ts), asking permission as the session's mode says, and not asking again about the
 * tools the user always allows.
 */
export class ScriptedDriver implements SessionDriver {
  readonly #io: DriverIO;
  #playback: Playback | undefined;

  constructor(io: DriverIO) {
    this.#io = io;
  }

  start(turn: Turn, done: (interrupted: boolean) => void): void {
    const io = this.#io;
    this.#playback = play(scriptedTurn(turn.text, turn.agent, io.session().mode, io.newId), {
      dispatch: io.dispatch,
      later: io.later,
      now: io.now,
      allowed: (tool) => io.session().allowed.includes(tool),
      newId: io.newId,
      done: (interrupted) => {
        this.#playback = undefined;
        // The next queued message starts first: one sent as the sender hears goes after it.
        io.idle();
        done(interrupted);
      },
    });
  }

  answer(id: string, answer: SessionAnswer): void {
    if (answer.kind === 'permission') this.#playback?.answer(id, answer.answer);
  }

  stop(): void {
    this.#playback?.stop();
  }

  setMode(): void {
    // The next turn's script follows the session's mode.
  }

  setModel(): void {
    // A scripted turn is the same whatever the model.
  }

  open(): void {
    // Nothing to start.
  }

  close(): void {
    this.#playback?.stop();
  }
}
