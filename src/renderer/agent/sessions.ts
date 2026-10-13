import { CONNECTION_CLI } from '../../shared/session';
import type {
  AgentSettings,
  Cli,
  ElicitationAction,
  FilesRewind,
  FormValue,
  McpChange,
  McpServer,
  PastSession,
  RewindRestore,
  RewindResult,
  SettingsOptions,
} from '../../shared/session';
import { DEFAULT_AGENT } from '../graph/agents';
import type { AgentConnection, AgentType } from '../graph/agents';
import { ConnectedDriver, NO_BACKEND } from './connected';
import type { SessionBackend } from './connected';
import type { DriverIO, SessionDriver } from './driver';
import { ScriptedDriver } from './scripted';
import { answersOf, NEW_SESSION, reduce, threadTitle, turnReply } from './session';
import type {
  Answer,
  MessageImage,
  Mode,
  PlanAnswer,
  Refusal,
  Session,
  SessionAction,
} from './session';

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
 * interrupted or not. Whoever sends a message can hear when the turn it starts ends, and what the
 * agent replied in it, and can take the message back (the queues' run, run/runner.ts). A session
 * that would not start (an Agent SDK agent on a Claude subscription) keeps its messages queued,
 * unsent, and says so to whoever sent them, until the agent runs another way (or the session
 * starts after all).
 */
export class SessionStore {
  #sessions: Readonly<Record<string, Session>> = {};
  readonly #listeners = new Set<() => void>();
  readonly #backend: SessionBackend;
  readonly #drivers = new Map<string, Driving>();
  /** How each agent runs, as the canvas last said (`sync`). */
  readonly #connections = new Map<string, AgentConnection>();
  /** What each agent is set to run with in each CLI, as the canvas last said (`sync`). */
  readonly #settings = new Map<string, Partial<Record<Cli, AgentSettings>>>();
  /** What each CLI's agents can be set to (read from main once asked, until `forgetOptions`). */
  readonly #options = new Map<Cli, Promise<SettingsOptions>>();
  /** Each agent's type, as it was last sent a message: what its scripted turns are like. */
  readonly #types = new Map<string, AgentType>();
  /**
   * Who to tell when the turn a message starts ends, by the message's id, from when it is sent
   * (queued or not) until then.
   */
  readonly #onDone = new Map<string, (interrupted: boolean, reply: string) => void>();
  /** Who to tell when a message's session would not start (it stays queued), by its id. */
  readonly #onRefused = new Map<string, (refusal: Refusal) => void>();
  /** The message whose turn each agent's session is on, by agent id. */
  readonly #turns = new Map<string, string>();
  /** A message to send each agent once it runs another way (`sendOnceIn`), by agent id. */
  readonly #onceIn = new Map<
    string,
    { connection: AgentConnection; agent: AgentType; text: string }
  >();
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
   * The agents on the canvas, how each runs, and what each is set to run with (its settings, by
   * CLI: what its connected sessions start with). The session of an agent that is gone ends and is
   * forgotten; one whose agent runs another way now ends its turn and goes on with a new driver. A
   * session that runs keeps the settings it started with until it is restarted (`restart`).
   */
  sync(
    agents: readonly {
      id: string;
      connection: AgentConnection;
      settings?: Partial<Record<Cli, AgentSettings>> | undefined;
    }[],
  ): void {
    const wanted = new Map(agents.map(({ id, connection }) => [id, connection]));
    const known = new Set([...Object.keys(this.#sessions), ...this.#drivers.keys()]);
    for (const id of known) if (!wanted.has(id)) this.#forget(id);
    for (const id of this.#connections.keys()) if (!wanted.has(id)) this.#connections.delete(id);
    this.#settings.clear();
    for (const { id, settings } of agents) if (settings) this.#settings.set(id, settings);
    for (const [id, connection] of wanted) {
      this.#connections.set(id, connection);
      const driving = this.#drivers.get(id);
      if (driving && driving.connection !== connection) {
        this.#letGo(id);
        this.#idle(id);
      }
      const once = this.#onceIn.get(id);
      if (once?.connection === connection) {
        this.#onceIn.delete(id);
        this.send(id, once.agent, once.text);
      }
    }
  }

  /** Makes sure the agent's session runs, as when its view opens. */
  open(agentId: string): void {
    this.#driver(agentId).open();
  }

  /**
   * Starts the agent's connected session again, with what the agent is set to run with now: main
   * ends it first, and resumes its conversation as it starts it. A turn going on ends, interrupted.
   */
  async restart(agentId: string): Promise<void> {
    if (!this.#drivers.has(agentId)) return;
    await this.#backend.close(agentId).catch(() => null);
    this.#letGo(agentId);
    this.#driver(agentId).open();
  }

  /**
   * What an agent of `cli` can be set to run with, and the user's own defaults: asked of main once,
   * then kept (until `forgetOptions`, or a failure, which is asked again next time).
   */
  settingsOptions(cli: Cli): Promise<SettingsOptions> {
    let options = this.#options.get(cli);
    if (!options) {
      options = this.#backend.options(cli);
      options.catch(() => {
        if (this.#options.get(cli) === options) this.#options.delete(cli);
      });
      this.#options.set(cli, options);
    }
    return options;
  }

  /** What CLIs' agents can be set to is read again when next asked (another project folder). */
  forgetOptions(): void {
    this.#options.clear();
  }

  /**
   * Sends the user's message (with the images pasted into it): a new turn, or queued while one is
   * going on (or while messages kept from a session that would not start wait: they go first, and
   * the session is tried again). `onDone` hears when that turn ends (`interrupted` too if the
   * message is taken off the queue before it is sent, or the turn failed), with what the agent
   * replied in it (turnReply). `onRefused` hears each time the session would not start while the
   * message waits to go (kept, queued). Returns a function that takes the message back: off the
   * queue while it waits there, or interrupting its turn while that goes on (and nothing once it
   * has ended).
   */
  send(
    agentId: string,
    agent: AgentType,
    text: string,
    onDone?: (interrupted: boolean, reply: string) => void,
    images?: MessageImage[],
    onRefused?: (refusal: Refusal) => void,
  ): () => void {
    this.#types.set(agentId, agent);
    const id = crypto.randomUUID();
    if (onDone) this.#onDone.set(id, onDone);
    if (onRefused) this.#onRefused.set(id, onRefused);
    const session = this.of(agentId);
    if (session.status === 'idle' && session.queued.length === 0) {
      this.#start(agentId, agent, { text, images }, id);
    } else {
      this.#dispatch(agentId, {
        type: 'queue',
        id,
        text,
        ...(images === undefined || images.length === 0 ? {} : { images }),
      });
      this.#idle(agentId);
    }
    return () => {
      if (this.of(agentId).queued.some((queued) => queued.id === id)) this.unqueue(agentId, id);
      else if (this.#turns.get(agentId) === id) this.stop(agentId);
    };
  }

  /**
   * Sends a message once the agent runs with `connection`, as the canvas switches it (`sync`): a
   * command typed for Claude Code's terminal, sent there once the agent continues in Terminal.
   */
  sendOnceIn(agentId: string, connection: AgentConnection, agent: AgentType, text: string): void {
    if (this.#connections.get(agentId) === connection) {
      this.send(agentId, agent, text);
      return;
    }
    this.#onceIn.set(agentId, { connection, agent, text });
  }

  /** Tells the user something in the agent's session (a notice in its transcript). */
  notice(agentId: string, level: 'info' | 'warning' | 'error', text: string): void {
    this.#dispatch(agentId, {
      type: 'add',
      entry: { id: crypto.randomUUID(), kind: 'notice', level, text },
    });
  }

  /** The files and folders of the canvas's project folder that match `query`, for an @-mention. */
  findFiles(query: string): Promise<string[]> {
    return this.#backend.files(query);
  }

  /** The conversations Claude Code kept for the project folder, for /resume. */
  pastSessions(agentId: string): Promise<PastSession[]> {
    return this.#backend.sessions(agentId);
  }

  /**
   * Opens another conversation in the agent (/resume), one main listed: main makes it the agent's
   * own, ending its session; its driver goes (a turn going on ends, interrupted), the transcript
   * empties, and the session starts again resuming that conversation, whose history fills the
   * transcript. If main refuses, nothing changes.
   */
  async resume(agentId: string, sessionId: string): Promise<void> {
    await this.#backend.resume(agentId, sessionId);
    this.#letGo(agentId);
    this.#dispatch(agentId, { type: 'clear' });
    this.#driver(agentId).open();
    // What was queued goes on, to that conversation.
    this.#idle(agentId);
  }

  /** What restoring the agent's files to before one of its messages would change. */
  previewRewind(agentId: string, messageId: string): Promise<FilesRewind> {
    return this.#backend.previewRewind(agentId, messageId);
  }

  /**
   * Rewinds the agent's session to before one of its messages (`messageId`, a user entry): its
   * files, its conversation, or both, as main does them, then says what it did. The conversation
   * goes back as a copy up to there, which main makes the agent's own: its driver goes, the
   * transcript empties, and the session starts again on the copy, whose history fills it.
   */
  async rewind(agentId: string, messageId: string, restore: RewindRestore): Promise<RewindResult> {
    const message = this.of(agentId).entries.find((entry) => entry.id === messageId);
    const before = `before “${message?.kind === 'user' ? threadTitle(message.text, 60) : 'that message'}”`;
    const result = await this.#backend.rewind(agentId, messageId, restore);
    const { files, conversation } = result;
    if (conversation) {
      this.#letGo(agentId);
      this.#dispatch(agentId, { type: 'clear' });
      this.#driver(agentId).open();
    }
    const text = conversation
      ? `Rewound the conversation to ${before}${files && files.files.length > 0 ? `, and restored ${restored(files)}` : ''}.`
      : files && files.files.length > 0
        ? `Restored ${restored(files)} to how ${files.files.length === 1 ? 'it was' : 'they were'} ${before}.`
        : `No files to restore: nothing changed since ${before.slice('before '.length)}.`;
    this.notice(agentId, 'info', text);
    if (conversation) this.#idle(agentId);
    return result;
  }

  /** The MCP servers of the agent's running session (/mcp). */
  mcpServers(agentId: string): Promise<McpServer[]> {
    return this.#backend.mcp(agentId);
  }

  /** Reconnects, enables or disables one of them; resolves with them all as they are then. */
  changeMcpServer(agentId: string, server: string, change: McpChange): Promise<McpServer[]> {
    return this.#backend.changeMcp(agentId, server, change);
  }

  /** Answers an MCP server's request: accepted (with the form's values), declined or cancelled. */
  answerElicitation(
    agentId: string,
    promptId: string,
    action: ElicitationAction,
    values?: Record<string, FormValue>,
  ): void {
    this.#drivers.get(agentId)?.driver.answer(promptId, {
      kind: 'elicitation',
      action,
      ...(values === undefined ? {} : { values }),
    });
  }

  /** Answers a permission prompt; with a no, `feedback` tells Claude what to do instead. */
  answer(agentId: string, permissionId: string, answer: Answer, feedback?: string): void {
    this.#drivers.get(agentId)?.driver.answer(permissionId, {
      kind: 'permission',
      answer,
      ...(feedback === undefined || feedback.trim() === '' ? {} : { feedback: feedback.trim() }),
    });
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
    this.#heard(queuedId)?.(true, '');
  }

  /**
   * The user chose a mode for the agent's session: it switches to it (once it runs). What it starts
   * in is the agent's settings' (`sync`).
   */
  setMode(agentId: string, mode: Mode): void {
    this.#dispatch(agentId, { type: 'mode', mode });
    this.#drivers.get(agentId)?.driver.setMode(mode);
  }

  /** The user chose a model for the agent's session: it switches to it (once it runs). */
  setModel(agentId: string, model: string): void {
    this.#dispatch(agentId, { type: 'model', model });
    this.#drivers.get(agentId)?.driver.setModel(model);
  }

  /** The user chose how hard its model reasons (null: the model's default): its session switches. */
  setEffort(agentId: string, effort: string | null): void {
    this.#dispatch(agentId, { type: 'effort', effort });
    this.#drivers.get(agentId)?.driver.setEffort(effort);
  }

  /** Stops a task the agent's session runs in the background. */
  stopTask(agentId: string, taskId: string): void {
    this.#drivers.get(agentId)?.driver.stopTask(taskId);
  }

  /** Forgets every session, as for another canvas: turns going on end, connected ones close. */
  reset(): void {
    for (const id of [...this.#drivers.keys()]) this.#letGo(id);
    for (const onDone of this.#onDone.values()) onDone(true, '');
    this.#onDone.clear();
    this.#onRefused.clear();
    this.#turns.clear();
    this.#onceIn.clear();
    this.#settings.clear();
    this.#options.clear();
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#sessions = {};
    this.#notify();
  }

  /** Starts a turn with message `id` (a queued message keeps its own). */
  #start(
    agentId: string,
    agent: AgentType,
    { text, images }: { text: string; images: MessageImage[] | undefined },
    id: string,
  ): void {
    const pasted = images === undefined || images.length === 0 ? {} : { images };
    this.#turns.set(agentId, id);
    this.#dispatch(agentId, { type: 'start', entry: { id, kind: 'user', text, ...pasted } });
    this.#driver(agentId).start({ id, text, agent, ...pasted }, (interrupted) => {
      // The next queued message may have started already.
      if (this.#turns.get(agentId) === id) this.#turns.delete(agentId);
      this.#heard(id)?.(interrupted, turnReply(this.of(agentId), id));
    });
  }

  /** Who hears when message `id`'s turn ends, now that it does: forgotten, as it ends once. */
  #heard(id: string): ((interrupted: boolean, reply: string) => void) | undefined {
    const onDone = this.#onDone.get(id);
    this.#onDone.delete(id);
    this.#onRefused.delete(id);
    return onDone;
  }

  /**
   * The agent's session would not start, so message `id`'s turn never went: it goes back to the
   * head of the queue, and whoever sent a message still queued hears why (none can go until the
   * agent runs another way, or the session starts after all).
   */
  #refused(agentId: string, id: string, refusal: Refusal): void {
    this.#dispatch(agentId, { type: 'refuse', id });
    if (this.#turns.get(agentId) === id) this.#turns.delete(agentId);
    for (const queued of this.of(agentId).queued) this.#onRefused.get(queued.id)?.(refusal);
  }

  /** The session is idle: its next queued message, if any, starts. */
  #idle(agentId: string): void {
    const session = this.of(agentId);
    const [next] = session.queued;
    if (!next || session.status !== 'idle') return;
    this.#dispatch(agentId, { type: 'unqueue', id: next.id });
    this.#start(
      agentId,
      this.#types.get(agentId) ?? DEFAULT_AGENT,
      { text: next.text, images: next.images },
      next.id,
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
      settings: () =>
        driving.connection === 'simulated'
          ? {}
          : (this.#settings.get(agentId)?.[CONNECTION_CLI[driving.connection]] ?? {}),
      idle: () => {
        if (current() && !driving.closing) this.#idle(agentId);
      },
      refused: (id, refusal) => {
        if (current() && !driving.closing) this.#refused(agentId, id, refusal);
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
    this.#onceIn.delete(agentId);
    for (const { id } of this.of(agentId).queued) this.#heard(id)?.(true, '');
    this.#turns.delete(agentId);
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

/** The files a rewind restored, as a notice names them: "notes.txt (+1 −1)", "4 files (a, b, c and 1 more; +4 −2)". */
function restored({ files, added, removed }: FilesRewind): string {
  const counts = `+${String(added)} −${String(removed)}`;
  if (files.length === 1) return `${files[0] ?? ''} (${counts})`;
  const named =
    files.length <= 3
      ? files.join(', ')
      : `${files.slice(0, 3).join(', ')} and ${String(files.length - 3)} more`;
  return `${String(files.length)} files (${named}; ${counts})`;
}
