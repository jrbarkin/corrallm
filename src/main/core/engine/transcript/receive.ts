import type { SessionAvailability } from '../../../../shared/session';
import type { AdapterId, ConnectionId } from '../../../../shared/adapter';
import { isSessionMode } from '../../../../shared/session';
import type {
  AgentStartSettings,
  FilesRewind,
  InstalledClis,
  McpChange,
  McpServer,
  PastSession,
  RewindRestore,
  RewindResult,
  SessionAnswer,
  SessionEvent,
  SessionMode,
  SessionOptions,
  SettingsOptions,
  UserMessage,
  TurnResult,
} from '../../../../shared/session';
import type { EngineCatalog } from '../../../../shared/model/catalog';
import type { DriverDone, DriverIO, SessionDriver, Turn } from './driver';
import { NEW_SESSION } from '../../../../shared/model/session';
import { reduce } from './reduce';
import type { Entry, Refusal, Session } from '../../../../shared/model/session';

/**
 * What a connected session asks of whoever runs sessions: main's SessionManager, over IPC in the
 * app (window.api's session functions) or in the same process in the core. A call that fails
 * rejects with an Error saying why, in words fit to show.
 */
export interface SessionBackend {
  availability?(agentId: string): Promise<SessionAvailability>;
  onAvailability?(listener: () => void): () => void;
  start(agentId: string, options: SessionOptions): Promise<null>;
  /** Which CLIs the user has (main finds them as its connections would run them). */
  installed(): Promise<InstalledClis>;
  send(agentId: string, message: UserMessage): Promise<null>;
  answer(agentId: string, promptId: string, answer: SessionAnswer): Promise<null>;
  interrupt(agentId: string): Promise<null>;
  setMode(agentId: string, mode: SessionMode): Promise<null>;
  setModel(agentId: string, model: string): Promise<null>;
  setEffort(agentId: string, effort: string | null): Promise<null>;
  stopTask(agentId: string, taskId: string): Promise<null>;
  close(agentId: string): Promise<null>;
  /** Ends the agent's live session and forgets only this CLI's remembered conversation. */
  fresh(agentId: string, adapter: AdapterId): Promise<null>;
  /** The project folder's files and folders that match `query`, for an @-mention. */
  files(query: string, agentId?: string): Promise<string[]>;
  /** What an agent of `adapter` can be set to run with, and the user's own defaults (session:options). */
  options(adapter: AdapterId, agentId?: string): Promise<SettingsOptions>;
  /** The conversations Claude Code kept for the project folder (/resume), the agent's marked. */
  sessions(agentId: string): Promise<PastSession[]>;
  /** Makes one of them the agent's own: its session ends, and resumes it when it starts again. */
  resume(agentId: string, sessionId: string): Promise<null>;
  /** What restoring the agent's files to before one of its messages would change. */
  previewRewind(agentId: string, messageId: string): Promise<FilesRewind>;
  /**
   * Rewinds the agent's session to before one of its messages: files, conversation, or both
   * (its session then ends, to resume a copy of the conversation up to there).
   */
  rewind(agentId: string, messageId: string, restore: RewindRestore): Promise<RewindResult>;
  /** The MCP servers of the agent's running session (/mcp). */
  mcp(agentId: string): Promise<McpServer[]>;
  /** Reconnects, enables or disables one of them; resolves with them all as they are then. */
  changeMcp(agentId: string, server: string, change: McpChange): Promise<McpServer[]>;
  /** Listens for what sessions do; returns a function that stops listening. */
  onEvent(
    listener: (agentId: string, connection: ConnectionId, event: SessionEvent) => void,
  ): () => void;
}

/** Where there is no main process to run sessions (the editor alone, as in tests). */
export const NO_BACKEND: SessionBackend = (() => {
  const refuse = () =>
    Promise.reject(new Error('Connected sessions run only in the corrallm app.'));
  return {
    start: refuse,
    installed: () => Promise.resolve({ claude: false, codex: false }),
    send: refuse,
    answer: refuse,
    interrupt: refuse,
    setMode: refuse,
    setModel: refuse,
    setEffort: refuse,
    stopTask: refuse,
    close: refuse,
    fresh: refuse,
    files: () => Promise.resolve([]),
    options: refuse,
    sessions: refuse,
    resume: refuse,
    previewRewind: refuse,
    rewind: refuse,
    mcp: refuse,
    changeMcp: refuse,
    onEvent: () => () => undefined,
  };
})();

/** Why a call to whoever runs sessions failed, as it said. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

/** A turn it started: who hears when it ends, whether main has its message yet, and when. */
interface SentTurn {
  done: DriverDone;
  sent: boolean;
  started: number;
}

/**
 * Drives a connected agent's session: one main's SessionManager runs (Claude Code or Codex, in a
 * terminal or through a structured interface; src/main/sessions/), over IPC from the renderer or in
 * the core's own process (SessionBackend). It starts the session when
 * first needed (with what the agent is set to run with in its CLI: its settings' model, effort and
 * mode), sends each turn's message,
 * and plays the events main sends back (src/shared/session.ts) onto the session: entries, prompts,
 * status, mode, model and effort, usage, and each turn's end. Mode, model and effort changes,
 * answers and interrupts go to main. A session that would not start says why (a notice offering
 * another connection) before its start fails: the turn that started it never was, and the store
 * keeps its message (DriverIO.refused). Main's echo of a message marks it as the CLI's. Which
 * conversation a message is of, and the modes its connection starts in, it reads in the catalog it
 * is given (the mailbox's: src/shared/model/catalog.ts).
 */
export class ConnectedDriver implements SessionDriver {
  readonly connection: ConnectionId;
  readonly #agentId: string;
  readonly #catalog: EngineCatalog;
  readonly #backend: SessionBackend;
  readonly #io: DriverIO;
  /** Resolves once the session runs; undefined until it is started, and once it has stopped. */
  #running: Promise<void> | undefined;
  readonly #turns = new Map<string, SentTurn>();
  readonly #messages = new Set<string>();
  #lastError: string | undefined;
  /** When each thinking entry began, by id: how long it thought. */
  readonly #thinking = new Map<string, number>();
  /**
   * Why the session would not start, if it said so as it was last started (a notice offering
   * another connection, before its start failed saying the same).
   */
  #refusal: Refusal | undefined;
  #closed = false;

  constructor(
    agentId: string,
    connection: ConnectionId,
    catalog: EngineCatalog,
    backend: SessionBackend,
    io: DriverIO,
  ) {
    this.#agentId = agentId;
    this.connection = connection;
    this.#catalog = catalog;
    this.#backend = backend;
    this.#io = io;
  }

  open(): void {
    this.#run().then(
      () => {
        // What it kept, queued, while it would not start goes now that it runs.
        this.#io.idle();
      },
      (error: unknown) => {
        this.#notice('error', errorMessage(error));
      },
    );
  }

  ready(): Promise<void> {
    return this.#run();
  }

  start(turn: Turn, done: DriverDone): void {
    this.#lastError = undefined;
    const sent: SentTurn = { done, sent: false, started: this.#io.now() };
    this.#turns.set(turn.id, sent);
    this.#run()
      .then(() => {
        // Stopped before it went: it never does.
        if (!this.#turns.has(turn.id)) return null;
        sent.sent = true;
        const { id, text, images, from, origin, task } = turn;
        return this.#backend.send(this.#agentId, {
          id,
          text,
          ...(origin === undefined ? {} : { origin }),
          ...(task === undefined ? {} : { task }),
          ...(images === undefined || images.length === 0 ? {} : { images }),
          ...(from === undefined ? {} : { from }),
        });
      })
      .catch((error: unknown) => {
        if (!this.#turns.has(turn.id)) return;
        const refusal = sent.sent ? undefined : this.#refusal;
        if (refusal) {
          // It never went, and the session said why: the store keeps it for another way to run.
          this.#turns.delete(turn.id);
          this.#io.refused(turn.id, refusal);
          return;
        }
        this.#notice('error', errorMessage(error));
        this.#end([turn.id], {
          result: {
            status: 'failed',
            reason: sent.sent ? 'error' : 'start-failed',
            message: errorMessage(error),
          },
        });
      });
  }

  answer(id: string, answer: SessionAnswer): void {
    // A question's answers are recorded one by one by the store; the others here.
    if (answer.kind === 'permission') {
      const { feedback } = answer;
      this.#io.dispatch({
        type: 'answer',
        id,
        answer: answer.answer,
        ...(feedback === undefined ? {} : { feedback }),
      });
    } else if (answer.kind === 'plan') {
      this.#io.dispatch({ type: 'answerPlan', id, answer: answer.answer });
    } else if (answer.kind === 'elicitation') {
      this.#io.dispatch({ type: 'answerElicitation', id, action: answer.action });
    }
    this.#tell((agentId) => this.#backend.answer(agentId, id, answer));
  }

  stop(): void {
    const unsent = [...this.#turns].flatMap(([id, turn]) => (turn.sent ? [] : [id]));
    if (unsent.length > 0) {
      this.#end(unsent, {
        result: { status: 'cancelled', reason: 'taken-back' },
      });
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

  setEffort(effort: string | null): void {
    // Not started yet: it starts at the effort chosen.
    this.#tell((agentId) => this.#backend.setEffort(agentId, effort));
  }

  stopTask(taskId: string): void {
    this.#tell((agentId) => this.#backend.stopTask(agentId, taskId));
  }

  /**
   * A connection switch keeps submissions still awaiting startup. Detach them before closing,
   * so a late startup cannot send them through the old connection or cancel their callbacks.
   */
  takeUnsent(): string[] {
    const ids = [...this.#turns].flatMap(([id, turn]) => (turn.sent ? [] : [id]));
    for (const id of ids) this.#turns.delete(id);
    return ids;
  }

  close(): void {
    this.#closed = true;
    this.#stopAsking();
    if (this.#turns.size > 0 || this.#io.session().status !== 'idle') {
      this.#end([...new Set([...this.#turns.keys(), ...this.#messages])], {
        result: { status: 'cancelled', reason: 'connection-closed' },
      });
    }
    if (this.#running) {
      this.#running = undefined;
      this.#io.dispatch({ type: 'running', settings: undefined });
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
          ...(event.modes === undefined ? {} : { modes: event.modes }),
          ...(event.effort === undefined ? {} : { effort: event.effort }),
          ...(event.asks === undefined ? {} : { asks: event.asks }),
        });
        return;
      case 'commands':
        io.dispatch({ type: 'commands', commands: event.commands });
        return;
      case 'history': {
        // What the transcript shows already (the session was resumed after it closed, or the
        // agent ran in a Terminal meanwhile) is not shown again; the rest goes where it happened.
        const entries = replay(event.events, this.#agentId, this.connection, this.#catalog);
        if (entries.length > 0) io.dispatch({ type: 'restore', entries });
        return;
      }
      case 'user': {
        this.#messages.add(event.id);
        // The CLI has it: a message sent from here, now on its way, or one it told of itself.
        const known = find(event.id);
        if (!known) {
          // A native note can arrive while the backend still holds our outgoing shell command.
          const before = io
            .session()
            .entries.find(
              (entry) =>
                entry.kind === 'user' && entry.reached !== true && this.#turns.has(entry.id),
            )?.id;
          io.dispatch({
            type: 'start',
            ...(before === undefined ? {} : { before }),
            entry: {
              id: event.id,
              kind: 'user',
              text: event.text,
              ...(event.promptReply ? { promptReply: true } : {}),
              reached: true,
              conversation: this.#catalog.adapterOf(this.connection),
            },
          });
        } else if (known.kind === 'user' && (known.reached !== true || known.text !== event.text)) {
          io.dispatch({ type: 'received', id: event.id, text: event.text });
        }
        return;
      }
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
        const { id, tool, summary, status, detail, progress } = event;
        this.#put({
          id,
          kind: 'tool',
          tool,
          summary,
          status,
          ...(detail === undefined ? {} : { detail }),
          ...parent(event.parent),
          ...(progress === undefined ? {} : { progress }),
        });
        return;
      }
      case 'tasks':
        io.dispatch({ type: 'tasks', tasks: event.tasks });
        return;
      case 'suggestion':
        io.dispatch({ type: 'suggestion', text: event.text });
        return;
      case 'asking':
        io.dispatch({ type: 'asking', asks: event.asks });
        return;
      case 'unheard':
        // Said as a warning (a Terminal agent's bar shows it), and kept for the queues' Run.
        this.#notice('warning', event.text);
        io.dispatch({ type: 'unheard', text: event.text });
        return;
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
      case 'elicitation': {
        const { id, server, message, fields, url } = event;
        io.dispatch({
          type: 'ask',
          entry: {
            id,
            kind: 'elicitation',
            server,
            message,
            ...(fields === undefined ? {} : { fields }),
            ...(url === undefined ? {} : { url }),
          },
        });
        return;
      }
      case 'withdrawn':
        io.dispatch({ type: 'withdraw', id: event.id });
        return;
      case 'notice':
        if (event.switchTo !== undefined) {
          this.#refusal = { text: event.text, switchTo: event.switchTo };
        }
        this.#notice(event.level, event.text, {
          id: event.id,
          ...(event.switchTo === undefined ? {} : { switchTo: event.switchTo }),
        });
        return;
      case 'cleared':
        if (!find(event.id)) {
          io.dispatch({
            type: 'add',
            entry: {
              id: event.id,
              kind: 'cleared',
              conversation: this.#catalog.adapterOf(this.connection),
            },
          });
        }
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
      case 'effort':
        io.dispatch({ type: 'effort', effort: event.effort });
        return;
      case 'end':
        this.#end(event.messages, event);
        return;
      case 'closed':
        this.#running = undefined;
        io.dispatch({ type: 'running', settings: undefined });
        // Its CLI is gone, and what it ran in the background or asked with it.
        if ((io.session().tasks?.length ?? 0) > 0) io.dispatch({ type: 'tasks', tasks: [] });
        this.#stopAsking();
        if (event.error !== undefined) this.#notice('error', event.error);
        if (this.#turns.size > 0 || io.session().status !== 'idle') {
          this.#end([...new Set([...this.#turns.keys(), ...this.#messages])], {
            result: {
              status: event.error === undefined ? 'cancelled' : 'failed',
              reason: 'connection-closed',
              ...(event.error === undefined ? {} : { message: event.error }),
            },
          });
        }
        return;
    }
  }

  /** Starts the session, if it does not run yet. */
  #run(): Promise<void> {
    if (this.#closed) return Promise.reject(new Error('This session was closed.'));
    if (!this.#running) {
      const settings = this.#io.settings();
      // Only a mode its connection starts in (each asks: settings never hold another).
      const mode =
        settings.mode !== undefined &&
        isSessionMode(settings.mode) &&
        this.#catalog.isStartMode(this.connection, settings.mode)
          ? settings.mode
          : null;
      const given: AgentStartSettings = {
        ...(settings.model === undefined ? {} : { model: settings.model }),
        ...(settings.effort === undefined ? {} : { effort: settings.effort }),
        ...(mode === null ? {} : { mode }),
        ...(settings.role === undefined ? {} : { role: settings.role }),
      };
      this.#refusal = undefined;
      const running = this.#backend
        .start(this.#agentId, {
          connection: this.connection,
          // What is not set is the user's own: their CLI's settings, else its defaults.
          model: given.model ?? null,
          mode,
          ...(given.effort === undefined ? {} : { effort: given.effort }),
          ...(given.role === undefined ? {} : { role: given.role }),
        })
        .then(() => {
          if (this.#running === running) this.#io.dispatch({ type: 'running', settings: given });
        });
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
        this.#notice('error', errorMessage(error));
      });
  }

  /** Its CLI asks nothing in its terminal any more (it is gone). */
  #stopAsking(): void {
    if (this.#io.session().asking !== undefined) this.#io.dispatch({ type: 'asking', asks: [] });
  }

  /** Adds an entry, or replaces the one with its id. */
  #put(entry: Entry): void {
    if (this.#io.session().entries.some((e) => e.id === entry.id)) {
      this.#io.dispatch({ type: 'update', id: entry.id, update: () => entry });
    } else {
      this.#io.dispatch({ type: 'add', entry });
    }
  }

  /**
   * Tells the user something, unless it is what the transcript last said (as when a session that
   * cannot start says why, and its start fails saying the same).
   */
  #notice(
    level: 'info' | 'warning' | 'error',
    text: string,
    { id = this.#io.newId(), switchTo }: { id?: string; switchTo?: ConnectionId } = {},
  ): void {
    if (level === 'error') this.#lastError = text;
    const last = this.#io.session().entries.at(-1);
    if (last?.kind === 'notice' && last.level === level && last.text === text) return;
    this.#io.dispatch({
      type: 'add',
      entry: {
        id,
        kind: 'notice',
        level,
        text,
        ...(switchTo === undefined ? {} : { switchTo }),
      },
    });
  }

  /** Ends the turn of messages `ids`: the session is idle, and whoever sent them hears. */
  #end(ids: readonly string[], ending: { seconds?: number; result: TurnResult }): void {
    const io = this.#io;
    const native = ending.result;
    const result =
      native.status === 'failed' && native.message === undefined && this.#lastError !== undefined
        ? { ...native, message: this.#lastError }
        : native;
    this.#lastError = undefined;
    const interrupted = result.status === 'cancelled';
    const failed = result.status === 'failed';
    const hadNative = ids.some((id) => this.#messages.has(id));
    const turns = ids.flatMap((id) => {
      this.#messages.delete(id);
      const turn = this.#turns.get(id);
      this.#turns.delete(id);
      return turn ? [turn] : [];
    });
    if (turns.length === 0 && !hadNative && io.session().status === 'idle') return;
    const since = turns[0]?.started ?? io.now();
    io.dispatch({
      type: 'end',
      id: io.newId(),
      messages: ids,
      result,
      seconds: ending.seconds ?? Math.max(1, Math.round((io.now() - since) / 1000)),
    });
    // A native message may precede a turn the backend is still sending (a withdrawal note
    // before the user's shell command). Ending that message must not let the queue overtake it.
    if (this.#turns.size > 0) io.dispatch({ type: 'status', status: 'working' });
    else io.idle();
    for (const turn of turns) turn.done(interrupted || failed, result);
  }
}

/** The entries a resumed session's past events make, played onto a session of their own. */
function replay(
  events: readonly SessionEvent[],
  agentId: string,
  connection: ConnectionId,
  catalog: EngineCatalog,
): Entry[] {
  let session: Session = NEW_SESSION;
  const driver = new ConnectedDriver(agentId, connection, catalog, NO_BACKEND, {
    dispatch: (action) => {
      session = reduce(session, action);
    },
    session: () => session,
    settings: () => ({}),
    idle: () => undefined,
    refused: () => undefined,
    newId: () => crypto.randomUUID(),
    now: () => 0,
  });
  for (const event of events) if (event.type !== 'history') driver.receive(event);
  return session.entries;
}
