import type { AgentType } from '../graph/agents';
import { play } from './player';
import type { Playback } from './player';
import { scriptedTurn } from './script';
import { NEW_SESSION, reduce } from './session';
import type { Answer, Mode, Session, SessionAction } from './session';

/**
 * Every agent's session, by agent id, outside React (components read it with
 * useSyncExternalStore), so that turns keep playing while their agent's view is closed. Turns are
 * scripted for now (script.ts). A message sent while an agent works is queued, and sent once the
 * turn ends, interrupted or not. Whoever sends a message can hear when the turn it starts ends
 * (the queues' run, run/runner.ts).
 */
export class SessionStore {
  #sessions: Readonly<Record<string, Session>> = {};
  readonly #listeners = new Set<() => void>();
  readonly #playing = new Map<string, Playback>();
  /** Who to tell when the turn a queued message starts ends, by the queued message's id. */
  readonly #onDone = new Map<string, (interrupted: boolean) => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** Every session, by agent id: a new object after each change. */
  snapshot = (): Readonly<Record<string, Session>> => this.#sessions;

  of(agentId: string): Session {
    return this.#sessions[agentId] ?? NEW_SESSION;
  }

  /**
   * Sends the user's message: a new turn, or queued while one is going on. `onDone` hears when that
   * turn ends (`interrupted` too if the message is taken off the queue before it is sent).
   */
  send(
    agentId: string,
    agent: AgentType,
    text: string,
    onDone?: (interrupted: boolean) => void,
  ): void {
    if (this.of(agentId).status === 'idle') {
      this.#start(agentId, agent, text, onDone);
      return;
    }
    const id = crypto.randomUUID();
    if (onDone) this.#onDone.set(id, onDone);
    this.#dispatch(agentId, { type: 'queue', id, text });
  }

  answer(agentId: string, permissionId: string, answer: Answer): void {
    this.#playing.get(agentId)?.answer(permissionId, answer);
  }

  /** Interrupts the turn going on, if any. */
  stop(agentId: string): void {
    this.#playing.get(agentId)?.stop();
  }

  unqueue(agentId: string, queuedId: string): void {
    this.#dispatch(agentId, { type: 'unqueue', id: queuedId });
    const onDone = this.#onDone.get(queuedId);
    this.#onDone.delete(queuedId);
    onDone?.(true);
  }

  setMode(agentId: string, mode: Mode): void {
    this.#dispatch(agentId, { type: 'mode', mode });
  }

  setModel(agentId: string, model: string): void {
    this.#dispatch(agentId, { type: 'model', model });
  }

  #start(
    agentId: string,
    agent: AgentType,
    text: string,
    onDone?: (interrupted: boolean) => void,
  ): void {
    const { mode } = this.of(agentId);
    const newId = () => crypto.randomUUID();
    this.#dispatch(agentId, { type: 'start', entry: { id: newId(), kind: 'user', text } });
    const playback = play(scriptedTurn(text, agent, mode, newId), {
      dispatch: (action) => {
        this.#dispatch(agentId, action);
      },
      later: (run, ms) => {
        const timer = setTimeout(run, ms);
        return () => {
          clearTimeout(timer);
        };
      },
      now: () => Date.now(),
      allowed: (tool) => this.of(agentId).allowed.includes(tool),
      newId,
      done: (interrupted) => {
        this.#playing.delete(agentId);
        // The next queued message starts first: one sent as the sender hears goes after it.
        const [next] = this.of(agentId).queued;
        if (next) {
          const nextDone = this.#onDone.get(next.id);
          this.#onDone.delete(next.id);
          this.#dispatch(agentId, { type: 'unqueue', id: next.id });
          this.#start(agentId, agent, next.text, nextDone);
        }
        onDone?.(interrupted);
      },
    });
    this.#playing.set(agentId, playback);
  }

  #dispatch(agentId: string, action: SessionAction): void {
    this.#sessions = { ...this.#sessions, [agentId]: reduce(this.of(agentId), action) };
    for (const listener of this.#listeners) listener();
  }
}
