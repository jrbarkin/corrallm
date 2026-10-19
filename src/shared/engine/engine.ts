import type { ConnectionId } from '../adapter';
import type { CanvasNode } from '../model/canvas';
import type { UsageState } from '../usage';
import type { EngineCatalog } from './catalog';
import { SessionStore } from './delivery/mailbox';
import { decodeSubmissions } from './delivery/submission-state';
import { readRun } from './run/checkpoint';
import { RunStore } from './run/runner';
import type { SessionBackend } from './transcript/receive';

/*
 * One canvas's engine: its run (run/runner.ts) and the sessions the run sends to
 * (delivery/mailbox.ts), wired to each other. Whoever runs it hosts it: the renderer, its sessions
 * in main over IPC; or the core, its sessions in the same process (src/main/core/engines.ts). It
 * reads the canvas's nodes as they change (`update`); its run and its sessions' manual messages
 * are saved and restored together (`checkpoint`, `restore`), as a run checkpoint's state and
 * messages (src/shared/run.ts).
 */

export interface EngineIO {
  /** What the engine reads of the catalog, which the host has. */
  catalog: EngineCatalog;
  /** Where its agents' sessions run. */
  backend: SessionBackend;
  /** Runs `run` in `ms`; returns a function that cancels it: the host's timers. */
  later: (run: () => void, ms: number) => () => void;
  /** The time now (epoch ms): the only clock the run reads. */
  now: () => number;
  /** Every usage backend's latest reading and its usage rule, read when the run needs them. */
  usage?: () => UsageState;
  /**
   * Runs an agent another way: the connection the user chose for it, as its session would not
   * start. The canvas is the host's, which changes it, then gives the engine its nodes again.
   */
  connect: (agent: string, connection: ConnectionId) => void;
  /** Writes the engine's checkpoint out, before an automated message leaves for a session. */
  beforeSend?: () => Promise<void>;
  /** The locale the run tells times of day in (the host's): the runtime's own, when none. */
  locale?: string;
}

/** What a checkpoint keeps of an engine: its run, and its sessions' manual messages. */
export interface EngineCheckpoint {
  state: string;
  messages: string;
}

export class Engine {
  /** What it reads of the catalog: what views of its run read too. */
  readonly catalog: EngineCatalog;
  readonly sessions: SessionStore;
  readonly run: RunStore;

  constructor(io: EngineIO) {
    this.catalog = io.catalog;
    // The run hears what the user sends an agent it holds, and how its turn ends; a message is
    // shown where the agent's queue is.
    const sessions = new SessionStore(
      io.catalog,
      io.backend,
      (id) => {
        const at = this.run.snapshot().agents[id];
        return at?.current ?? Object.keys(at?.outcomes ?? {}).at(-1);
      },
      {
        submitted: (agent, message) => {
          if (message.text.trim().startsWith('/')) return;
          const task = this.run.observeSubmission(agent, message.id, message.text);
          if (task) sessions.tagSubmission(agent, message.id, task.agent, task.item);
        },
        ended: (agent, message, reply, result) => {
          this.run.observeEnd(agent, message, reply, result);
        },
      },
    );
    this.sessions = sessions;
    this.run = new RunStore(io.catalog, {
      hold: (agent, held) => {
        sessions.holdQueue(agent, held);
      },
      ...(io.beforeSend ? { beforeSend: io.beforeSend } : {}),
      send: (agent, text, done, images, refused, origin, displayText) =>
        sessions.send(
          agent.id,
          agent.data.adapter ?? io.catalog.defaultAdapter,
          text,
          (failed, reply, result) => {
            done({ failed, reply, result });
          },
          images && [...images],
          refused,
          // What the user typed for the run (an OK's changes) is theirs, but the run's attempt.
          origin === 'user' ? 'run' : 'queue',
          displayText,
        ),
      tell: (agent, text) => {
        sessions.notice(agent.id, 'warning', text);
      },
      connect: (agent, connection) => {
        io.connect(agent.id, connection);
      },
      later: io.later,
      now: io.now,
      ...(io.usage ? { usage: io.usage } : {}),
      unheard: (agent) => sessions.of(agent.id).unheard !== undefined,
      ...(io.locale === undefined ? {} : { locale: io.locale }),
    });
  }

  /**
   * The canvas's nodes, as they change: the sessions follow its agents, how each runs and what each
   * is set to run with, before the run reads the queues, which may send agents messages.
   */
  update(nodes: readonly CanvasNode[]): void {
    this.sessions.sync(
      nodes.flatMap((n) =>
        n.type === 'agent'
          ? [
              {
                id: n.id,
                connection: this.catalog.connectionOf(n.data),
                settings: n.data.settings,
                role: n.data.role,
              },
            ]
          : [],
      ),
    );
    this.run.update(nodes);
  }

  /** What a checkpoint keeps of it now. */
  checkpoint(): EngineCheckpoint {
    return { state: this.run.checkpoint(), messages: this.sessions.serializeSubmissions() };
  }

  /** Throws, saying why, if a checkpoint could not be restored: before anything is changed. */
  static check(saved: EngineCheckpoint): void {
    readRun(saved.state);
    decodeSubmissions(saved.messages);
  }

  /** Restores a checkpoint, over the canvas's nodes it was last given: the run, held paused. */
  restore(saved: EngineCheckpoint): void {
    this.sessions.restoreSubmissions(saved.messages);
    this.run.restore(saved.state);
  }

  /** Forgets the run and every session, as for another canvas. */
  reset(): void {
    this.run.reset();
    this.sessions.reset();
  }
}
