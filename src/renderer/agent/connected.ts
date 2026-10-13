import { CONNECTION_CLI, modeFor } from '../../shared/session';
import type {
  Connection,
  SessionAnswer,
  SessionEvent,
  SessionMode,
  SessionOptions,
  UserMessage,
} from '../../shared/session';
import { ipcErrorMessage } from '../ipc-error';
import type { DriverIO, SessionDriver, Turn } from './driver';
import { NEW_SESSION, reduce } from './session';
import type { Entry, Session } from './session';

/** What a connected session asks of the main process: window.api's session functions. */
export interface SessionBackend {
  start(agentId: string, options: SessionOptions): Promise<null>;
  send(agentId: string, message: UserMessage): Promise<null>;
  answer(agentId: string, promptId: string, answer: SessionAnswer): Promise<null>;
  interrupt(agentId: string): Promise<null>;
  setMode(agentId: string, mode: SessionMode): Promise<null>;
  setModel(agentId: string, model: string): Promise<null>;
  close(agentId: string): Promise<null>;
  /** The project folder's files and folders that match `query`, for an @-mention. */
  files(query: string): Promise<string[]>;
  /** Listens for what sessions do; returns a function that stops listening. */
  onEvent(
    listener: (agentId: string, connection: Connection, event: SessionEvent) => void,
  ): () => void;
}

/** Where there is no main process to run sessions (the editor alone, as in tests). */
export const NO_BACKEND: SessionBackend = (() => {
  const refuse = () =>
    Promise.reject(new Error('Connected sessions run only in the corrallm app.'));
  return {
    start: refuse,
    send: refuse,
    answer: refuse,
    interrupt: refuse,
    setMode: refuse,
    setModel: refuse,
    close: refuse,
    files: () => Promise.resolve([]),
    onEvent: () => () => undefined,
  };
})();

/** A turn it started: who hears when it ends, whether main has its message yet, and when. */
interface SentTurn {
  done: (interrupted: boolean) => void;
  sent: boolean;
  started: number;
}

/**
 * Drives a connected agent's session: one the main process runs (Claude Code or Codex, in a
 * terminal or through a structured interface; src/main/sessions/). It starts the session when first needed, sends each
 * turn's message, and plays the events main sends back (src/shared/session.ts) onto the session:
 * entries, prompts, status, mode and model, usage, and each turn's end. Mode and model changes,
 * answers and interrupts go to main.
 */
export class ConnectedDriver implements SessionDriver {
  readonly connection: Connection;
  readonly #agentId: string;
  readonly #backend: SessionBackend;
  readonly #io: DriverIO;
  /** Resolves once the session runs; undefined until it is started, and once it has stopped. */
  #running: Promise<void> | undefined;
  readonly #turns = new Map<string, SentTurn>();
  /** When each thinking entry began, by id: how long it thought. */
  readonly #thinking = new Map<string, number>();
  #closed = false;

  constructor(agentId: string, connection: Connection, backend: SessionBackend, io: DriverIO) {
    this.#agentId = agentId;
    this.connection = connection;
    this.#backend = backend;
    this.#io = io;
  }

  open(): void {
    this.#run().catch((error: unknown) => {
      this.#notice('error', ipcErrorMessage(error));
    });
  }

  start(turn: Turn, done: (interrupted: boolean) => void): void {
    const sent: SentTurn = { done, sent: false, started: this.#io.now() };
    this.#turns.set(turn.id, sent);
    this.#run()
      .then(() => {
        // Stopped before it went: it never does.
        if (!this.#turns.has(turn.id)) return null;
        sent.sent = true;
        const { id, text, images } = turn;
        return this.#backend.send(this.#agentId, {
          id,
          text,
          ...(images === undefined || images.length === 0 ? {} : { images }),
        });
      })
      .catch((error: unknown) => {
        if (!this.#turns.has(turn.id)) return;
        this.#notice('error', ipcErrorMessage(error));
        this.#end([turn.id], { interrupted: false, failed: true });
      });
  }

  answer(id: string, answer: SessionAnswer): void {
    // A question's answers are recorded one by one by the store; the others here.
    if (answer.kind === 'permission') {
      this.#io.dispatch({ type: 'answer', id, answer: answer.answer });
    } else if (answer.kind === 'plan') {
      this.#io.dispatch({ type: 'answerPlan', id, answer: answer.answer });
    }
    this.#tell((agentId) => this.#backend.answer(agentId, id, answer));
  }

  stop(): void {
    const unsent = [...this.#turns].flatMap(([id, turn]) => (turn.sent ? [] : [id]));
    if (unsent.length > 0) {
      this.#end(unsent, { interrupted: true, failed: false });
      return;
    }
    // Main ends the turn, with an 'end' that says it was interrupted.
    this.#tell((agentId) => this.#backend.interrupt(agentId));
  }

  setMode(mode: SessionMode): void {
    // Not started yet: it starts in the session's mode.
    this.#tell((agentId) => this.#backend.setMode(agentId, mode));
  }

  setModel(model: string): void {
    this.#tell((agentId) => this.#backend.setModel(agentId, model));
  }

  close(): void {
    this.#closed = true;
    if (this.#turns.size > 0 || this.#io.session().status !== 'idle') {
      this.#end([...this.#turns.keys()], { interrupted: true, failed: false });
    }
    if (this.#running) {
      this.#running = undefined;
      // It is going either way.
      this.#backend.close(this.#agentId).catch(() => undefined);
    }
  }

  /** Plays an event from main onto the session. */
  receive(event: SessionEvent): void {
    const io = this.#io;
    const find = (id: string) => io.session().entries.find((entry) => entry.id === id);
    const parent = (p: string | undefined) => (p === undefined ? {} : { parent: p });
    switch (event.type) {
      case 'started':
        io.dispatch({
          type: 'connected',
          models: event.models,
          model: event.model,
          mode: event.mode,
        });
        return;
      case 'commands':
        io.dispatch({ type: 'commands', commands: event.commands });
        return;
      case 'history': {
        // Shown already (the session was resumed after it closed): not again.
        const shown = new Set(io.session().entries.map((entry) => entry.id));
        const entries = replay(event.events, this.#agentId, this.connection);
        if (entries.length === 0 || entries.some((entry) => shown.has(entry.id))) return;
        io.dispatch({ type: 'restore', entries });
        return;
      }
      case 'user':
        if (!find(event.id)) {
          io.dispatch({ type: 'start', entry: { id: event.id, kind: 'user', text: event.text } });
        }
        return;
      case 'status':
        io.dispatch({ type: 'status', status: event.status });
        return;
      case 'text':
        if (find(event.id)) io.dispatch({ type: 'stream', id: event.id, text: event.text });
        else {
          io.dispatch({
            type: 'add',
            entry: { id: event.id, kind: 'text', text: event.text, ...parent(event.parent) },
          });
        }
        return;
      case 'thinking': {
        const began = this.#thinking.get(event.id) ?? io.now();
        this.#thinking.set(event.id, began);
        const seconds = Math.max(1, Math.round((io.now() - began) / 1000));
        if (find(event.id)) {
          io.dispatch({ type: 'stream', id: event.id, text: event.text });
          io.dispatch({
            type: 'update',
            id: event.id,
            update: (entry) => (entry.kind === 'thinking' ? { ...entry, seconds } : entry),
          });
        } else {
          io.dispatch({
            type: 'add',
            entry: {
              id: event.id,
              kind: 'thinking',
              text: event.text,
              seconds,
              ...parent(event.parent),
            },
          });
        }
        return;
      }
      case 'tool': {
        const { id, tool, summary, status, detail } = event;
        this.#put({
          id,
          kind: 'tool',
          tool,
          summary,
          status,
          ...(detail === undefined ? {} : { detail }),
          ...parent(event.parent),
        });
        return;
      }
      case 'todos':
        this.#put({ id: event.id, kind: 'todos', items: event.items });
        return;
      case 'permission': {
        const { id, tool, summary, always, detail, title } = event;
        io.dispatch({
          type: 'ask',
          entry: {
            id,
            kind: 'permission',
            tool,
            summary,
            always,
            ...(detail === undefined ? {} : { detail }),
            ...(title === undefined ? {} : { title }),
          },
        });
        return;
      }
      case 'question':
        io.dispatch({
          type: 'ask',
          entry: {
            id: event.id,
            kind: 'question',
            questions: event.questions.map((q) => ({ ...q })),
          },
        });
        return;
      case 'plan':
        io.dispatch({ type: 'ask', entry: { id: event.id, kind: 'plan', plan: event.plan } });
        return;
      case 'withdrawn':
        io.dispatch({ type: 'withdraw', id: event.id });
        return;
      case 'notice':
        io.dispatch({
          type: 'add',
          entry: { id: event.id, kind: 'notice', level: event.level, text: event.text },
        });
        return;
      case 'usage':
        io.dispatch({ type: 'usage', usage: event.usage });
        return;
      case 'mode':
        io.dispatch({ type: 'mode', mode: event.mode });
        return;
      case 'model':
        io.dispatch({ type: 'model', model: event.model });
        return;
      case 'end':
        this.#end(event.messages, event);
        return;
      case 'closed':
        this.#running = undefined;
        if (event.error !== undefined) this.#notice('error', event.error);
        if (this.#turns.size > 0 || io.session().status !== 'idle') {
          this.#end([...this.#turns.keys()], {
            interrupted: event.error === undefined,
            failed: event.error !== undefined,
          });
        }
        return;
    }
  }

  /** Starts the session, if it does not run yet. */
  #run(): Promise<void> {
    if (this.#closed) return Promise.reject(new Error('This session was closed.'));
    if (!this.#running) {
      const { mode, model, models } = this.#io.session();
      const running = this.#backend
        .start(this.#agentId, {
          connection: this.connection,
          // A model it offered before; otherwise the CLI's default.
          model: models?.some((m) => m.value === model) ? model : null,
          // One of its CLI's modes (the session may have been another CLI's before).
          mode: modeFor(CONNECTION_CLI[this.connection], mode),
        })
        .then(() => undefined);
      running.catch(() => {
        // Not started: the next message tries again.
        if (this.#running === running) this.#running = undefined;
      });
      this.#running = running;
    }
    return this.#running;
  }

  /** Asks main something of the running session, if it runs; says so if that fails. */
  #tell(ask: (agentId: string) => Promise<null>): void {
    this.#running
      ?.then(() => ask(this.#agentId))
      .catch((error: unknown) => {
        this.#notice('error', ipcErrorMessage(error));
      });
  }

  /** Adds an entry, or replaces the one with its id. */
  #put(entry: Entry): void {
    if (this.#io.session().entries.some((e) => e.id === entry.id)) {
      this.#io.dispatch({ type: 'update', id: entry.id, update: () => entry });
    } else {
      this.#io.dispatch({ type: 'add', entry });
    }
  }

  /** Tells the user something, unless it is what the transcript last said. */
  #notice(level: 'info' | 'warning' | 'error', text: string): void {
    const last = this.#io.session().entries.at(-1);
    if (last?.kind === 'notice' && last.level === level && last.text === text) return;
    this.#io.dispatch({
      type: 'add',
      entry: { id: this.#io.newId(), kind: 'notice', level, text },
    });
  }

  /** Ends the turn of messages `ids`: the session is idle, and whoever sent them hears. */
  #end(
    ids: readonly string[],
    { interrupted, failed, seconds }: { interrupted: boolean; failed: boolean; seconds?: number },
  ): void {
    const io = this.#io;
    const turns = ids.flatMap((id) => {
      const turn = this.#turns.get(id);
      this.#turns.delete(id);
      return turn ? [turn] : [];
    });
    if (turns.length === 0 && io.session().status === 'idle') return;
    const since = turns[0]?.started ?? io.now();
    io.dispatch({
      type: 'end',
      id: io.newId(),
      seconds: seconds ?? Math.max(1, Math.round((io.now() - since) / 1000)),
      interrupted,
      ...(failed ? { failed: true } : {}),
    });
    // The next queued message starts first: one sent as the sender hears goes after it.
    io.idle();
    for (const turn of turns) turn.done(interrupted || failed);
  }
}

/** The entries a resumed session's past events make, played onto a session of their own. */
function replay(events: readonly SessionEvent[], agentId: string, connection: Connection): Entry[] {
  let session: Session = NEW_SESSION;
  const driver = new ConnectedDriver(agentId, connection, NO_BACKEND, {
    dispatch: (action) => {
      session = reduce(session, action);
    },
    session: () => session,
    idle: () => undefined,
    newId: () => crypto.randomUUID(),
    now: () => 0,
    later: () => () => undefined,
  });
  for (const event of events) if (event.type !== 'history') driver.receive(event);
  return session.entries;
}
