import type { WebContents } from 'electron';

import type {
  Connection,
  PastSession,
  PermissionMode,
  SessionAnswer,
  SessionEvent,
  SessionOptions,
  UserMessage,
} from '../../shared/session';
import type { TerminalEvent } from '../../shared/terminal';
import type { CanvasMemory, Chosen, Remembered } from '../memory';
import type { Connector, LiveSession, SessionHost } from './connector';
import type { KeptConversation } from './sdk/conversations';

const NO_PROJECT =
  'Choose a project folder for this canvas first (in the bar at the top left): its agents work in it.';
const NOT_RUNNING = 'This agent’s session is not running.';
const NOT_LISTED = 'That is not one of this project folder’s conversations.';
/** How long a session may take to close before the manager stops waiting for it. */
const CLOSE_MS = 5000;

export interface SessionManagerDeps {
  /** What starts each connection's sessions (connectors.ts). */
  connectors: Readonly<Record<Connection, Connector>>;
  /** The environment agents run in: the user's login shell's, cleaned (environment.ts). */
  environment: () => Promise<Readonly<Record<string, string>>>;
  /** The conversations Claude Code kept for a folder (sdk/conversations.ts), for /resume. */
  conversations?: { list(folder: string): Promise<KeptConversation[]> };
  /** The folder a renderer's canvas's agents work in, if one was chosen (project.ts). */
  projectOf: (contents: WebContents) => string | undefined;
  /** The file a renderer's canvas was opened from or saved to, if any (canvas.ts). */
  canvasOf: (contents: WebContents) => string | undefined;
  /** Where each canvas file's agents' session ids are remembered. */
  memory: CanvasMemory;
  /** Sends an event to the renderer whose agent's session it is. */
  emit: (
    contents: WebContents,
    agentId: string,
    connection: Connection,
    event: SessionEvent,
  ) => void;
  /** Sends a terminal event to the renderer whose view shows the agent's terminal. */
  terminal?: (contents: WebContents, agentId: string, event: TerminalEvent) => void;
}

/** An agent's session, as the manager keeps it. */
interface Agent {
  connection: Connection;
  /** Resolves with the session once it runs; rejects if it could not start. */
  session: Promise<LiveSession>;
}

/**
 * Every connected session, by the renderer whose canvas it belongs to and the agent's id. It
 * starts an agent's session with its connection's connector (connector.ts), in the canvas's
 * project folder, resuming the agent's last session, and passes the renderer's requests on to it.
 * It remembers each agent's session id with the canvas's file (memory.ts), so that sessions survive
 * a restart, and the model and mode the agent was given (at its start, or switched to since), so
 * that it starts with them again; never bypassing permissions, which the user chooses afresh each
 * time. A canvas opened or forgotten, a new project folder, a renderer that goes, and the app
 * quitting all end sessions.
 */
export class SessionManager {
  readonly #deps: SessionManagerDeps;
  readonly #agents = new Map<WebContents, Map<string, Agent>>();
  /** Each renderer's agents' session ids: what starting an agent again resumes. */
  readonly #ids = new WeakMap<WebContents, Map<string, string>>();
  /** The model and mode each renderer's agents were given: what starting them again uses. */
  readonly #chosen = new WeakMap<WebContents, Map<string, Chosen>>();
  /** Renderers whose going is watched for. */
  readonly #watched = new WeakSet<WebContents>();
  /** The conversations each renderer was last listed (session:list): the only ones it may open. */
  readonly #listed = new WeakMap<WebContents, { folder: string; ids: Set<string> }>();
  /**
   * The agents whose terminal each renderer's view shows (attachTerminal), and what stops the
   * running session's screen being shown there (undefined while none runs).
   */
  readonly #views = new Map<WebContents, Map<string, (() => void) | undefined>>();

  constructor(deps: SessionManagerDeps) {
    this.#deps = deps;
  }

  /** Starts an agent's session (resuming its last), unless it runs already with that connection. */
  async start(contents: WebContents, agentId: string, options: SessionOptions): Promise<void> {
    const agents = this.#agentsOf(contents);
    const running = agents.get(agentId);
    if (running?.connection === options.connection) {
      await running.session;
      return;
    }
    if (running) await this.#end(contents, agentId, running, false);
    const cwd = this.#deps.projectOf(contents);
    if (cwd === undefined) throw new Error(NO_PROJECT);
    this.#watch(contents);
    // What the user chose now, or else what the agent was given before.
    void this.#choose(contents, agentId, options);
    const chosen = this.#chosenOf(contents).get(agentId);
    const given: SessionOptions = {
      connection: options.connection,
      model: options.model ?? chosen?.model ?? null,
      mode: options.mode ?? chosen?.mode ?? null,
    };
    const agent: Agent = {
      connection: options.connection,
      session: this.#launch(contents, agentId, cwd, given, () => agents.get(agentId) === agent),
    };
    agents.set(agentId, agent);
    try {
      await agent.session;
    } catch (error) {
      if (agents.get(agentId) === agent) agents.delete(agentId);
      throw error;
    }
    // A view waiting to show the agent's terminal shows this session's.
    this.#show(contents, agentId, agent);
  }

  async send(contents: WebContents, agentId: string, message: UserMessage): Promise<void> {
    await (await this.#session(contents, agentId)).send(message);
  }

  async answer(
    contents: WebContents,
    agentId: string,
    promptId: string,
    answer: SessionAnswer,
  ): Promise<void> {
    await (await this.#session(contents, agentId)).answer(promptId, answer);
  }

  async interrupt(contents: WebContents, agentId: string): Promise<void> {
    await (await this.#session(contents, agentId)).interrupt();
  }

  /** Switches the agent's session's mode: what it starts in next time too (but bypassing). */
  async setMode(contents: WebContents, agentId: string, mode: PermissionMode): Promise<void> {
    await (await this.#session(contents, agentId)).setMode(mode);
    await this.#choose(contents, agentId, { mode });
  }

  /** Switches the agent's session's model: what it starts with next time too. */
  async setModel(contents: WebContents, agentId: string, model: string): Promise<void> {
    await (await this.#session(contents, agentId)).setModel(model);
    await this.#choose(contents, agentId, { model });
  }

  /**
   * The conversations Claude Code kept for the canvas's project folder, most recent first, saying
   * which is the agent's own (the one it runs, or would resume). They are the only ones the
   * renderer may then open (`resumeSession`).
   */
  async listSessions(contents: WebContents, agentId: string): Promise<PastSession[]> {
    const folder = this.#deps.projectOf(contents);
    if (folder === undefined) throw new Error(NO_PROJECT);
    const listed = (await this.#deps.conversations?.list(folder)) ?? [];
    this.#listed.set(contents, { folder, ids: new Set(listed.map((kept) => kept.id)) });
    const own = this.#idsOf(contents).get(agentId);
    return listed.map((kept) => ({ ...kept, current: kept.id === own }));
  }

  /**
   * Makes a conversation the agent's own (/resume): one listed for the canvas's project folder,
   * never another. The agent's session ends; it resumes that conversation when it starts again.
   */
  async resumeSession(contents: WebContents, agentId: string, sessionId: string): Promise<void> {
    const listed = this.#listed.get(contents);
    if (!listed || listed.folder !== this.#deps.projectOf(contents) || !listed.ids.has(sessionId)) {
      throw new Error(NOT_LISTED);
    }
    await this.close(contents, agentId);
    await this.#remember(contents, agentId, sessionId);
  }

  /**
   * Shows an agent's terminal in the renderer's view (terminal:event): the screen of the session
   * that runs, if any, and of each one that starts until the view is detached.
   */
  attachTerminal(contents: WebContents, agentId: string): void {
    this.#watch(contents);
    const views = this.#viewsOf(contents);
    views.get(agentId)?.();
    views.set(agentId, undefined);
    const agent = this.#agents.get(contents)?.get(agentId);
    if (agent) this.#show(contents, agentId, agent);
  }

  /** The renderer's view no longer shows the agent's terminal. */
  detachTerminal(contents: WebContents, agentId: string): void {
    const views = this.#views.get(contents);
    views?.get(agentId)?.();
    views?.delete(agentId);
  }

  /** Keystrokes typed in an agent's terminal view, for its session's terminal, if it runs. */
  async inputTerminal(contents: WebContents, agentId: string, data: string): Promise<void> {
    (await this.#running(contents, agentId))?.terminal?.input(data);
  }

  /** An agent's terminal view was resized: so is its session's terminal, if it runs. */
  async resizeTerminal(
    contents: WebContents,
    agentId: string,
    cols: number,
    rows: number,
  ): Promise<void> {
    (await this.#running(contents, agentId))?.terminal?.resize(cols, rows);
  }

  /** Ends an agent's session, if it runs. Its id is kept: starting it again resumes it. */
  async close(contents: WebContents, agentId: string): Promise<void> {
    const agent = this.#agents.get(contents)?.get(agentId);
    if (agent) await this.#end(contents, agentId, agent, false);
  }

  /**
   * A canvas opened in the renderer: the old canvas's sessions end; the new one's ids load, and
   * what its agents were given.
   */
  async canvasOpened(contents: WebContents): Promise<void> {
    await this.#endAll(contents, true);
    const file = this.#deps.canvasOf(contents);
    const { sessions, chosen = {} } =
      file === undefined ? { sessions: {} } : await this.#deps.memory.get(file);
    this.#ids.set(contents, new Map(Object.entries(sessions)));
    this.#chosen.set(contents, new Map(Object.entries(chosen)));
  }

  /** The renderer's canvas was replaced by a new one: its sessions end, and are forgotten. */
  async canvasForgotten(contents: WebContents): Promise<void> {
    await this.#endAll(contents, true);
    this.#ids.set(contents, new Map());
    this.#chosen.set(contents, new Map());
  }

  /**
   * The canvas was saved (maybe to a new file): the file remembers its agents' sessions, and what
   * they were given.
   */
  async canvasSaved(contents: WebContents): Promise<void> {
    const file = this.#deps.canvasOf(contents);
    if (file === undefined) return;
    const sessions = Object.fromEntries(this.#idsOf(contents));
    const chosen = Object.fromEntries(this.#chosenOf(contents));
    await this.#deps.memory.update(file, (remembered) => {
      const next: Remembered = { ...remembered, sessions, chosen };
      if (Object.keys(chosen).length === 0) delete next.chosen;
      return next;
    });
  }

  /** The canvas has a new project folder: its sessions end and are forgotten, to start afresh there. */
  async projectChanged(contents: WebContents): Promise<void> {
    await this.#endAll(contents, true);
    this.#ids.set(contents, new Map());
    await this.canvasSaved(contents);
  }

  /** Ends every session, as the app quits: resolves once they have all closed. */
  async closeEverything(): Promise<void> {
    await Promise.all([...this.#agents.keys()].map((contents) => this.#endAll(contents, false)));
  }

  async #launch(
    contents: WebContents,
    agentId: string,
    cwd: string,
    { connection, model, mode }: SessionOptions,
    current: () => boolean,
  ): Promise<LiveSession> {
    const resume = this.#idsOf(contents).get(agentId) ?? null;
    const env = await this.#deps.environment();
    // A session replaced (by another connection, or after it closed) is no longer heard.
    const host: SessionHost = {
      emit: (event) => {
        if (!current()) return;
        if (event.type === 'closed') this.#agents.get(contents)?.delete(agentId);
        this.#deps.emit(contents, agentId, connection, event);
      },
      remember: (sessionId) => {
        if (current()) void this.#remember(contents, agentId, sessionId);
      },
    };
    return this.#deps.connectors[connection].start(
      { agentId, cwd, env, model, mode, resume },
      host,
    );
  }

  async #remember(contents: WebContents, agentId: string, sessionId: string): Promise<void> {
    this.#idsOf(contents).set(agentId, sessionId);
    const file = this.#deps.canvasOf(contents);
    if (file === undefined) return;
    await this.#deps.memory.update(file, (remembered) => ({
      ...remembered,
      sessions: { ...remembered.sessions, [agentId]: sessionId },
    }));
  }

  /**
   * Records what the user chose for an agent (each of `model` and `mode` that is not null), with
   * the canvas's file if it has one. Choosing to bypass permissions forgets the mode instead: a
   * session never starts bypassing them unless the user says so then.
   */
  async #choose(
    contents: WebContents,
    agentId: string,
    { model = null, mode = null }: { model?: string | null; mode?: PermissionMode | null },
  ): Promise<void> {
    if (model === null && mode === null) return;
    const all = this.#chosenOf(contents);
    const { model: before, mode: was } = all.get(agentId) ?? {};
    const kept = mode === null ? was : mode === 'bypassPermissions' ? undefined : mode;
    const chosen: Chosen = {
      ...((model ?? before) === undefined ? {} : { model: model ?? before }),
      ...(kept === undefined ? {} : { mode: kept }),
    };
    if (Object.keys(chosen).length === 0) all.delete(agentId);
    else all.set(agentId, chosen);
    const file = this.#deps.canvasOf(contents);
    if (file === undefined) return;
    await this.#deps.memory.update(file, (remembered) => {
      const others = Object.entries(remembered.chosen ?? {}).filter(([id]) => id !== agentId);
      if (Object.keys(chosen).length > 0) others.push([agentId, chosen]);
      const next: Remembered = { ...remembered, chosen: Object.fromEntries(others) };
      if (others.length === 0) delete next.chosen;
      return next;
    });
  }

  /** Shows the agent's session's screen in the renderer's view, if it has a view and a screen. */
  #show(contents: WebContents, agentId: string, agent: Agent): void {
    void agent.session.then(
      (session) => {
        const views = this.#views.get(contents);
        const screen = session.terminal;
        if (!screen || !views?.has(agentId) || this.#agents.get(contents)?.get(agentId) !== agent) {
          return;
        }
        views.get(agentId)?.();
        views.set(
          agentId,
          screen.show((event) => {
            this.#deps.terminal?.(contents, agentId, event);
          }),
        );
      },
      () => undefined,
    );
  }

  /** The agent's session, if it runs (or starts) and does start. */
  async #running(contents: WebContents, agentId: string): Promise<LiveSession | undefined> {
    const agent = this.#agents.get(contents)?.get(agentId);
    return agent?.session.catch(() => undefined);
  }

  #viewsOf(contents: WebContents): Map<string, (() => void) | undefined> {
    let views = this.#views.get(contents);
    if (!views) {
      views = new Map();
      this.#views.set(contents, views);
    }
    return views;
  }

  async #session(contents: WebContents, agentId: string): Promise<LiveSession> {
    const agent = this.#agents.get(contents)?.get(agentId);
    if (!agent) throw new Error(NOT_RUNNING);
    return agent.session;
  }

  /** Ends a session, telling the renderer (`tell`) when it did not ask for it. */
  async #end(contents: WebContents, agentId: string, agent: Agent, tell: boolean): Promise<void> {
    const agents = this.#agents.get(contents);
    if (agents?.get(agentId) === agent) agents.delete(agentId);
    if (tell) this.#deps.emit(contents, agentId, agent.connection, { type: 'closed' });
    let session: LiveSession;
    try {
      session = await agent.session;
    } catch {
      return; // It never started.
    }
    await Promise.race([
      session.close().catch((error: unknown) => {
        console.error(`Could not close ${agentId}'s session:`, error);
      }),
      new Promise((resolve) => setTimeout(resolve, CLOSE_MS)),
    ]);
  }

  async #endAll(contents: WebContents, tell: boolean): Promise<void> {
    const agents = [...(this.#agents.get(contents) ?? [])];
    await Promise.all(agents.map(([id, agent]) => this.#end(contents, id, agent, tell)));
  }

  #agentsOf(contents: WebContents): Map<string, Agent> {
    let agents = this.#agents.get(contents);
    if (!agents) {
      agents = new Map();
      this.#agents.set(contents, agents);
    }
    return agents;
  }

  #chosenOf(contents: WebContents): Map<string, Chosen> {
    let chosen = this.#chosen.get(contents);
    if (!chosen) {
      chosen = new Map();
      this.#chosen.set(contents, chosen);
    }
    return chosen;
  }

  #idsOf(contents: WebContents): Map<string, string> {
    let ids = this.#ids.get(contents);
    if (!ids) {
      ids = new Map();
      this.#ids.set(contents, ids);
    }
    return ids;
  }

  /** A renderer that goes, or loads another page, takes its sessions with it. */
  #watch(contents: WebContents): void {
    if (this.#watched.has(contents)) return;
    this.#watched.add(contents);
    contents.once('destroyed', () => {
      this.#views.delete(contents);
      void this.#endAll(contents, false).then(() => {
        this.#agents.delete(contents);
      });
    });
    contents.on('did-navigate', () => {
      this.#views.delete(contents);
      void this.#endAll(contents, false);
    });
  }
}
