import type { WebContents } from 'electron';

import type {
  Connection,
  PermissionMode,
  SessionAnswer,
  SessionEvent,
  SessionOptions,
  UserMessage,
} from '../../shared/session';
import type { CanvasMemory } from '../memory';
import type { Connector, LiveSession, SessionHost } from './connector';

const NO_PROJECT =
  'Choose a project folder for this canvas first (in the bar at the top left): its agents work in it.';
const NOT_RUNNING = 'This agent’s session is not running.';
/** How long a session may take to close before the manager stops waiting for it. */
const CLOSE_MS = 5000;

export interface SessionManagerDeps {
  /** What starts each connection's sessions (connectors.ts). */
  connectors: Readonly<Record<Connection, Connector>>;
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
 * a restart. A canvas opened or forgotten, a new project folder, a renderer that goes, and the app
 * quitting all end sessions.
 */
export class SessionManager {
  readonly #deps: SessionManagerDeps;
  readonly #agents = new Map<WebContents, Map<string, Agent>>();
  /** Each renderer's agents' session ids: what starting an agent again resumes. */
  readonly #ids = new WeakMap<WebContents, Map<string, string>>();
  /** Renderers whose going is watched for. */
  readonly #watched = new WeakSet<WebContents>();

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

  async setMode(contents: WebContents, agentId: string, mode: PermissionMode): Promise<void> {
    await (await this.#session(contents, agentId)).setMode(mode);
  }

  async setModel(contents: WebContents, agentId: string, model: string): Promise<void> {
    await (await this.#session(contents, agentId)).setModel(model);
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
    const { sessions } = file === undefined ? { sessions: {} } : await this.#deps.memory.get(file);
    this.#ids.set(contents, new Map(Object.entries(sessions)));
  }

  /** The renderer's canvas was replaced by a new one: its sessions end, and are forgotten. */
  async canvasForgotten(contents: WebContents): Promise<void> {
    await this.#endAll(contents, true);
    this.#ids.set(contents, new Map());
  }

  /** The canvas was saved (maybe to a new file): the file remembers its agents' sessions. */
  async canvasSaved(contents: WebContents): Promise<void> {
    const file = this.#deps.canvasOf(contents);
    if (file === undefined) return;
    const sessions = Object.fromEntries(this.#idsOf(contents));
    await this.#deps.memory.update(file, (remembered) => ({ ...remembered, sessions }));
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
      void this.#endAll(contents, false).then(() => {
        this.#agents.delete(contents);
      });
    });
    contents.on('did-navigate', () => {
      void this.#endAll(contents, false);
    });
  }
}
