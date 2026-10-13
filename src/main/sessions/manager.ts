import type { WebContents } from 'electron';

import { CONNECTION_CLI, isModeOf } from '../../shared/session';
import type {
  Cli,
  Connection,
  SessionAnswer,
  SessionEvent,
  SessionMode,
  SessionOptions,
  UserMessage,
} from '../../shared/session';
import type { TerminalEvent } from '../../shared/terminal';
import type { CanvasMemory, Remembered } from '../memory';
import type { Connector, LiveSession, SessionHost } from './connector';

const NO_PROJECT =
  'Choose a project folder for this canvas first (in the bar at the top left): its agents work in it.';
const NOT_RUNNING = 'This agent’s session is not running.';
/** How long a session may take to close before the manager stops waiting for it. */
const CLOSE_MS = 5000;

export interface SessionManagerDeps {
  /**
   * What starts each connection's sessions (connectors.ts); a connection without one cannot run
   * (tests give only those they use).
   */
  connectors: Readonly<Partial<Record<Connection, Connector<SessionMode>>>>;
  /** The environment agents run in: the user's login shell's, cleaned (environment.ts). */
  environment: () => Promise<Readonly<Record<string, string>>>;
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
  session: Promise<LiveSession<SessionMode>>;
}

/** Where each CLI's session ids are remembered with a canvas file (memory.ts). */
const REMEMBERED: Record<Cli, 'sessions' | 'threads'> = { claude: 'sessions', codex: 'threads' };

/**
 * Every connected session, by the renderer whose canvas it belongs to and the agent's id. It
 * starts an agent's session with its connection's connector (connector.ts), in the canvas's
 * project folder, resuming the agent's last session, and passes the renderer's requests on to it.
 * It remembers each agent's session id with the canvas's file (memory.ts), so that sessions survive
 * a restart: one per CLI (Claude Code's session, Codex's thread), which each of its connections
 * resumes. A canvas opened or forgotten, a new project folder, a renderer that goes, and the app
 * quitting all end sessions.
 */
export class SessionManager {
  readonly #deps: SessionManagerDeps;
  readonly #agents = new Map<WebContents, Map<string, Agent>>();
  /** Each renderer's agents' session ids, per CLI: what starting an agent again resumes. */
  readonly #ids = new WeakMap<WebContents, Record<Cli, Map<string, string>>>();
  /** Renderers whose going is watched for. */
  readonly #watched = new WeakSet<WebContents>();
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
    if (!isModeOf(CONNECTION_CLI[options.connection], options.mode)) {
      throw new TypeError(`${options.mode} is not a mode of ${options.connection} sessions`);
    }
    if (running) await this.#end(contents, agentId, running, false);
    const cwd = this.#deps.projectOf(contents);
    if (cwd === undefined) throw new Error(NO_PROJECT);
    this.#watch(contents);
    const agent: Agent = {
      connection: options.connection,
      session: this.#launch(contents, agentId, cwd, options, () => agents.get(agentId) === agent),
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

  /** Switches the agent's session's mode: one of its CLI's modes. */
  async setMode(contents: WebContents, agentId: string, mode: SessionMode): Promise<void> {
    const agent = this.#agents.get(contents)?.get(agentId);
    if (agent && !isModeOf(CONNECTION_CLI[agent.connection], mode)) {
      throw new TypeError(`${mode} is not a mode of ${agent.connection} sessions`);
    }
    await (await this.#session(contents, agentId)).setMode(mode);
  }

  async setModel(contents: WebContents, agentId: string, model: string): Promise<void> {
    await (await this.#session(contents, agentId)).setModel(model);
  }

  /** Switches the agent's session's reasoning effort, where its connection offers a choice. */
  async setEffort(contents: WebContents, agentId: string, effort: string | null): Promise<void> {
    const session = await this.#session(contents, agentId);
    if (!session.setEffort)
      throw new Error('This agent’s session has no reasoning effort to choose.');
    await session.setEffort(effort);
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

  /** A canvas opened in the renderer: the old canvas's sessions end; the new one's ids load. */
  async canvasOpened(contents: WebContents): Promise<void> {
    await this.#endAll(contents, true);
    const file = this.#deps.canvasOf(contents);
    const remembered = file === undefined ? undefined : await this.#deps.memory.get(file);
    this.#ids.set(contents, {
      claude: new Map(Object.entries(remembered?.sessions ?? {})),
      codex: new Map(Object.entries(remembered?.threads ?? {})),
    });
  }

  /** The renderer's canvas was replaced by a new one: its sessions end, and are forgotten. */
  async canvasForgotten(contents: WebContents): Promise<void> {
    await this.#endAll(contents, true);
    this.#ids.set(contents, noIds());
  }

  /** The canvas was saved (maybe to a new file): the file remembers its agents' sessions. */
  async canvasSaved(contents: WebContents): Promise<void> {
    const file = this.#deps.canvasOf(contents);
    if (file === undefined) return;
    const ids = this.#idsOf(contents);
    await this.#deps.memory.update(file, (remembered) => {
      const next: Remembered = { ...remembered, sessions: Object.fromEntries(ids.claude) };
      if (ids.codex.size > 0) next.threads = Object.fromEntries(ids.codex);
      else delete next.threads;
      return next;
    });
  }

  /** The canvas has a new project folder: its sessions end and are forgotten, to start afresh there. */
  async projectChanged(contents: WebContents): Promise<void> {
    await this.#endAll(contents, true);
    this.#ids.set(contents, noIds());
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
    { connection, model, mode, effort }: SessionOptions,
    current: () => boolean,
  ): Promise<LiveSession<SessionMode>> {
    const connector = this.#deps.connectors[connection];
    if (connector === undefined) throw new Error(`corrallm can't run ${connection} sessions.`);
    const cli = CONNECTION_CLI[connection];
    const resume = this.#idsOf(contents)[cli].get(agentId) ?? null;
    const env = await this.#deps.environment();
    // A session replaced (by another connection, or after it closed) is no longer heard.
    const host: SessionHost = {
      emit: (event) => {
        if (!current()) return;
        if (event.type === 'closed') this.#agents.get(contents)?.delete(agentId);
        this.#deps.emit(contents, agentId, connection, event);
      },
      remember: (sessionId) => {
        if (current()) void this.#remember(contents, cli, agentId, sessionId);
      },
    };
    return connector.start(
      { agentId, cwd, env, model, mode, ...(effort === undefined ? {} : { effort }), resume },
      host,
    );
  }

  async #remember(
    contents: WebContents,
    cli: Cli,
    agentId: string,
    sessionId: string,
  ): Promise<void> {
    this.#idsOf(contents)[cli].set(agentId, sessionId);
    const file = this.#deps.canvasOf(contents);
    if (file === undefined) return;
    const field = REMEMBERED[cli];
    await this.#deps.memory.update(file, (remembered): Remembered => ({
      ...remembered,
      [field]: { ...remembered[field], [agentId]: sessionId },
    }));
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
  async #running(
    contents: WebContents,
    agentId: string,
  ): Promise<LiveSession<SessionMode> | undefined> {
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

  async #session(contents: WebContents, agentId: string): Promise<LiveSession<SessionMode>> {
    const agent = this.#agents.get(contents)?.get(agentId);
    if (!agent) throw new Error(NOT_RUNNING);
    return agent.session;
  }

  /** Ends a session, telling the renderer (`tell`) when it did not ask for it. */
  async #end(contents: WebContents, agentId: string, agent: Agent, tell: boolean): Promise<void> {
    const agents = this.#agents.get(contents);
    if (agents?.get(agentId) === agent) agents.delete(agentId);
    if (tell) this.#deps.emit(contents, agentId, agent.connection, { type: 'closed' });
    let session: LiveSession<SessionMode>;
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

  #idsOf(contents: WebContents): Record<Cli, Map<string, string>> {
    let ids = this.#ids.get(contents);
    if (!ids) {
      ids = noIds();
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

/** No session ids, for any CLI. */
function noIds(): Record<Cli, Map<string, string>> {
  return { claude: new Map(), codex: new Map() };
}
