import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';

import { adapterIn, connectionIn } from '../../shared/adapter';
import type { AdapterId, Catalog, ConnectionId } from '../../shared/adapter';
import type { CanvasId } from '../../shared/canvas';
import type { AgentId, NeedId } from '../../shared/api/ids';
import { quotedName } from '../core/parties';
import type { DirectoryResolver, WorkingDirectory, WorkspaceId } from '../core/workspaces/resolver';
import type {
  FilesRewind,
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
} from '../../shared/session';
import type { TerminalEvent } from '../../shared/terminal';
import type { CanvasMemory, Conversation } from '../memory';
import {
  conversationsIn,
  PROJECT_WORKSPACE,
  roleFingerprint,
  withConversationsIn,
} from '../memory';
import type { Connector, LiveSession, SessionHost } from './connector';
import type { Conversations } from './adapter';
import { ConversationClaims } from './claims';
import type { ClaimOwner } from './claims';
import { droppedPaste } from './terminal/drop';
import { isConversationId, requireConversationId } from './adapters';

const NOT_RUNNING = 'This agent’s session is not running.';
const NOT_LISTED = 'That is not one of this project folder’s conversations.';
const STALE =
  'This agent’s session runs in a workspace that is no longer its own: start it again to work in its current one.';
/** How long a list of conversations admits a resume of what it listed. */
const LISTED_MS = 10 * 60 * 1000;
/** The most callers' lists kept for an agent: a new one replaces the oldest. */
const LISTINGS = 8;
const NO_MCP = 'This agent’s MCP servers are managed in its terminal: run /mcp in its terminal.';
const NO_REWIND =
  'This connection cannot rewind here. In its terminal, press Esc twice if the CLI offers it.';
const NOTHING_TO_REWIND = 'This conversation has nothing to rewind yet.';
const NO_EFFORT = 'This agent’s effort is set in its terminal.';
const NO_TASKS = 'This agent’s background tasks are stopped in its terminal.';
const NO_OPTIONS = 'corrallm can’t read that agent’s settings.';
/** How long a session may take to close before the manager stops waiting for it. */
const CLOSE_MS = 5000;

export interface SessionManagerDeps {
  /** What every adapter declares (adapters.ts): the adapter each connection runs, and its modes. */
  catalog: Catalog;
  /**
   * What starts each connection's sessions (connectors.ts); a connection without one cannot run
   * (tests give only those they use).
   */
  connectors: Readonly<Partial<Record<ConnectionId, Connector<SessionMode>>>>;
  /** The environment agents run in: the user's login shell's, cleaned (environment.ts). */
  environment: () => Promise<Readonly<Record<string, string>>>;
  /**
   * The conversations kept for a folder (adapter.ts): listed for /resume,
   * forked to rewind one (`before`: where; `fork`: the copy's id).
   */
  conversations?: Readonly<Partial<Record<AdapterId, Conversations>>>;
  /** The adapter the canvas currently gives this agent, even before its session starts. */
  adapterOf: (canvas: CanvasId, agentId: string) => Promise<AdapterId>;
  /** The core's working-directory seam, shared by all session entry points. */
  directories: DirectoryResolver;
  /** Where each canvas's agents' conversations are remembered. */
  memory: CanvasMemory;
  /** Sends at the CLI boundary, with any core-owned additions, whichever caller sent it. */
  sending?: (
    canvas: CanvasId,
    agentId: string,
    message: UserMessage,
    send: (message: UserMessage) => Promise<void>,
  ) => Promise<void>;
  /**
   * What an agent of each adapter can be set to run with, read in a folder for the agents'
   * environment: without a session, or a prompt.
   */
  options?: Readonly<
    Partial<
      Record<
        AdapterId,
        (context: {
          cwd: string;
          env: Readonly<Record<string, string>>;
        }) => Promise<SettingsOptions>
      >
    >
  >;
  /** Sends an event to the windows showing the canvas whose agent's session it is. */
  emit: (canvas: CanvasId, agentId: string, connection: ConnectionId, event: SessionEvent) => void;
  /** Raw CLI activity, even with no attached terminal view. */
  activity?: (canvas: CanvasId, agentId: string) => void;
  /** Intentional closes need not emit a session event, but end any turn's watchdog. */
  ended?: (canvas: CanvasId, agentId: string) => void;
  /** Sends a terminal event to the view showing the canvas's agent's terminal. */
  terminal?: (canvas: CanvasId, agentId: string, event: TerminalEvent) => void;
  /** The live claims on native conversations (claims.ts): the core's one, else the manager's own. */
  claims?: ConversationClaims;
  /** How a canvas's agent is named to another, quoted as a name (core/parties.ts' quotedName). */
  nameOf?: (canvas: CanvasId, agentId: string) => string;
  /** The time now (epoch ms): when a list of conversations was made, and is too old. */
  now?: () => number;
  /** For tests: how long a session may take to close before the manager stops waiting (CLOSE_MS). */
  closeMs?: number;
}

/**
 * Whether new work may be dispatched to an agent now (B9a Design §3): its working directory ready
 * and the active binding its live session runs in, if one runs; else why it is held (the resolver's
 * reason, or `stale` for a session whose binding is no longer the active one).
 */
export type Availability =
  | { ready: true }
  | {
      ready: false;
      reason: Extract<WorkingDirectory, { state: 'held' }>['reason'] | 'stale';
      sentence: string;
      need?: NeedId;
    };

/** The working directory binding a session launched in, or a list of conversations was made for. */
interface Binding {
  cwd: string;
  workspace: WorkspaceId | null;
  /** The active binding's generation (never the desired plan's). */
  generation: number;
}

/** An agent's session, as the manager keeps it. */
interface Agent {
  connection: ConnectionId;
  /** Its own generation: each session the manager starts has a new one, which its claims carry. */
  generation: number;
  /** The working directory binding it launched in, once its launch resolved it. */
  binding?: Binding;
  /** Whether it is no longer heard: a start completed for a binding no longer active. */
  unheard?: boolean;
  /** Resolves with the session once it runs; rejects if it could not start. */
  session: Promise<LiveSession<SessionMode>>;
}

/**
 * A list of conversations one caller was given for an agent (session:list): the only ones that
 * caller may then open in it, while the agent's adapter and working directory binding are those it
 * was listed in, until LISTED_MS after it was made.
 */
interface Listing {
  adapter: AdapterId;
  binding: Binding;
  ids: Set<string>;
  at: number;
}

/**
 * Every connected session, by the canvas it belongs to and the agent's id. It starts an agent's
 * session with its connection's connector (connector.ts), in the canvas's project folder, resuming
 * the agent's last conversation, and passes requests on to it. It remembers each agent's
 * conversation with the canvas (memory.ts, by the canvas's id), so that sessions survive a
 * restart: one per adapter, shared by its connections. What an agent starts with (its model,
 * effort and mode) is the renderer's to say: its
 * settings, saved in the canvas's file. A window that stops showing the canvas, a new project
 * folder, and the app quitting all end sessions.
 */
export class SessionManager {
  readonly #deps: SessionManagerDeps;
  readonly #agents = new Map<CanvasId, Map<string, Agent>>();
  /** Removed agents still own native processes until their bounded close has finished. */
  readonly #closing = new Map<CanvasId, Set<Promise<void>>>();
  readonly #ending = new WeakMap<Agent, Promise<void>>();
  /**
   * The conversations each caller was last listed for each canvas's agent (session:list), by
   * canvas, agent and caller: the only ones that caller may open in it, at most LISTINGS callers'.
   */
  readonly #listed = new Map<CanvasId, Map<string, Map<string, Listing>>>();
  readonly #claims: ConversationClaims;
  /** The last generation given a session, or a reservation for an agent's next session. */
  #generations = 0;
  /**
   * The agents whose terminal each canvas's view shows (attachTerminal), and what stops the
   * running session's screen being shown there (undefined while none runs).
   */
  readonly #views = new Map<CanvasId, Map<string, (() => void) | undefined>>();

  constructor(deps: SessionManagerDeps) {
    this.#deps = deps;
    this.#claims = deps.claims ?? new ConversationClaims();
  }

  /**
   * Starts an agent's session (resuming its last), unless it runs already with that connection and
   * in the working directory binding that is active now. One running in a binding no longer active
   * (an approved transfer installed another) is replaced; one whose directory is held (a rebind
   * waiting for approval) is kept, its claim and events too, with new work held (`send`).
   */
  async start(canvas: CanvasId, agentId: string, options: SessionOptions): Promise<void> {
    await this.#settled(canvas);
    const agents = this.#agentsOf(canvas);
    const running = agents.get(agentId);
    if (running?.connection === options.connection) {
      const replace = await this.#replaced(canvas, agentId, running);
      // Another start replaced it meanwhile: start again over what runs now.
      if (agents.get(agentId) !== running) return this.start(canvas, agentId, options);
      if (!replace) {
        await running.session;
        return;
      }
    }
    if (options.mode !== null && !this.#hasMode(options.connection, options.mode)) {
      throw new TypeError(`${options.mode} is not a mode of ${options.connection} sessions`);
    }
    if (running) await this.#end(canvas, agentId, running, false);
    // What is not given is the user's own: their CLI's settings, else its defaults.
    const given: SessionOptions = { ...options, effort: options.effort ?? null };
    const agent = { connection: options.connection, generation: this.#generation() } as Agent;
    agent.session = this.#launch(
      canvas,
      agentId,
      given,
      agent,
      () => agents.get(agentId) === agent,
    );
    agents.set(agentId, agent);
    try {
      await agent.session;
    } catch (error) {
      if (agents.get(agentId) === agent) {
        agents.delete(agentId);
        this.#deps.ended?.(canvas, agentId);
      }
      throw error;
    }
    // A view waiting to show the agent's terminal shows this session's.
    this.#show(canvas, agentId, agent);
  }

  /**
   * Sends the agent's session a message, only while its working directory is available and the
   * binding the session runs in is the active one (checked as it is dispatched, B9a Design §3):
   * rejects, saying why, sending nothing and ending nothing, otherwise.
   */
  async send(canvas: CanvasId, agentId: string, message: UserMessage): Promise<void> {
    const agent = this.#agents.get(canvas)?.get(agentId);
    if (!agent) throw new Error(NOT_RUNNING);
    const session = await agent.session;
    await this.#directoryOf(canvas, agentId, agent);
    const send = (next: UserMessage) => session.send(next);
    if (this.#deps.sending) await this.#deps.sending(canvas, agentId, message, send);
    else await send(message);
  }

  /**
   * Whether new work may be dispatched to the agent now (B9a Design §3): for what dispatches it to
   * hold rather than fail, since `send` refuses what this says is held.
   */
  async availability(canvas: CanvasId, agentId: string): Promise<Availability> {
    const directory = await this.#deps.directories.workingDirectory(canvas, agentId as AgentId);
    if (directory.state === 'held') {
      const { reason, sentence, need } = directory;
      return { ready: false, reason, sentence, ...(need === undefined ? {} : { need }) };
    }
    const binding = this.#agents.get(canvas)?.get(agentId)?.binding;
    return binding === undefined || sameBinding(directory, binding)
      ? { ready: true }
      : { ready: false, reason: 'stale', sentence: STALE };
  }

  async answer(
    canvas: CanvasId,
    agentId: string,
    promptId: string,
    answer: SessionAnswer,
  ): Promise<void> {
    await (await this.#session(canvas, agentId)).answer(promptId, answer);
  }

  async interrupt(canvas: CanvasId, agentId: string): Promise<void> {
    await (await this.#session(canvas, agentId)).interrupt();
  }

  /** A stalled turn may end while its reply waits: never stop the next turn instead. */
  async interruptIf(canvas: CanvasId, agentId: string, current: () => boolean): Promise<boolean> {
    const session = await this.#session(canvas, agentId);
    if (!current()) return false;
    await session.interrupt();
    return true;
  }

  /** Switches the agent's session's mode (one of its adapter's). */
  async setMode(canvas: CanvasId, agentId: string, mode: SessionMode): Promise<void> {
    const agent = this.#agents.get(canvas)?.get(agentId);
    if (agent && !this.#hasMode(agent.connection, mode)) {
      throw new TypeError(`${mode} is not a mode of ${agent.connection} sessions`);
    }
    await (await this.#session(canvas, agentId)).setMode(mode);
  }

  /** Switches the agent's session's model. */
  async setModel(canvas: CanvasId, agentId: string, model: string): Promise<void> {
    await (await this.#session(canvas, agentId)).setModel(model);
  }

  /**
   * Switches the agent's session's reasoning effort (null: its model's default), where its
   * connection takes it from corrallm.
   */
  async setEffort(canvas: CanvasId, agentId: string, effort: string | null): Promise<void> {
    const session = await this.#session(canvas, agentId);
    if (!session.setEffort) throw new Error(NO_EFFORT);
    await session.setEffort(effort);
  }

  /**
   * What an agent of `adapter` can be set to run with (its models and their efforts), and the
   * user's own defaults, as read in the canvas's project folder (else the home folder, for the
   * user's own settings alone): without a session, or a prompt.
   */
  async settingsOptions(canvas: CanvasId, adapter: AdapterId): Promise<SettingsOptions> {
    const read = this.#deps.options?.[adapter];
    if (!read) throw new Error(NO_OPTIONS);
    const env = await this.#deps.environment();
    // Options name an adapter, not an agent: read project-wide defaults, then the user's home.
    return read({ cwd: this.#deps.directories.projectRoot(canvas) ?? env.HOME ?? homedir(), env });
  }

  /** What restoring the agent's files to how they were before a message would change. */
  async previewRewind(canvas: CanvasId, agentId: string, messageId: string): Promise<FilesRewind> {
    const session = await this.#session(canvas, agentId);
    if (!session.rewindFiles) throw new Error(NO_REWIND);
    return session.rewindFiles(messageId, true);
  }

  /**
   * Rewinds the agent's session to before one of its messages: its connection's file
   * checkpoints, its conversation, or both. The conversation goes back as a copy of it up to
   * that point, which becomes the agent's own (none, for its first message: it starts afresh);
   * its session ends, to resume that copy when it starts again. The original stays, for /resume.
   * Rejects, changing nothing, if the message is not in the conversation or the files can't be
   * restored.
   */
  async rewind(
    canvas: CanvasId,
    agentId: string,
    messageId: string,
    restore: RewindRestore,
  ): Promise<RewindResult> {
    const agent = this.#agents.get(canvas)?.get(agentId);
    const session = await this.#session(canvas, agentId);
    if (!session.rewindFiles) throw new Error(NO_REWIND);
    const conversation = restore !== 'code';
    // Its conversation is the one its CLI ran in the binding it runs in: only while that is active.
    const folder =
      conversation && agent !== undefined
        ? (await this.#directoryOf(canvas, agentId, agent)).cwd
        : undefined;
    const adapter = await this.#deps.adapterOf(canvas, agentId);
    const id = (await this.#conversation(canvas, adapter, agentId))?.id;
    const kept = this.#deps.conversations?.[adapter];
    let point: string | null = null;
    if (conversation) {
      if (!kept?.before || !kept.fork) throw new Error(NO_REWIND);
      if (folder === undefined || id === undefined) throw new Error(NOTHING_TO_REWIND);
      point = await kept.before(folder, id, messageId);
    }
    let files: FilesRewind | undefined;
    if (restore !== 'conversation') {
      files = await session.rewindFiles(messageId, false);
      if (!files.possible) throw new Error(files.error ?? 'Its files can’t be restored to then.');
    }
    if (conversation && folder !== undefined && id !== undefined && kept?.fork) {
      const forked = point === null ? null : await kept.fork(folder, id, point);
      if (forked !== null) {
        requireConversationId(adapter, forked);
        // The copy is the agent's: reserved for its next session, which resumes it.
        const reserved = this.#claims.reserve(adapter, forked, this.#reservation(canvas, agentId));
        if (!reserved.ok) throw new Error(this.#inUse(canvas, reserved.holder));
      }
      await this.close(canvas, agentId);
      if (forked === null) await this.#forget(canvas, adapter, agentId);
      else await this.#remember(canvas, adapter, agentId, forked);
    }
    return { ...(files === undefined ? {} : { files }), conversation };
  }

  /** The MCP servers of the agent's session, and how each is (/mcp). */
  async mcpServers(canvas: CanvasId, agentId: string): Promise<McpServer[]> {
    const session = await this.#session(canvas, agentId);
    if (!session.mcpServers) throw new Error(NO_MCP);
    return session.mcpServers();
  }

  /** Reconnects, enables or disables one of them; resolves with them all as they are then. */
  async changeMcpServer(
    canvas: CanvasId,
    agentId: string,
    name: string,
    change: McpChange,
  ): Promise<McpServer[]> {
    const session = await this.#session(canvas, agentId);
    if (!session.changeMcpServer || !session.mcpServers) throw new Error(NO_MCP);
    await session.changeMcpServer(name, change);
    return session.mcpServers();
  }

  /**
   * The agent's adapter's conversations for its working directory, most recent first, saying which
   * is the agent's own (the one it runs, or would resume). They are the only ones `caller` (a
   * window, the canvas's runtime: whoever asks, never a token's choice of directory) may then open
   * in it (`resumeSession`), while the directory's binding is the one they were listed in, for
   * LISTED_MS; its newer list replaces this one, and at most LISTINGS callers' are kept.
   */
  async listSessions(canvas: CanvasId, agentId: string, caller: string): Promise<PastSession[]> {
    const directory = await this.#deps.directories.workingDirectory(canvas, agentId as AgentId);
    if (directory.state === 'held') throw new Error(directory.sentence);
    const folder = directory.cwd;
    const adapter = await this.#deps.adapterOf(canvas, agentId);
    const found =
      (await this.#deps.conversations?.[adapter]?.list(folder, await this.#deps.environment())) ??
      [];
    const listed = found.filter((kept) => isConversationId(adapter, kept.id));
    if (listed.length !== found.length) {
      console.warn(
        `Skipped ${String(found.length - listed.length)} invalid ${adapter} conversation ids from the resume list.`,
      );
    }
    const agents = this.#listed.get(canvas) ?? new Map<string, Map<string, Listing>>();
    this.#listed.set(canvas, agents);
    const callers = agents.get(agentId) ?? new Map<string, Listing>();
    agents.set(agentId, callers);
    callers.delete(caller);
    callers.set(caller, {
      adapter,
      binding: bindingOf(directory),
      ids: new Set(listed.map((kept) => kept.id)),
      at: this.#now(),
    });
    for (const oldest of callers.keys()) {
      if (callers.size <= LISTINGS) break;
      callers.delete(oldest);
    }
    const own = (await this.#conversation(canvas, adapter, agentId))?.id;
    return listed.map((kept) => ({ ...kept, current: kept.id === own }));
  }

  /**
   * Makes a conversation the agent's own (/resume): one listed to `caller` for the agent's working
   * directory, in the binding active now, within LISTED_MS, never another; and none another agent's
   * session holds (refused before this one's session closes). The agent's session ends; it resumes
   * that conversation when it starts again, reserved for it meanwhile.
   */
  async resumeSession(
    canvas: CanvasId,
    agentId: string,
    sessionId: string,
    caller: string,
  ): Promise<void> {
    const adapter = await this.#deps.adapterOf(canvas, agentId);
    requireConversationId(adapter, sessionId);
    const listed = this.#listed.get(canvas)?.get(agentId)?.get(caller);
    const directory = await this.#deps.directories.workingDirectory(canvas, agentId as AgentId);
    if (
      listed?.adapter !== adapter ||
      directory.state !== 'ready' ||
      !sameBinding(directory, listed.binding) ||
      this.#now() - listed.at > LISTED_MS ||
      !listed.ids.has(sessionId)
    ) {
      throw new Error(NOT_LISTED);
    }
    // Checked and reserved at once, before this agent's session is closed.
    const reserved = this.#claims.reserve(adapter, sessionId, this.#reservation(canvas, agentId));
    if (!reserved.ok) throw new Error(this.#inUse(canvas, reserved.holder));
    await this.close(canvas, agentId);
    await this.#remember(canvas, adapter, agentId, sessionId);
  }

  /** Stops a task the agent's session runs in the background (the session checks it does). */
  async stopTask(canvas: CanvasId, agentId: string, taskId: string): Promise<void> {
    const session = await this.#session(canvas, agentId);
    if (!session.stopTask) throw new Error(NO_TASKS);
    await session.stopTask(taskId);
  }

  /**
   * Shows an agent's terminal in its canvas's view (the port’s terminal event): the screen of the session
   * that runs, if any, and of each one that starts until the view is detached.
   */
  attachTerminal(canvas: CanvasId, agentId: string): void {
    const views = this.#viewsOf(canvas);
    views.get(agentId)?.();
    views.set(agentId, undefined);
    const agent = this.#agents.get(canvas)?.get(agentId);
    if (agent) this.#show(canvas, agentId, agent);
  }

  /** The canvas's view no longer shows the agent's terminal. */
  detachTerminal(canvas: CanvasId, agentId: string): void {
    const views = this.#views.get(canvas);
    views?.get(agentId)?.();
    views?.delete(agentId);
  }

  /** Keystrokes typed in an agent's terminal view, for its session's terminal, if it runs. */
  async inputTerminal(canvas: CanvasId, agentId: string, data: string): Promise<void> {
    (await this.#running(canvas, agentId))?.terminal?.input(data);
  }

  /**
   * Files dropped on an agent's terminal view (checked paths): those that are there are pasted
   * into its session's terminal, if it runs, quoted (drop.ts).
   */
  async dropOnTerminal(canvas: CanvasId, agentId: string, paths: readonly string[]): Promise<void> {
    const terminal = (await this.#running(canvas, agentId))?.terminal;
    if (!terminal) return;
    const text = await droppedPaste(paths);
    if (text !== '') terminal.paste(text);
  }

  /** An agent's terminal view was resized: so is its session's terminal, if it runs. */
  async resizeTerminal(
    canvas: CanvasId,
    agentId: string,
    cols: number,
    rows: number,
  ): Promise<void> {
    (await this.#running(canvas, agentId))?.terminal?.resize(cols, rows);
  }

  /** Ends an agent's session, if it runs. Its id is kept: starting it again resumes it. */
  async close(canvas: CanvasId, agentId: string): Promise<void> {
    const agent = this.#agents.get(canvas)?.get(agentId);
    if (agent) await this.#end(canvas, agentId, agent, false);
  }

  /** Ends this agent and forgets only the chosen adapter's ID; native history remains untouched. */
  async fresh(canvas: CanvasId, agentId: string, adapter: AdapterId): Promise<void> {
    // A session already closing still owns its conversation until it has.
    await this.#settled(canvas);
    await this.close(canvas, agentId);
    await this.#forget(canvas, adapter, agentId);
    // What it was to resume is forgotten: no conversation of that adapter is reserved for it.
    this.#claims.unreserve(canvas, { agent: agentId, adapter });
    // A failed durable clear must not be reported as a successful fresh conversation.
    await this.#deps.memory.flush();
  }

  /**
   * No window shows the canvas any more (one closed, reloaded or crashed, or opened another
   * canvas): its sessions end. Its conversations are kept, to resume when it is shown again; none
   * stays claimed for it once its sessions have closed, and no list of them admits a resume.
   */
  async closeCanvas(canvas: CanvasId): Promise<void> {
    this.#views.delete(canvas);
    await this.#endAll(canvas, false);
    this.#claims.unreserve(canvas);
    this.#listed.delete(canvas);
    if (this.#agents.get(canvas)?.size === 0) this.#agents.delete(canvas);
  }

  /**
   * The canvas has a new project folder: its sessions end, and the conversations its CLIs ran in
   * the old one are forgotten, to start afresh in the new one.
   */
  async projectChanged(canvas: CanvasId): Promise<void> {
    await this.#endAll(canvas, true);
    this.#claims.unreserve(canvas);
    this.#listed.delete(canvas);
    await this.#deps.memory.update(canvas, (remembered) =>
      withConversationsIn(remembered, PROJECT_WORKSPACE, {}),
    );
  }

  /** Ends every session, as the app quits: resolves once they have all closed. */
  async closeEverything(): Promise<void> {
    const canvases = new Set([...this.#agents.keys(), ...this.#closing.keys()]);
    await Promise.all([...canvases].map((canvas) => this.#endAll(canvas, false)));
    for (const canvas of canvases) this.#claims.unreserve(canvas);
  }

  /**
   * Launches an agent's session, generation `agent.generation`: in the working directory the
   * resolver gives it (held: refused, launching nothing), resuming its remembered conversation if
   * no other agent's session holds it (claimed at once: one that does starts a new conversation
   * instead, saying who holds it, and never clears that holder's), and installed only if the
   * binding it launched in is still the active one once its CLI has started (otherwise closed,
   * unheard). What it claimed is released if it fails, and once it has closed.
   */
  async #launch(
    canvas: CanvasId,
    agentId: string,
    { connection, model, mode, effort, role }: SessionOptions,
    agent: Agent,
    current: () => boolean,
  ): Promise<LiveSession<SessionMode>> {
    // The lookup belongs to the pending launch in #agents: concurrent starts share it, and
    // close must still await and end it while the resolver is answering.
    const directory = await this.#deps.directories.workingDirectory(canvas, agentId as AgentId);
    if (directory.state === 'held') throw new Error(directory.sentence);
    const binding = bindingOf(directory);
    agent.binding = binding;
    const connector = this.#deps.connectors[connection];
    if (connector === undefined) throw new Error(`corrallm can't run ${connection} sessions.`);
    const adapter = this.#adapterOf(connection);
    const remembered = await this.#conversation(canvas, adapter, agentId);
    const owner: ClaimOwner = { canvas, agent: agentId, generation: agent.generation };
    let resume = remembered?.id ?? null;
    let holder: ClaimOwner | undefined;
    if (resume !== null) {
      requireConversationId(adapter, resume);
      // Claimed at once, nothing awaited since it was read: two starts never both resume it.
      const claimed = this.#claims.claim(adapter, resume, owner);
      if (!claimed.ok) {
        holder = claimed.holder;
        resume = null;
      }
    }
    // A session replaced (by another connection, or after it closed), or installed for a binding
    // no longer active, is no longer heard.
    const live = () => current() && agent.unheard !== true;
    try {
      const fingerprint = roleFingerprint(role);
      const roleChanged = remembered?.role !== fingerprint;
      const env = await this.#deps.environment();
      const host: SessionHost = {
        activity: () => {
          if (live()) this.#deps.activity?.(canvas, agentId);
        },
        emit: (event) => {
          if (!live()) return;
          if (event.type === 'closed') {
            this.#agents.get(canvas)?.delete(agentId);
            // It stopped by itself: what it ran is no longer its.
            this.#claims.release(owner);
          }
          this.#deps.emit(canvas, agentId, connection, event);
        },
        remember: (sessionId) => {
          requireConversationId(adapter, sessionId);
          if (!live()) return;
          const claimed = this.#claims.claim(adapter, sessionId, owner);
          if (!claimed.ok) {
            this.#conflict(canvas, agentId, agent, claimed.holder);
            return;
          }
          // One conversation at a time: the one it ran before (until /clear) is no longer its.
          this.#claims.release(owner, { adapter, id: sessionId });
          void this.#remember(canvas, adapter, agentId, sessionId, fingerprint);
        },
      };
      if (holder !== undefined && live()) {
        const where = holder.canvas === canvas ? '' : ' on another canvas';
        this.#deps.emit(canvas, agentId, connection, {
          type: 'notice',
          id: randomUUID(),
          level: 'warning',
          text: `This agent’s conversation is open in ${this.#nameOf(holder)}${where}, so it started a new one: two agents never share one conversation.`,
        });
      }
      const session = await connector.start(
        {
          agentId,
          cwd: directory.cwd,
          env,
          model,
          mode,
          ...(effort === undefined ? {} : { effort }),
          ...(role === undefined ? {} : { role }),
          resume,
          ...(resume === null ? {} : { roleChanged }),
        },
        host,
      );
      // Installed only for the binding it launched in (B9a Design §3): a late start for one no
      // longer active, or while a rebind waits, is closed and unheard.
      const now = await this.#deps.directories.workingDirectory(canvas, agentId as AgentId);
      if (now.state !== 'ready' || !sameBinding(now, binding)) {
        agent.unheard = true;
        await session.close().catch((error: unknown) => {
          console.error(`Could not close ${agentId}'s session:`, error);
        });
        throw new Error(now.state === 'held' ? now.sentence : STALE);
      }
      return session;
    } catch (error) {
      this.#claims.release(owner);
      throw error;
    }
  }

  /**
   * A session reported a conversation another agent's session holds (its terminal's /resume, say):
   * it is stopped, saying why, and never remembers it; its turn isn't replayed as a fresh one.
   */
  #conflict(canvas: CanvasId, agentId: string, agent: Agent, holder: ClaimOwner): void {
    const where = holder.canvas === canvas ? '' : ' on another canvas';
    this.#deps.emit(canvas, agentId, agent.connection, {
      type: 'notice',
      id: randomUUID(),
      level: 'error',
      text: `This agent’s CLI opened a conversation that is open in ${this.#nameOf(holder)}${where}, so corrallm stopped this agent’s session: two agents never share one conversation. Start it again to go on in its own.`,
    });
    void this.#end(canvas, agentId, agent, true).catch((error: unknown) => {
      console.error(`Could not stop ${agentId}'s session:`, error);
    });
  }

  /** What a refused resume of a conversation `holder` holds says. */
  #inUse(canvas: CanvasId, holder: ClaimOwner): string {
    const where = holder.canvas === canvas ? '' : ' on another canvas';
    return `That conversation is open in ${this.#nameOf(holder)}${where}: two agents never share one conversation.`;
  }

  /** A holder's agent, as a notice names it: quoted, escaped and capped. */
  #nameOf({ canvas, agent }: ClaimOwner): string {
    return this.#deps.nameOf?.(canvas, agent) ?? quotedName(agent);
  }

  /** A generation reserved for the agent's next session, which takes over what it reserves. */
  #reservation(canvas: CanvasId, agentId: string): ClaimOwner {
    return { canvas, agent: agentId, generation: this.#generation() };
  }

  #generation(): number {
    this.#generations += 1;
    return this.#generations;
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now();
  }

  /**
   * Whether a running session is to be replaced as it is started again: its binding no longer the
   * active one (an approved transfer installed another). One still launching, or whose directory is
   * held (a rebind waiting, a setup), is kept.
   */
  async #replaced(canvas: CanvasId, agentId: string, agent: Agent): Promise<boolean> {
    const { binding } = agent;
    if (binding === undefined) return false;
    const directory = await this.#deps.directories.workingDirectory(canvas, agentId as AgentId);
    return directory.state === 'ready' && !sameBinding(directory, binding);
  }

  /**
   * The agent's working directory, for work dispatched to its running session: rejects, saying
   * why, while it is held, or once the binding the session runs in is no longer the active one.
   */
  async #directoryOf(
    canvas: CanvasId,
    agentId: string,
    agent: Agent,
  ): Promise<Extract<WorkingDirectory, { state: 'ready' }>> {
    const directory = await this.#deps.directories.workingDirectory(canvas, agentId as AgentId);
    if (directory.state === 'held') throw new Error(directory.sentence);
    if (agent.binding !== undefined && !sameBinding(directory, agent.binding)) {
      throw new Error(STALE);
    }
    return directory;
  }

  /** The adapter `connection` runs (one the catalog lists: the arguments were checked). */
  #adapterOf(connection: ConnectionId): AdapterId {
    const found = connectionIn(this.#deps.catalog, connection);
    if (!found) throw new TypeError(`corrallm can't run ${connection} sessions.`);
    return found.adapter.id;
  }

  /** Whether `mode` is one of the modes of the adapter `connection` runs. */
  #hasMode(connection: ConnectionId, mode: SessionMode): boolean {
    const adapter = adapterIn(this.#deps.catalog, this.#adapterOf(connection));
    return adapter?.modes.some((one) => one.id === mode) ?? false;
  }

  /**
   * The workspace whose conversations an agent's CLI resumes: the one it runs in. Every agent runs
   * in the canvas's project folder itself for now.
   */
  #workspaceOf(): string {
    return PROJECT_WORKSPACE;
  }

  /** The agent's conversation in `adapter`, as remembered with the canvas: what it resumes. */
  async #conversation(
    canvas: CanvasId,
    adapter: AdapterId,
    agentId: string,
  ): Promise<Conversation | undefined> {
    const remembered = await this.#deps.memory.get(canvas);
    const byAdapter = conversationsIn(remembered, this.#workspaceOf());
    const conversations = (Object.hasOwn(byAdapter, adapter) ? byAdapter[adapter] : {}) ?? {};
    return Object.hasOwn(conversations, agentId) ? conversations[agentId] : undefined;
  }

  /** Forgets the agent's conversation in `adapter`: it starts afresh next time. */
  async #forget(canvas: CanvasId, adapter: AdapterId, agentId: string): Promise<void> {
    const workspace = this.#workspaceOf();
    await this.#deps.memory.update(canvas, (remembered) => {
      const byAdapter = conversationsIn(remembered, workspace);
      const kept = Object.entries(byAdapter[adapter] ?? {}).filter(([agent]) => agent !== agentId);
      return withConversationsIn(remembered, workspace, {
        ...byAdapter,
        [adapter]: Object.fromEntries(kept),
      });
    });
  }

  /**
   * Remembers the agent's conversation in `adapter`, and the role fingerprint it launched with
   * (none given: not known, as for one picked with /resume, or a rewind's copy).
   */
  async #remember(
    canvas: CanvasId,
    adapter: AdapterId,
    agentId: string,
    sessionId: string,
    fingerprint?: string,
  ): Promise<void> {
    requireConversationId(adapter, sessionId);
    const conversation: Conversation = {
      id: sessionId,
      ...(fingerprint === undefined ? {} : { role: fingerprint }),
    };
    const workspace = this.#workspaceOf();
    await this.#deps.memory.update(canvas, (remembered) => {
      const byAdapter = conversationsIn(remembered, workspace);
      return withConversationsIn(remembered, workspace, {
        ...byAdapter,
        [adapter]: { ...byAdapter[adapter], [agentId]: conversation },
      });
    });
  }

  /** Shows the agent's session's screen in its canvas's view, if it has a view and a screen. */
  #show(canvas: CanvasId, agentId: string, agent: Agent): void {
    void agent.session.then(
      (session) => {
        const views = this.#views.get(canvas);
        const screen = session.terminal;
        if (!screen || !views?.has(agentId) || this.#agents.get(canvas)?.get(agentId) !== agent) {
          return;
        }
        views.get(agentId)?.();
        views.set(
          agentId,
          screen.show((event) => {
            this.#deps.terminal?.(canvas, agentId, event);
          }),
        );
      },
      () => undefined,
    );
  }

  /** The agent's session, if it runs (or starts) and does start. */
  async #running(canvas: CanvasId, agentId: string): Promise<LiveSession<SessionMode> | undefined> {
    const agent = this.#agents.get(canvas)?.get(agentId);
    return agent?.session.catch(() => undefined);
  }

  #viewsOf(canvas: CanvasId): Map<string, (() => void) | undefined> {
    let views = this.#views.get(canvas);
    if (!views) {
      views = new Map();
      this.#views.set(canvas, views);
    }
    return views;
  }

  async #session(canvas: CanvasId, agentId: string): Promise<LiveSession<SessionMode>> {
    const agent = this.#agents.get(canvas)?.get(agentId);
    if (!agent) throw new Error(NOT_RUNNING);
    return agent.session;
  }

  /** Ends a session, telling the canvas's windows (`tell`) when they did not ask for it. */
  #end(canvas: CanvasId, agentId: string, agent: Agent, tell: boolean): Promise<void> {
    const existing = this.#ending.get(agent);
    if (existing) return existing;
    const pending = this.#closing.get(canvas) ?? new Set<Promise<void>>();
    this.#closing.set(canvas, pending);
    const closing = this.#close(canvas, agentId, agent, tell).finally(() => {
      pending.delete(closing);
      if (pending.size === 0) this.#closing.delete(canvas);
    });
    this.#ending.set(agent, closing);
    pending.add(closing);
    return closing;
  }

  async #close(canvas: CanvasId, agentId: string, agent: Agent, tell: boolean): Promise<void> {
    const agents = this.#agents.get(canvas);
    if (agents?.get(agentId) === agent) {
      agents.delete(agentId);
      this.#deps.ended?.(canvas, agentId);
    }
    if (tell) this.#deps.emit(canvas, agentId, agent.connection, { type: 'closed' });
    let session: LiveSession<SessionMode>;
    try {
      session = await agent.session;
    } catch {
      return; // It never started.
    }
    const owner: ClaimOwner = { canvas, agent: agentId, generation: agent.generation };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        session
          .close()
          .catch((error: unknown) => {
            console.error(`Could not close ${agentId}'s session:`, error);
          })
          // Only once it has actually closed, however long after the manager stopped waiting,
          // and only what this generation holds: never a successor's.
          .finally(() => {
            this.#claims.release(owner);
          }),
        new Promise((resolve) => {
          timer = setTimeout(resolve, this.#deps.closeMs ?? CLOSE_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async #endAll(canvas: CanvasId, tell: boolean): Promise<void> {
    const agents = [...(this.#agents.get(canvas) ?? [])];
    await Promise.all(agents.map(([id, agent]) => this.#end(canvas, id, agent, tell)));
    await this.#settled(canvas);
  }

  async #settled(canvas: CanvasId): Promise<void> {
    for (;;) {
      const pending = this.#closing.get(canvas);
      if (!pending?.size) return;
      await Promise.all(pending);
    }
  }

  #agentsOf(canvas: CanvasId): Map<string, Agent> {
    let agents = this.#agents.get(canvas);
    if (!agents) {
      agents = new Map();
      this.#agents.set(canvas, agents);
    }
    return agents;
  }
}

/** The binding a ready working directory is. */
function bindingOf({
  cwd,
  workspace,
  generation,
}: Extract<WorkingDirectory, { state: 'ready' }>): Binding {
  return { cwd, workspace, generation };
}

/** Whether a ready working directory is still `binding`: its active generation, workspace and folder. */
function sameBinding(
  directory: Extract<WorkingDirectory, { state: 'ready' }>,
  binding: Binding,
): boolean {
  return (
    directory.generation === binding.generation &&
    directory.workspace === binding.workspace &&
    directory.cwd === binding.cwd
  );
}
