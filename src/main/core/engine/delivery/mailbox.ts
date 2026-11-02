import type { AdapterId, ConnectionId } from '../../../../shared/adapter';
import type { SubmittedMessage } from '../../../../shared/model/queue';
import type { RunRefusal as Refusal } from '../../../../shared/model/run';
import { parseRole } from '../../../../shared/role';
import type {
  AgentSettings,
  ElicitationAction,
  FilesRewind,
  FormValue,
  McpChange,
  McpServer,
  MessageSender,
  PastSession,
  RewindRestore,
  RewindResult,
  SessionAnswer,
  SettingsOptions,
  TaskMessage,
  TurnResult,
} from '../../../../shared/session';
import { adapterRefusal, fileMentionRefusal, shellRefusal } from '../../../../shared/model/catalog';
import type { PromptEntryChange } from '../../../../shared/model/prompt-views';
import type { EngineCatalog, ResolvedStep } from '../../../../shared/model/catalog';
import { ConnectedDriver, NO_BACKEND } from '../transcript/receive';
import type { SessionBackend } from '../transcript/receive';
import type { DriverIO, SessionDriver } from '../transcript/driver';
import { UnavailableDriver } from '../transcript/unavailable';
import { decodeSubmissions, encodeSubmissions, pruneSubmissions } from './submission-state';
import {
  answersOf,
  isOpen,
  NEW_SESSION,
  threadTitle,
  turnReply,
} from '../../../../shared/model/session';
import { reduceWithChanges } from '../transcript/reduce';
import type {
  Answer,
  Entry,
  MessageImage,
  Mode,
  PlanAnswer,
  Prompt,
  Session,
} from '../../../../shared/model/session';
import type { SessionAction } from '../transcript/reduce';

export interface SubmissionObserver {
  ending?: (agent: string, result: TurnResult, messages: readonly string[], sent: boolean) => void;
  submitted?: (agentId: string, message: SubmittedMessage) => void;
  ended?: (agentId: string, id: string, reply: string, result: TurnResult) => void;
}

/** An agent's driver, how it runs, and whether it is being let go. */
interface Driving {
  connection: ConnectionId;
  driver: SessionDriver;
  closing: boolean;
}

/**
 * Every agent's session, by agent id, outside any view (the renderer's components read it with
 * useSyncExternalStore), so that turns keep playing while their agent's view is closed. Each
 * agent's session is driven by a driver (transcript/driver.ts) connected to a session main's
 * SessionManager runs (transcript/receive.ts, through `backend`). A message sent while an agent
 * works is queued, and sent once the turn ends, interrupted or not. Whoever sends a message can
 * hear when the turn it starts ends, and what the agent replied in it, and can take the message
 * back (the queues' run, run/runner.ts). A session that would not start (an Agent SDK agent on a
 * Claude subscription) keeps its messages queued, unsent, and says so to whoever sent them, until
 * the agent runs another way (or the session starts after all). Each agent's adapter and
 * connection are read in the catalog it is given (the run's: catalog.ts).
 * Each session carries its open prompts, in transcript order, maintained with entry changes so
 * Needs never scans closed history. Checkpoints keep submissions only; native history rebuilds
 * the runtime index when it is merged, and resets/rewinds discard it with the transcript.
 */
export class SessionStore {
  #sessions: Readonly<Record<string, Session>> = {};
  readonly #listeners = new Set<() => void>();
  /** What hears each action reduced onto a session, just before its listeners hear the change. */
  readonly #observers = new Set<(agentId: string, action: SessionAction) => void>();
  readonly #catalog: EngineCatalog;
  readonly #backend: SessionBackend;
  readonly #drivers = new Map<string, Driving>();
  /** How each agent runs, as the canvas last said (`sync`). */
  readonly #connections = new Map<string, ConnectionId>();
  /** What each agent is set to run with in each CLI, as the canvas last said (`sync`). */
  readonly #settings = new Map<string, Partial<Record<AdapterId, AgentSettings>>>();
  /** The authored role is independent of the settings remembered for each CLI. */
  readonly #roles = new Map<string, string>();
  /** What each CLI's agents can be set to (read from main once asked, until `forgetOptions`). */
  readonly #options = new Map<AdapterId, Promise<SettingsOptions>>();
  /** Each agent's adapter, as it was last sent a message: how it runs, if the canvas never said. */
  readonly #types = new Map<string, AdapterId>();
  /**
   * Who to tell when the turn a message starts ends, by the message's id, from when it is sent
   * (queued or not) until then.
   */
  readonly #onDone = new Map<
    string,
    (interrupted: boolean, reply: string, result: TurnResult) => void
  >();
  /** Who to tell when a message's session would not start (it stays queued), by its id. */
  readonly #onRefused = new Map<string, (refusal: Refusal) => void>();
  /** A step may wait here, but can only start on the adapter its action was resolved for. */
  readonly #resolvedSteps = new Map<string, ResolvedStep>();
  /** The message whose turn each agent's session is on, by agent id. */
  readonly #turns = new Map<string, string>();
  /** Runtime holds stop automatic queue draining, while allowing fresh manual intervention. */
  readonly #heldQueues = new Set<string>();
  /**
   * What the user had queued when they stopped an agent the run holds (Kill): set aside until the
   * hold is released, as an interrupt in Claude Code sends nothing it had queued.
   */
  readonly #setAside = new Map<string, ReadonlySet<string>>();
  /** A durable conversation replacement gates new sends until the new driver can start. */
  readonly #freshening = new Map<string, Promise<void>>();
  /**
   * The agents corrallm switches to another backend now (B11a C4), until each switch settles:
   * nothing starts a turn or a session of theirs meanwhile.
   */
  readonly #switching = new Map<string, Promise<void>>();
  /** A pending interrupt belongs to this turn; duplicate stop callbacks must not send another. */
  readonly #stopping = new Set<string>();
  /** Automation already has a queue row; its prompt and native echoes must not create another. */
  readonly #queueMessages = new Set<string>();
  /**
   * What the user typed that the run sent (an OK's changes, a repeat's next try): a Message row
   * like any of theirs, but the run's own attempt, never taken for a correction typed in.
   */
  readonly #runMessages = new Set<string>();
  readonly #tasks = new Map<string, TaskMessage>();
  readonly #retryOf = new Map<string, string>();
  readonly #displayTexts = new Map<string, string>();
  /** Who sent each message another party sent, by its id, until its turn ends. */
  readonly #senders = new Map<string, MessageSender>();
  readonly #observer: SubmissionObserver;
  readonly #position: (agentId: string) => string | undefined;
  /** A message to send each agent once it runs another way (`sendOnceIn`), by agent id. */
  readonly #onceIn = new Map<
    string,
    { connection: ConnectionId; agent: AdapterId; text: string }
  >();
  #unsubscribe: (() => void) | undefined;
  #unavailable: (() => void) | undefined;
  readonly #checking = new Map<string, object>();
  readonly #directoryWords = new Map<string, string>();
  readonly #wantOpen = new Set<string>();

  #listenAvailability(): void {
    this.#unavailable ??= this.#backend.onAvailability?.(() => {
      this.#checking.clear();
      this.forgetOptions();
      for (const agent of this.#wantOpen) this.open(agent);
      for (const agent of this.#connections.keys()) this.#idle(agent);
    });
  }

  #available(agent: string, resume: () => void): boolean {
    if (this.#backend.availability === undefined) return true;
    this.#listenAvailability();
    if (this.#checking.has(agent)) return false;
    const token = {};
    this.#checking.set(agent, token);
    const connection = this.#connection(agent);
    void this.#backend.availability(agent).then(
      (result) => {
        if (this.#checking.get(agent) !== token) return;
        this.#checking.delete(agent);
        if (this.#connection(agent) !== connection) {
          this.#idle(agent);
          return;
        }
        if (result.ready) {
          this.#directoryWords.delete(agent);
          resume();
        } else if (this.#directoryWords.get(agent) !== result.sentence) {
          this.#directoryWords.set(agent, result.sentence);
          this.notice(agent, 'info', result.sentence);
        }
      },
      (error: unknown) => {
        if (this.#checking.get(agent) !== token) return;
        this.#checking.delete(agent);
        const text =
          error instanceof Error ? error.message : 'Its working directory could not be checked.';
        if (this.#directoryWords.get(agent) !== text) {
          this.#directoryWords.set(agent, text);
          this.notice(agent, 'warning', text);
        }
      },
    );
    return false;
  }

  constructor(
    catalog: EngineCatalog,
    backend: SessionBackend = NO_BACKEND,
    position: (agentId: string) => string | undefined = () => undefined,
    observer: SubmissionObserver = {},
  ) {
    this.#catalog = catalog;
    this.#backend = backend;
    this.#position = position;
    this.#observer = observer;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** Every session, by agent id: a new object after each change. */
  snapshot = (): Readonly<Record<string, Session>> => this.#sessions;

  /**
   * Hears each action reduced onto an agent's session, as it is reduced, just before `subscribe`'s
   * listeners hear the change it made: where a host publishes entry changes from (B11 §5's one
   * reducer), without scanning a transcript for what an action changed. A change made other than
   * by an action (an agent forgotten, submissions restored) is heard by `subscribe` alone.
   */
  observe(observer: (agentId: string, action: SessionAction) => void): () => void {
    this.#observers.add(observer);
    return () => {
      this.#observers.delete(observer);
    };
  }

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
      connection: ConnectionId;
      settings?: Partial<Record<AdapterId, AgentSettings>> | undefined;
      role?: string | undefined;
    }[],
  ): void {
    const roles = agents.map(({ id, role }) => [id, parseRole(role)] as const);
    const wanted = new Map(agents.map(({ id, connection }) => [id, connection]));
    const known = new Set([
      ...Object.keys(this.#sessions),
      ...this.#drivers.keys(),
      ...this.#heldQueues,
      ...this.#freshening.keys(),
      ...this.#switching.keys(),
    ]);
    for (const id of known) if (!wanted.has(id)) this.#forget(id);
    for (const id of this.#connections.keys()) if (!wanted.has(id)) this.#connections.delete(id);
    this.#settings.clear();
    this.#roles.clear();
    for (const { id, settings } of agents) if (settings) this.#settings.set(id, settings);
    for (const [id, role] of roles) if (role !== undefined) this.#roles.set(id, role);
    for (const [id, connection] of wanted) {
      if (this.#connections.get(id) !== connection) this.#freshening.delete(id);
      this.#connections.set(id, connection);
      const driving = this.#drivers.get(id);
      if (driving && driving.connection !== connection) {
        if (driving.driver instanceof ConnectedDriver) {
          for (const message of driving.driver.takeUnsent().reverse()) {
            this.#dispatch(id, { type: 'refuse', id: message });
            if (this.#turns.get(id) === message) this.#turns.delete(id);
          }
        }
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

  /**
   * Holds whatever would start a turn, or a session, of the agent's until `until` settles: corrallm
   * switches its backend meanwhile (B11a C4). What it is sent waits in its queue, and goes, in
   * order, once the switch has settled, on the connection the agent runs then; a turn going on goes
   * on. A switch abandoned (`until` rejecting) lets the same go where the agent still runs.
   */
  switching(agentId: string, until: Promise<unknown>): void {
    const held: Promise<void> = until
      .then(
        () => undefined,
        () => undefined,
      )
      .then(() => {
        if (this.#switching.get(agentId) !== held) return;
        this.#switching.delete(agentId);
        this.#idle(agentId);
      });
    this.#switching.set(agentId, held);
  }

  /** Makes sure the agent's session runs, as when its view opens. */
  open(agentId: string): void {
    if (this.#freshening.has(agentId) || this.#switching.has(agentId)) return;
    if (this.#backend.availability !== undefined) {
      this.#wantOpen.add(agentId);
      this.#available(agentId, () => {
        if (!this.#wantOpen.delete(agentId)) return;
        this.#driver(agentId).open();
      });
    } else this.#driver(agentId).open();
  }

  /** Starts without sending: delivery must inspect the native permissions before its first send. */
  async ready(agentId: string): Promise<void> {
    await this.#switching.get(agentId);
    await this.#freshening.get(agentId);
    await this.#driver(agentId).ready?.();
  }

  /** Holds waiting messages after the current turn; releasing sends them in their original order. */
  holdQueue(agentId: string, held: boolean): void {
    if (held) this.#heldQueues.add(agentId);
    else {
      this.#heldQueues.delete(agentId);
      this.#setAside.delete(agentId);
      // A canvas reset may release its run holds immediately before forgetting these sessions.
      // Re-check the live queue and hold after that same-stack transition has completed.
      queueMicrotask(() => {
        this.#idle(agentId);
      });
    }
  }

  /**
   * Starts the agent's connected session again, with what the agent is set to run with now: main
   * ends it first, and resumes its conversation as it starts it. A turn going on ends, interrupted.
   */
  async restart(agentId: string): Promise<void> {
    await this.#switching.get(agentId);
    if (!this.#drivers.has(agentId)) return;
    const availability = await this.#backend.availability?.(agentId);
    if (availability?.ready === false) throw new Error(availability.sentence);
    await this.#backend.close(agentId).catch(() => null);
    this.#letGo(agentId);
    this.#driver(agentId).open();
  }

  /**
   * Ends the agent's session without starting another (a workspace's Switch, B9a C7): what it is
   * sent next starts one, where the agent works then.
   */
  async close(agentId: string): Promise<void> {
    if (!this.#drivers.has(agentId)) return;
    await this.#backend.close(agentId).catch(() => null);
    this.#letGo(agentId);
  }

  /**
   * Starts a new native conversation with the current role and settings, without a prompt.
   * Main first durably forgets the selected CLI's remembered id; previous native history and
   * observed manual rows remain available. Active turns are never interrupted by this action.
   */
  fresh(agentId: string): Promise<void> {
    // A backend switch, itself a fresh conversation, settles first (B11a C6).
    const switching = this.#switching.get(agentId);
    if (switching) return switching.then(() => this.fresh(agentId));
    const existing = this.#freshening.get(agentId);
    if (existing) return existing;
    const connection = this.#connections.get(agentId);
    if (!connection || connection === 'unavailable' || this.of(agentId).status !== 'idle') {
      return Promise.resolve();
    }
    const pending = Promise.resolve().then(async () => {
      try {
        if (this.#freshening.get(agentId) !== pending) return;
        await this.#backend.fresh(agentId, this.#catalog.adapterOf(connection));
        if (this.#freshening.get(agentId) !== pending) return;
        this.#letGo(agentId);
        this.#dispatch(agentId, { type: 'clear' });
        this.#driver(agentId).open();
        this.#freshening.delete(agentId);
        this.#idle(agentId);
      } finally {
        if (this.#freshening.get(agentId) === pending) this.#freshening.delete(agentId);
      }
    });
    this.#freshening.set(agentId, pending);
    return pending;
  }

  /**
   * What an agent of `adapter` can be set to run with, and the user's own defaults: asked of main
   * once, then kept (until `forgetOptions`, or a failure, which is asked again next time).
   */
  settingsOptions(adapter: AdapterId, agentId?: string): Promise<SettingsOptions> {
    // Contextual reads must re-verify the workspace on each use, including after a Switch.
    if (agentId !== undefined) return this.#backend.options(adapter, agentId);
    let options = this.#options.get(adapter);
    if (!options) {
      options = this.#backend.options(adapter);
      options.catch(() => {
        if (this.#options.get(adapter) === options) this.#options.delete(adapter);
      });
      this.#options.set(adapter, options);
    }
    return options;
  }

  /** What adapters' agents can be set to is read again when next asked (another project folder). */
  forgetOptions(): void {
    this.#options.clear();
  }

  /**
   * Sends the user's message (with the images pasted into it): a new turn, or queued while one is
   * going on (or while messages kept from a session that would not start wait: they go first, and
   * the session is tried again). A queue hold keeps earlier messages waiting, while fresh user
   * input can intervene once idle. `onDone` hears when that turn ends (`interrupted` too if the
   * message is taken off the queue before it is sent, or the turn failed), with what the agent
   * replied in it (turnReply). `onRefused` hears each time the session would not start while the
   * message waits to go (kept, queued). Returns a function that takes the message back: off the
   * queue while it waits there, or interrupting its turn while that goes on (and nothing once it
   * has ended). `as`: the id it is sent under (its turn ends naming it), when the sender keeps its
   * own record of it (a new one when not given), and who sent it, when another party did (its
   * session's CLI is told so, where it can be: UserMessage.from).
   */
  send(
    agentId: string,
    agent: AdapterId,
    text: string,
    onDone?: (interrupted: boolean, reply: string, result: TurnResult) => void,
    images?: MessageImage[],
    onRefused?: (refusal: Refusal) => void,
    origin: 'user' | 'queue' | 'run' = 'user',
    displayText?: string,
    as: {
      id?: string;
      from?: MessageSender;
      task?: TaskMessage;
      retryOf?: string;
      resolvedStep?: ResolvedStep;
    } = {},
  ): () => void {
    const { id = crypto.randomUUID(), from } = as;
    if (as.task) this.#tasks.set(id, as.task);
    if (as.retryOf) this.#retryOf.set(id, as.retryOf);
    if (as.resolvedStep) this.#resolvedSteps.set(id, as.resolvedStep);
    this.#types.set(agentId, agent);
    if (origin === 'queue') this.#queueMessages.add(id);
    else if (origin === 'run') this.#runMessages.add(id);
    if (displayText !== undefined) this.#displayTexts.set(id, displayText);
    if (from !== undefined) this.#senders.set(id, from);
    if (onDone) this.#onDone.set(id, onDone);
    if (onRefused) this.#onRefused.set(id, onRefused);
    const session = this.of(agentId);
    const held = this.#heldQueues.has(agentId);
    if (
      this.#backend.availability === undefined &&
      !this.#freshening.has(agentId) &&
      !this.#switching.has(agentId) &&
      session.status === 'idle' &&
      (held ? origin !== 'queue' : session.queued.length === 0)
    ) {
      this.#start(agentId, { text, images }, id);
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
  sendOnceIn(agentId: string, connection: ConnectionId, agent: AdapterId, text: string): void {
    if (this.#connections.get(agentId) === connection) {
      this.send(agentId, agent, text);
      return;
    }
    this.#onceIn.set(agentId, { connection, agent, text });
  }

  /** Records a submitted command handled by the view itself, without dispatching a CLI turn. */
  recordSubmission(agentId: string, text: string, images?: MessageImage[]): void {
    const session = this.of(agentId);
    const after = this.#position(agentId);
    const result: TurnResult = { status: 'completed', reason: 'completed' };
    const message: SubmittedMessage = {
      id: crypto.randomUUID(),
      text,
      status: 'completed',
      result,
      ...(images?.length ? { images } : {}),
      ...(after === undefined ? {} : { after }),
    };
    this.#sessions = {
      ...this.#sessions,
      [agentId]: {
        ...session,
        prompts: session.prompts ?? session.entries.filter(isOpen),
        submissions: pruneSubmissions([...(session.submissions ?? []), message]),
      },
    };
    this.#notify();
    this.#observer.submitted?.(agentId, message);
    this.#observer.ended?.(agentId, message.id, '', result);
  }

  /** Tells the user something in the agent's session (a notice in its transcript). */
  notice(agentId: string, level: 'info' | 'warning' | 'error', text: string): void {
    this.#dispatch(agentId, {
      type: 'add',
      entry: { id: crypto.randomUUID(), kind: 'notice', level, text },
    });
  }

  /**
   * B13 C9: a prompt the core's prompt owner holds, placed in the agent's transcript as it is
   * raised (after what it shows now), or settled in place as it ends. Nothing else places or
   * changes one: no CLI event, history or turn's end.
   */
  promptEntry(agentId: string, change: PromptEntryChange): void {
    if (change.type === 'raised') {
      this.#dispatch(agentId, { type: 'add', entry: change.entry });
      return;
    }
    if (!this.of(agentId).entries.some((entry) => entry.id === change.id)) return;
    this.#dispatch(agentId, {
      type: 'update',
      id: change.id,
      update: (entry) =>
        entry.kind === 'prompt'
          ? {
              id: entry.id,
              kind: 'prompt',
              need: entry.need,
              prompt: change.prompt,
              ...(change.tokenTitle === undefined ? {} : { tokenTitle: change.tokenTitle }),
              outcome: change.outcome,
            }
          : entry,
    });
  }

  /** The files and folders of the canvas's project folder that match `query`, for an @-mention. */
  findFiles(query: string, agentId?: string): Promise<string[]> {
    return this.#backend.files(query, ...(agentId === undefined ? [] : [agentId]));
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
    this.resumed(agentId);
  }

  /**
   * Main made another conversation the agent's own, ending its session (`resume`, or a window's
   * /resume the core's runtime hears of: B11 X12, until X13 moves the agent window onto the
   * session's operations): its driver goes, the transcript empties, and the session starts again
   * resuming it, its history filling the transcript.
   */
  resumed(agentId: string): void {
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

  /**
   * An answer the agent's CLI has taken already (the core's reply, B11 Design §7: told the CLI first,
   * and awaited, so a CLI that refused it leaves its prompt open), shown on its prompt: nothing is
   * told the CLI again.
   */
  answered(agentId: string, promptId: string, answer: SessionAnswer): void {
    switch (answer.kind) {
      case 'permission':
        this.#dispatch(agentId, {
          type: 'answer',
          id: promptId,
          answer: answer.answer,
          ...(answer.feedback === undefined || answer.feedback.trim() === ''
            ? {}
            : { feedback: answer.feedback.trim() }),
        });
        return;
      case 'question':
        answer.answers.forEach((one, index) => {
          this.#dispatch(agentId, { type: 'answerQuestion', id: promptId, index, answer: one });
        });
        return;
      case 'plan':
        this.#dispatch(agentId, { type: 'answerPlan', id: promptId, answer: answer.answer });
        return;
      case 'elicitation':
        this.#dispatch(agentId, { type: 'answerElicitation', id: promptId, action: answer.action });
        return;
    }
  }

  /** Interrupts the turn going on, if any. */
  stop(agentId: string): void {
    if (this.of(agentId).status === 'idle' || this.#stopping.has(agentId)) return;
    const driver = this.#drivers.get(agentId)?.driver;
    if (!driver) return;
    this.#stopping.add(agentId);
    if (this.#heldQueues.has(agentId)) {
      this.#setAside.set(agentId, new Set(this.of(agentId).queued.map(({ id }) => id)));
    }
    driver.stop();
  }

  unqueue(agentId: string, queuedId: string): void {
    if (!this.of(agentId).queued.some(({ id }) => id === queuedId)) return;
    const result: TurnResult = { status: 'cancelled', reason: 'taken-back' };
    this.#settleSubmissions(agentId, result, queuedId);
    this.#dispatch(agentId, { type: 'unqueue', id: queuedId });
    this.#heard(queuedId)?.(true, '', result);
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

  /**
   * A change its live session acknowledged without going through this store (the core's live and
   * saved settings, which wait for it): shown as the session would report it, telling no driver.
   */
  applied(agentId: string, change: { mode?: Mode; model?: string; effort?: string | null }): void {
    if (change.mode !== undefined) this.#dispatch(agentId, { type: 'mode', mode: change.mode });
    if (change.model !== undefined) this.#dispatch(agentId, { type: 'model', model: change.model });
    if (change.effort !== undefined) {
      this.#dispatch(agentId, { type: 'effort', effort: change.effort });
    }
  }

  /** Stops a task the agent's session runs in the background. */
  stopTask(agentId: string, taskId: string): void {
    this.#drivers.get(agentId)?.driver.stopTask(taskId);
  }

  /** Forgets every session, as for another canvas: turns going on end, connected ones close. */
  reset(): void {
    this.#checking.clear();
    this.#directoryWords.clear();
    this.#wantOpen.clear();
    this.#unavailable?.();
    this.#unavailable = undefined;
    this.#freshening.clear();
    this.#switching.clear();
    for (const id of [...this.#drivers.keys()]) this.#letGo(id);
    const result: TurnResult = { status: 'cancelled', reason: 'connection-closed' };
    for (const id of Object.keys(this.#sessions)) this.#settleSubmissions(id, result);
    for (const onDone of this.#onDone.values()) onDone(true, '', result);
    this.#onDone.clear();
    this.#onRefused.clear();
    this.#resolvedSteps.clear();
    this.#turns.clear();
    this.#heldQueues.clear();
    this.#stopping.clear();
    this.#queueMessages.clear();
    this.#runMessages.clear();
    this.#tasks.clear();
    this.#retryOf.clear();
    this.#setAside.clear();
    this.#displayTexts.clear();
    this.#senders.clear();
    this.#onceIn.clear();
    this.#settings.clear();
    this.#roles.clear();
    this.#options.clear();
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#sessions = {};
    this.#notify();
  }

  /**
   * Starts a turn with message `id` (a queued message keeps its own). The run's own text (a
   * canvas's, which a shared file may hold) that starts with what the connection it goes to runs as
   * a shell command never starts: its turn fails, saying why, and the next message goes. Checked
   * here, as it leaves, since the agent may run another way than when it was sent. Automated
   * text's file mentions are checked here and again by the driver after startup.
   */
  #start(
    agentId: string,
    { text, images }: { text: string; images: MessageImage[] | undefined },
    id: string,
  ): void {
    const connection = this.#connection(agentId);
    const resolvedStep = this.#resolvedSteps.get(id);
    const changedAdapter =
      resolvedStep === undefined
        ? undefined
        : adapterRefusal(this.#catalog, resolvedStep, connection);
    if (changedAdapter !== undefined) {
      // Keep it queued until its runner takes it back into an unsent refusal. No driver starts.
      this.#dispatch(agentId, { type: 'queue', id, text, ...(images?.length ? { images } : {}) });
      queueMicrotask(() => {
        if (this.of(agentId).queued.some((one) => one.id === id))
          this.#onRefused.get(id)?.({ kind: 'unknown-action', text: changedAdapter });
        // Its owner withdrew it into Needs; other queues' text can still reach this recipient.
        if (!this.of(agentId).queued.some((one) => one.id === id)) this.#idle(agentId);
      });
      return;
    }
    const refusal =
      (this.#queueMessages.has(id) ? shellRefusal(this.#catalog, connection, text) : undefined) ??
      this.#fileMentionRefusal(agentId, id, text);
    if (refusal !== undefined) {
      const onDone = this.#heard(id);
      this.#idle(agentId);
      queueMicrotask(() => {
        onDone?.(true, '', { status: 'failed', reason: 'declined', message: refusal });
      });
      return;
    }
    const pasted = images === undefined || images.length === 0 ? {} : { images };
    this.#turns.set(agentId, id);
    // Its adapter's conversation (model/session.ts Conversation): an unsupported submission's
    // ('unavailable') stays separate from native conversation history.
    const conversation = this.#catalog.adapterOf(connection);
    this.#dispatch(agentId, {
      type: 'start',
      entry: { id, kind: 'user', text, ...pasted, conversation },
    });
    const from = this.#senders.get(id);
    this.#driver(agentId).start(
      {
        id,
        text,
        ...pasted,
        ...(from === undefined ? {} : { from }),
      },
      (interrupted, result) => {
        // The next queued message may have started already.
        if (this.#turns.get(agentId) === id) this.#turns.delete(agentId);
        this.#heard(id)?.(interrupted, turnReply(this.of(agentId), id), result);
      },
    );
  }

  /** Who hears when message `id`'s turn ends, now that it does: forgotten, as it ends once. */
  #heard(
    id: string,
  ): ((interrupted: boolean, reply: string, result: TurnResult) => void) | undefined {
    const onDone = this.#onDone.get(id);
    this.#onDone.delete(id);
    this.#onRefused.delete(id);
    this.#resolvedSteps.delete(id);
    this.#displayTexts.delete(id);
    this.#senders.delete(id);
    this.#tasks.delete(id);
    this.#retryOf.delete(id);
    return onDone;
  }

  /** Rechecked at startup and at native send, using the current connection and kept provenance. */
  #fileMentionRefusal(agentId: string, id: string, text: string): string | undefined {
    if (!this.#queueMessages.has(id) && !this.#senders.has(id)) return undefined;
    return fileMentionRefusal(this.#catalog, this.#connection(agentId), text);
  }

  /**
   * The agent's session would not start, so message `id`'s turn never went: it goes back to the
   * head of the queue, and whoever sent a message still queued hears why (none can go until the
   * agent runs another way, or the session starts after all).
   */
  #refused(agentId: string, id: string, refusal: Refusal): void {
    this.#dispatch(agentId, { type: 'refuse', id });
    if (this.#turns.get(agentId) === id) this.#turns.delete(agentId);
    const ids = this.of(agentId).queued.map(({ id }) => id);
    const driving = this.#drivers.get(agentId);
    // Native starts are asynchronous. Keep the same ordering for unavailable connections, so
    // a runner can publish its held task before hearing the refusal. A same-stack switch or
    // removal may already have dispatched/withdrawn these messages before this notification.
    queueMicrotask(() => {
      if (this.#drivers.get(agentId) !== driving) return;
      const queued = new Set(this.of(agentId).queued.map(({ id }) => id));
      for (const id of ids) if (queued.has(id)) this.#onRefused.get(id)?.(refusal);
    });
  }

  /** The session is idle: its next queued message, if any, starts. */
  #idle(agentId: string, admitted = false): void {
    if (this.#freshening.has(agentId) || this.#switching.has(agentId)) return;
    const session = this.of(agentId);
    // While the run holds the agent, what the user typed still goes; only the run's own waits,
    // and what a Stop set aside.
    const aside = this.#setAside.get(agentId);
    const next = this.#heldQueues.has(agentId)
      ? session.queued.find(({ id }) => !this.#queueMessages.has(id) && aside?.has(id) !== true)
      : session.queued[0];
    if (!next || session.status !== 'idle') return;
    if (
      !admitted &&
      !this.#available(agentId, () => {
        this.#idle(agentId, true);
      })
    )
      return;
    this.#dispatch(agentId, { type: 'unqueue', id: next.id });
    this.#start(agentId, { text: next.text, images: next.images }, next.id);
  }

  /** Missing runtime configuration follows the same native default as an authored agent. */
  #connection(agentId: string): ConnectionId {
    const adapter = this.#types.get(agentId);
    return (
      this.#connections.get(agentId) ??
      this.#catalog.connectionOf(adapter === undefined ? {} : { adapter })
    );
  }

  /** The agent's driver, made as the agent runs if it has none. */
  #driver(agentId: string): SessionDriver {
    const existing = this.#drivers.get(agentId);
    if (existing) return existing.driver;
    const connection = this.#connection(agentId);
    // The driver's io needs its entry, and the driver its io.
    const driving = { connection, closing: false } as Driving;
    const io = this.#io(agentId, driving);
    if (connection === 'unavailable') {
      driving.driver = new UnavailableDriver(io);
    } else {
      this.#listen();
      driving.driver = new ConnectedDriver(agentId, connection, this.#catalog, this.#backend, io);
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
      sending: (id, text) => this.#fileMentionRefusal(agentId, id, text),
      settings: () => {
        const settings =
          driving.connection === 'unavailable'
            ? {}
            : (this.#settings.get(agentId)?.[this.#catalog.adapterOf(driving.connection)] ?? {});
        const role = this.#roles.get(agentId);
        return { ...settings, ...(role === undefined ? {} : { role }) };
      },
      idle: () => {
        if (current() && !driving.closing) this.#idle(agentId);
      },
      refused: (id, refusal) => {
        if (current() && !driving.closing) this.#refused(agentId, id, refusal);
      },
      newId: () => crypto.randomUUID(),
      now: () => Date.now(),
    };
  }

  /** Hears connected sessions' events, from the first connected driver on. */
  #listen(): void {
    this.#unsubscribe ??= this.#backend.onEvent((agentId, connection, event) => {
      const driving = this.#drivers.get(agentId);
      if (driving?.driver instanceof ConnectedDriver && driving.connection === connection) {
        if (event.type === 'end')
          this.#observer.ending?.(
            agentId,
            event.result,
            event.messages,
            event.messages.includes(this.#turns.get(agentId) ?? ''),
          );
        driving.driver.receive(event);
      }
    });
  }

  /** Lets the agent's driver go: its turn ends, and a connected session closes. */
  #letGo(agentId: string): void {
    this.#stopping.delete(agentId);
    const driving = this.#drivers.get(agentId);
    if (!driving) return;
    driving.closing = true;
    driving.driver.close();
    this.#drivers.delete(agentId);
  }

  /** The agent is gone: its session ends, and whoever waits on its queued messages hears. */
  #forget(agentId: string): void {
    this.#checking.delete(agentId);
    this.#wantOpen.delete(agentId);
    this.#directoryWords.delete(agentId);
    this.#freshening.delete(agentId);
    this.#switching.delete(agentId);
    this.#letGo(agentId);
    this.#roles.delete(agentId);
    this.#heldQueues.delete(agentId);
    this.#onceIn.delete(agentId);
    const result: TurnResult = { status: 'cancelled', reason: 'connection-closed' };
    this.#settleSubmissions(agentId, result);
    for (const { id } of this.of(agentId).queued) this.#heard(id)?.(true, '', result);
    this.#turns.delete(agentId);
    this.#sessions = Object.fromEntries(
      Object.entries(this.#sessions).filter(([id]) => id !== agentId),
    );
    this.#types.delete(agentId);
    this.#notify();
  }

  #dispatch(agentId: string, action: SessionAction): void {
    if (
      action.type === 'start' ||
      action.type === 'end' ||
      action.type === 'refuse' ||
      (action.type === 'add' && action.entry.kind === 'notice' && action.entry.level === 'error')
    ) {
      this.#stopping.delete(agentId);
    }
    const session = this.of(agentId);
    let submissions = session.submissions;
    let created: SubmittedMessage | undefined;
    const ended: (SubmittedMessage & { result: TurnResult })[] = [];
    if (action.type === 'start' || action.type === 'queue') {
      const message = action.type === 'start' ? action.entry : action;
      if (!this.#queueMessages.has(message.id)) {
        const status = action.type === 'start' ? 'running' : 'queued';
        if (submissions?.some(({ id }) => id === message.id)) {
          submissions = submissions.map((entry) =>
            entry.id === message.id ? { ...entry, status } : entry,
          );
        } else {
          const after = this.#position(agentId);
          const retryOf = this.#retryOf.get(message.id);
          created = {
            id: message.id,
            text: this.#displayTexts.get(message.id) ?? message.text,
            status,
            ...(retryOf === undefined ? {} : { retryOf }),
            ...(message.images?.length ? { images: message.images } : {}),
            ...(after === undefined ? {} : { after }),
          };
          submissions = pruneSubmissions([...(submissions ?? []), created]);
        }
      }
    } else if (action.type === 'refuse') {
      submissions = submissions?.map((entry) =>
        entry.id === action.id ? { ...entry, status: 'queued' } : entry,
      );
    } else if (action.type === 'end') {
      const result = action.result;
      submissions = submissions?.map((entry) => {
        if (
          entry.status !== 'running' ||
          (action.messages !== undefined && !action.messages.includes(entry.id))
        )
          return entry;
        const next = {
          ...entry,
          status: result.status,
          result,
          reply: turnReply(session, entry.id),
        };
        ended.push(next);
        return next;
      });
    }
    this.#sessions = {
      ...this.#sessions,
      [agentId]: {
        ...indexed(session, action),
        ...(submissions === undefined ? {} : { submissions }),
      },
    };
    for (const observer of this.#observers) observer(agentId, action);
    this.#notify();
    if (created && !this.#runMessages.has(created.id)) this.#observer.submitted?.(agentId, created);
    for (const message of ended) {
      if (this.#runMessages.has(message.id)) continue;
      this.#observer.ended?.(agentId, message.id, message.reply ?? '', message.result);
    }
  }

  /** Ends outstanding submissions without inventing a native reply. */
  #settleSubmissions(agentId: string, result: TurnResult, id?: string): void {
    const session = this.of(agentId);
    if (!session.submissions) return;
    const ended: SubmittedMessage[] = [];
    const submissions = session.submissions.map((entry) => {
      if (
        (entry.status !== 'running' && entry.status !== 'queued') ||
        (id !== undefined && entry.id !== id)
      )
        return entry;
      const next = { ...entry, status: result.status, result, reply: turnReply(session, entry.id) };
      ended.push(next);
      return next;
    });
    if (ended.length === 0) return;
    this.#sessions = { ...this.#sessions, [agentId]: { ...session, submissions } };
    this.#notify();
    for (const message of ended)
      this.#observer.ended?.(agentId, message.id, message.reply ?? '', result);
  }

  /** Associates a correction with a held task without dispatching or re-observing it. */
  tagSubmission(agentId: string, messageId: string, owner: string, item: string): void {
    const session = this.of(agentId);
    if (!session.submissions?.some(({ id }) => id === messageId)) return;
    this.#sessions = {
      ...this.#sessions,
      [agentId]: {
        ...session,
        submissions: session.submissions.map((message) =>
          message.id === messageId ? { ...message, task: { agent: owner, item } } : message,
        ),
      },
    };
    this.#notify();
  }

  serializeSubmissions(): string {
    return encodeSubmissions(this.#sessions);
  }

  /** Restores records only: unresolved work never silently re-sends after a restart. */
  restoreSubmissions(serialized: string): void {
    const decoded = decodeSubmissions(serialized);
    const next = { ...this.#sessions };
    for (const [id, submissions] of decoded) {
      const session = this.of(id);
      next[id] = {
        ...session,
        prompts: session.prompts ?? session.entries.filter(isOpen),
        submissions,
      };
    }
    this.#sessions = next;
    this.#notify();
  }

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }
}

/**
 * Keep the exact prompt objects, in transcript order, beside the transcript. Normal output never
 * scans history to update this index. A history merge, or a generic update reopening an entry,
 * can change their order/places arbitrarily and rebuilds once. Metadata-only session writes
 * retain the index with their unchanged entries.
 */
function indexed(session: Session, action: SessionAction): Session {
  const prompts = session.prompts ?? session.entries.filter(isOpen);
  const replacements = new Map<Entry, Entry>();
  const changes = { opened: false };
  const next = reduceWithChanges(session, action, (before, after) => {
    if (isOpen(before) || isOpen(after)) replacements.set(before, after);
    if (!isOpen(before) && isOpen(after)) changes.opened = true;
  });
  if (next.entries === session.entries) return { ...next, prompts };
  let index: readonly Prompt[] = prompts;
  if (action.type === 'restore' || changes.opened) index = next.entries.filter(isOpen);
  else if (action.type === 'clear' || action.type === 'end') index = [];
  else if ((action.type === 'add' || action.type === 'ask') && isOpen(action.entry)) {
    index = [...prompts, action.entry];
  } else if (action.type === 'received') {
    // Receipt can move a user entry past native messages (and remove duplicate ids).
    index = prompts.filter((entry) => entry.id !== action.id);
  } else if (replacements.size > 0) {
    index = prompts.flatMap((entry) => {
      const after = replacements.get(entry) ?? entry;
      return isOpen(after) ? [after] : [];
    });
  }
  return { ...next, prompts: index };
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
