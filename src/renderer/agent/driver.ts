import type { EffortLevel, MessageImage, SessionAnswer } from '../../shared/session';
import type { AgentType } from '../graph/agents';
import type { Mode, Session, SessionAction } from './session';

/*
 * What drives an agent's session. The store (sessions.ts) keeps every session and what is queued,
 * and decides when a turn starts; a driver plays each turn onto the session through `dispatch`:
 * the scripted driver (scripted.ts) for a simulated agent, the connected driver (connected.ts) for
 * one that runs the real CLI in the main process. Whatever drives a turn, it ends with an 'end'
 * action, then `idle()`, then the turn's `done`.
 */

/**
 * A turn the store starts: the user's message (its entry's id) and the images pasted into it, to
 * an agent of type `agent`.
 */
export interface Turn {
  id: string;
  text: string;
  images?: MessageImage[];
  agent: AgentType;
}

export interface SessionDriver {
  /** Starts a turn; `done` hears when it ends (true if it was interrupted, or failed). */
  start(turn: Turn, done: (interrupted: boolean) => void): void;
  /** Passes on the user's answer to the prompt `id`, once it is complete. */
  answer(id: string, answer: SessionAnswer): void;
  /** Interrupts the turn going on, if any, as Escape does in Claude Code. */
  stop(): void;
  /** The user switched mode, model or effort: the store has already recorded it. */
  setMode(mode: Mode): void;
  setModel(model: string): void;
  setEffort(effort: EffortLevel | null): void;
  /** Stops a task the session runs in the background (one its `tasks` lists). */
  stopTask(taskId: string): void;
  /** Makes sure the session runs, as when its view opens: a connected one starts or resumes. */
  open(): void;
  /** Lets the session go, for another driver or none: a turn going on ends, interrupted. */
  close(): void;
}

/** What a driver needs from the store. */
export interface DriverIO {
  dispatch: (action: SessionAction) => void;
  /** The session as it is now. */
  session: () => Session;
  /** The session is idle again: the store starts the next queued message, if any. */
  idle: () => void;
  newId: () => string;
  now: () => number;
  /** Runs `run` in `ms`; returns a function that cancels it. */
  later: (run: () => void, ms: number) => () => void;
}
