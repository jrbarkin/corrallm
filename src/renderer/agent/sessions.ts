import { DEFAULT_AGENT } from '../graph/agents';
import type { AgentConnection, AgentType } from '../graph/agents';
import { ConnectedDriver, NO_BACKEND } from './connected';
import type { SessionBackend } from './connected';
import type { DriverIO, SessionDriver } from './driver';
import { ScriptedDriver } from './scripted';
import { answersOf, NEW_SESSION, reduce } from './session';
import type { Answer, MessageImage, Mode, PlanAnswer, Session, SessionAction } from './session';

/** An agent's driver, how it runs, and whether it is being let go. */
interface Driving {
  connection: AgentConnection;
  driver: SessionDriver;
  closing: boolean;
}

/**
 * Every agent's session, by agent id, outside React (components read it with
 * useSyncExternalStore), so that turns keep playing while their agent's view is closed. Each
 * agent's session is driven by a driver (driver.ts) as the agent runs: scripted when simulated
 * (scripted.ts), or connected to a session in the main process (connected.ts, through
 * `backend`). A message sent while an agent works is queued, and sent once the turn ends,
 * interrupted or not. Whoever sends a message can hear when the turn it starts ends (the queues'
 * run, run/runner.ts).
 */
export class SessionStore {
  #sessions: Readonly<Record<string, Session>> = {};
  readonly #listeners = new Set<() => void>();
  readonly #backend: SessionBackend;
  readonly #drivers = new Map<string, Driving>();
  /** How each agent runs, as the canvas last said (`sync`). */
  readonly #connections = new Map<string, AgentConnection>();
  /** Each agent's type, as it was last sent a message: what its scripted turns are like. */
  readonly #types = new Map<string, AgentType>();
  /** Who to tell when the turn a queued message starts ends, by the queued message's id. */
  readonly #onDone = new Map<string, (interrupted: boolean) => void>();
  #unsubscribe: (() => void) | undefined;

  constructor(backend: SessionBackend = NO_BACKEND) {
    this.#backend = backend;
  }

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
   * The agents on the canvas, and how each runs. The session of an agent that is gone ends and is
   * forgotten; one whose agent runs another way now ends its turn and goes on with a new driver.
   */
  sync(agents: readonly { id: string; connection: AgentConnection }[]): void {
    const wanted = new Map(agents.map(({ id, connection }) => [id, connection]));
    const known = new Set([...Object.keys(this.#sessions), ...this.#drivers.keys()]);
    for (const id of known) if (!wanted.has(id)) this.#forget(id);
    for (const id of this.#connections.keys()) if (!wanted.has(id)) this.#connections.delete(id);
    for (const [id, connection] of wanted) {
      this.#connections.set(id, connection);
      const driving = this.#drivers.get(id);
      if (driving && driving.connection !== connection) {
        this.#letGo(id);
        this.#idle(id);
      }
    }
  }

  /** Makes sure the agent's session runs, as when its view opens. */
  open(agentId: string): void {
    this.#driver(agentId).open();
  }

  /**
   * Sends the user's message (with the images pasted into it): a new turn, or queued while one is
   * going on. `onDone` hears when that turn ends (`interrupted` too if the message is taken off the
   * queue before it is sent, or the turn failed).
   */
  send(
    agentId: string,
    agent: AgentType,
    text: string,
    onDone?: (interrupted: boolean) => void,
    images?: MessageImage[],
  ): void {
    this.#types.set(agentId, agent);
    if (this.of(agentId).status === 'idle') {
      this.#start(agentId, agent, { text, images }, onDone);
      return;
    }
    const id = crypto.randomUUID();
    if (onDone) this.#onDone.set(id, onDone);
    this.#dispatch(agentId, {
      type: 'queue',
      id,
      text,
      ...(images === undefined || images.length === 0 ? {} : { images }),
    });
  }

  /** The files and folders of the canvas's project folder that match `query`, for an @-mention. */
  findFiles(query: string): Promise<string[]> {
    return this.#backend.files(query);
  }

  /** Answers a permission prompt. */
  answer(agentId: string, permissionId: string, answer: Answer): void {
    this.#drivers.get(agentId)?.driver.answer(permissionId, { kind: 'permission', answer });
  }

  /** Answers one of the questions of a question prompt; once all have answers, they go. */
  answerQuestion(agentId: string, promptId: string, index: number, answer: string): void {
    this.#dispatch(agentId, { type: 'answerQuestion', id: promptId, index, answer });
    const answers = answersOf(this.of(agentId), promptId);
    if (answers) {
      this.#drivers.get(agentId)?.driver.answer(promptId, { kind: 'question', answers });
    }
  }

  /** Approves a plan, or not. */
  answerPlan(agentId: string, promptId: string, answer: PlanAnswer): void {
    this.#drivers.get(agentId)?.driver.answer(promptId, { kind: 'plan', answer });
  }

  /** Interrupts the turn going on, if any. */
  stop(agentId: string): void {
    this.#drivers.get(agentId)?.driver.stop();
  }

  unqueue(agentId: string, queuedId: string): void {
    this.#dispatch(agentId, { type: 'unqueue', id: queuedId });
    const onDone = this.#onDone.get(queuedId);
    this.#onDone.delete(queuedId);
    onDone?.(true);
  }

  setMode(agentId: string, mode: Mode): void {
    this.#dispatch(agentId, { type: 'mode', mode });
    this.#drivers.get(agentId)?.driver.setMode(mode);
  }

  setModel(agentId: string, model: string): void {
    this.#dispatch(agentId, { type: 'model', model });
    this.#drivers.get(agentId)?.driver.setModel(model);
  }

  /** Forgets every session, as for another canvas: turns going on end, connected ones close. */
  reset(): void {
    for (const id of [...this.#drivers.keys()]) this.#letGo(id);
    for (const onDone of this.#onDone.values()) onDone(true);
    this.#onDone.clear();
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#sessions = {};
    this.#notify();
  }

  #start(
    agentId: string,
    agent: AgentType,
    { text, images }: { text: string; images: MessageImage[] | undefined },
    onDone?: (interrupted: boolean) => void,
  ): void {
    const id = crypto.randomUUID();
    const pasted = images === undefined || images.length === 0 ? {} : { images };
    this.#dispatch(agentId, { type: 'start', entry: { id, kind: 'user', text, ...pasted } });
    this.#driver(agentId).start({ id, text, agent, ...pasted }, (interrupted) =>
      onDone?.(interrupted),
    );
  }

  /** The session is idle: its next queued message, if any, starts. */
  #idle(agentId: string): void {
    const session = this.of(agentId);
    const [next] = session.queued;
    if (!next || session.status !== 'idle') return;
    const onDone = this.#onDone.get(next.id);
    this.#onDone.delete(next.id);
    this.#dispatch(agentId, { type: 'unqueue', id: next.id });
    this.#start(
      agentId,
      this.#types.get(agentId) ?? DEFAULT_AGENT,
      { text: next.text, images: next.images },
      onDone,
    );
  }

  /** The agent's driver, made as the agent runs if it has none. */
  #driver(agentId: string): SessionDriver {
    const existing = this.#drivers.get(agentId);
    if (existing) return existing.driver;
    const connection = this.#connections.get(agentId) ?? 'simulated';
    // The driver's io needs its entry, and the driver its io.
    const driving = { connection, closing: false } as Driving;
    const io = this.#io(agentId, driving);
    if (connection === 'simulated') {
      driving.driver = new ScriptedDriver(io);
    } else {
      this.#listen();
      driving.driver = new ConnectedDriver(agentId, connection, this.#backend, io);
    }
    this.#drivers.set(agentId, driving);
    return driving.driver;
  }

  /**
   * What a driver is given. A driver let go may still end its turn, but starts nothing more; once
   * gone, it is not heard at all.
   */
  #io(agentId: string, driving: Driving): DriverIO {
    const current = () => this.#drivers.get(agentId) === driving;
    return {
      dispatch: (action) => {
        if (current()) this.#dispatch(agentId, action);
      },
      session: () => this.of(agentId),
      idle: () => {
        if (current() && !driving.closing) this.#idle(agentId);
      },
      newId: () => crypto.randomUUID(),
      now: () => Date.now(),
      later: (run, ms) => {
        const timer = setTimeout(run, ms);
        return () => {
          clearTimeout(timer);
        };
      },
    };
  }

  /** Hears connected sessions' events, from the first connected driver on. */
  #listen(): void {
    this.#unsubscribe ??= this.#backend.onEvent((agentId, connection, event) => {
      const driving = this.#drivers.get(agentId);
      if (driving?.driver instanceof ConnectedDriver && driving.connection === connection) {
        driving.driver.receive(event);
      }
    });
  }

  /** Lets the agent's driver go: its turn ends, and a connected session closes. */
  #letGo(agentId: string): void {
    const driving = this.#drivers.get(agentId);
    if (!driving) return;
    driving.closing = true;
    driving.driver.close();
    this.#drivers.delete(agentId);
  }

  /** The agent is gone: its session ends, and whoever waits on its queued messages hears. */
  #forget(agentId: string): void {
    this.#letGo(agentId);
    for (const { id } of this.of(agentId).queued) {
      const onDone = this.#onDone.get(id);
      this.#onDone.delete(id);
      onDone?.(true);
    }
    this.#sessions = Object.fromEntries(
      Object.entries(this.#sessions).filter(([id]) => id !== agentId),
    );
    this.#types.delete(agentId);
    this.#notify();
  }

  #dispatch(agentId: string, action: SessionAction): void {
    this.#sessions = { ...this.#sessions, [agentId]: reduce(this.of(agentId), action) };
    this.#notify();
  }

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }
}
