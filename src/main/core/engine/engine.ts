import type { ConnectionId } from '../../../shared/adapter';
import type { CanvasNode } from '../../../shared/model/canvas';
import type { TaskMessage } from '../../../shared/session';
import type { UsageState } from '../../../shared/usage';
import type { EngineCatalog } from '../../../shared/model/catalog';
import { SessionStore } from './delivery/mailbox';
import { decodeSubmissions } from './delivery/submission-state';
import { readRun } from './run/checkpoint';
import { RunStore } from './run/runner';
import type { RunIO, RunMailbox } from './run/runner';
import type { SessionBackend } from './transcript/receive';

/*
 * One canvas's engine: its run (run/runner.ts) and the sessions the run sends to
 * (delivery/mailbox.ts), wired to each other and hosted only by the core, its sessions in the
 * same process (src/main/core/engines.ts). It
 * reads the canvas's nodes as they change (`update`); its run and its sessions' manual messages
 * are saved and restored together (`checkpoint`, `restore`), as a run checkpoint's state and
 * messages (src/shared/model/run.ts).
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
  /** Writes the engine's checkpoint out, before an automated message leaves for a session. */
  beforeSend?: () => Promise<void>;
  /**
   * Where the run's sends of its tasks' attempts are recorded before they go (RunMailbox): the
   * core's message store. Unit harnesses may omit it.
   */
  mailbox?: RunMailbox;
  /** The locale the run tells times of day in (the host's): the runtime's own, when none. */
  locale?: string;
  /** B11a C3: admission before the run's tasks go (RunIO.admit): the core's fallback service. */
  admit?: RunIO['admit'];
  /** B11a C3: what a task held on a usage limit says of its recipient's chain (RunIO.limitNote). */
  limitNote?: RunIO['limitNote'];
  /** B11a C7: whether a handoff request holds an agent's next task (RunIO.handoff). */
  handoff?: RunIO['handoff'];
}

/** How often a held retry (Interrupt and resend) is checked again while something holds it. */
export const RETRY_CHECK_MS = 250;

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
  readonly #connections = new Map<string, ConnectionId>();
  /**
   * The attempts to retry once nothing holds their recipient, by owner: until when an exhausted
   * backend holds the recipient (read as each is looked at), and whether the turn's cancelled end
   * confirmed it.
   */
  readonly #retries = new Map<
    string,
    { recipient: string; item: string; attempt: string; until: () => number; confirmed: boolean }
  >();
  #cancelRetry: (() => void) | undefined;
  #checkingRetry = false;
  readonly #io: EngineIO;

  constructor(io: EngineIO) {
    this.#io = io;
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
      ...(io.mailbox ? { mailbox: io.mailbox } : {}),
      send: (agent, text, done, images, refused, origin, displayText, task, id, resolvedStep) =>
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
          {
            ...(task === undefined ? {} : { task }),
            ...(id === undefined ? {} : { id }),
            ...(resolvedStep === undefined ? {} : { resolvedStep }),
          },
        ),
      tell: (agent, text) => {
        sessions.notice(agent.id, 'warning', text);
      },
      later: io.later,
      now: io.now,
      ...(io.usage ? { usage: io.usage } : {}),
      unheard: (agent) => sessions.of(agent.id).unheard !== undefined,
      ...(io.locale === undefined ? {} : { locale: io.locale }),
      ...(io.admit === undefined ? {} : { admit: io.admit }),
      ...(io.limitNote === undefined ? {} : { limitNote: io.limitNote }),
      ...(io.handoff === undefined ? {} : { handoff: io.handoff }),
    });
    this.run.subscribe(() => {
      this.#checkRetries();
    });
    sessions.subscribe(() => {
      this.#checkRetries();
    });
  }

  /**
   * Retries a task's attempt that an interrupted turn's cancelled end cancelled, as the core's
   * resend reservation asks on that end (Engines.retryAttempt, B11 Design §16.7): through its held
   * problem's Retry, a new attempt with retryOf, once nothing holds its recipient (a pause, a usage
   * rule, a backend exhausted `until` then, a mode that never asks, its session busy). Once: it is
   * forgotten as it retries, or as its owner moves on. Whether it was taken: not for an attempt that
   * isn't its owner's current task's last, cancelled and held for the user.
   */
  retryAttempt({ agent, item, attempt }: TaskMessage, until: () => number = () => 0): boolean {
    const at = this.run.snapshot().agents[agent];
    const last = at?.attempts?.[item]?.at(-1);
    if (
      at?.current !== item ||
      last?.id !== attempt ||
      last.status !== 'cancelled' ||
      at.problem?.kind !== 'cancelled'
    ) {
      return false;
    }
    this.#retries.set(agent, {
      recipient: at.problem.agent,
      item,
      attempt,
      until,
      confirmed: true,
    });
    this.#checkRetries();
    return true;
  }

  #checkRetries(): void {
    if (this.#retries.size === 0) {
      this.#cancelRetry?.();
      this.#cancelRetry = undefined;
      return;
    }
    if (this.#checkingRetry) return;
    this.#checkingRetry = true;
    queueMicrotask(() => {
      this.#checkingRetry = false;
      this.#cancelRetry?.();
      this.#cancelRetry = undefined;
      for (const [owner, requested] of this.#retries) {
        const run = this.run.snapshot();
        const at = run.agents[owner];
        const last = at?.attempts?.[requested.item]?.at(-1);
        const session = this.sessions.of(requested.recipient);
        if (
          at?.current !== requested.item ||
          last?.id !== requested.attempt ||
          (last.status !== 'running' &&
            (!requested.confirmed ||
              at.problem?.kind !== 'cancelled' ||
              at.problem.agent !== requested.recipient)) ||
          session.running === undefined
        ) {
          this.#retries.delete(owner);
          continue;
        }
        if (last.status === 'running') continue;
        const rule = this.run.usageRule(requested.recipient, this.#io.now());
        const connection = this.#connections.get(requested.recipient);
        if (connection === undefined) {
          this.#retries.delete(owner);
          continue;
        }
        if (
          requested.until() > this.#io.now() ||
          !run.running ||
          run.paused ||
          at.paused ||
          session.status !== 'idle' ||
          session.queued.length > 0 ||
          (session.asking?.length ?? 0) > 0 ||
          this.run.holding({ agent: requested.recipient }).length ||
          (rule !== undefined && rule.action !== 'warn' && rule.hold.resetsAt !== null) ||
          (session.mode === null
            ? session.asks !== true
            : this.catalog.neverAsks(connection, session.mode))
        )
          continue;
        this.#retries.delete(owner);
        this.run.decide(owner, requested.item, { choice: 'retry' });
      }
      if (this.#retries.size)
        this.#cancelRetry = this.#io.later(() => {
          this.#cancelRetry = undefined;
          this.#checkRetries();
        }, RETRY_CHECK_MS);
    });
  }

  /**
   * The canvas's nodes, as they change: the sessions follow its agents, how each runs and what each
   * is set to run with, before the run reads the queues, which may send agents messages.
   */
  update(nodes: readonly CanvasNode[]): void {
    this.#connections.clear();
    for (const node of nodes)
      if (node.type === 'agent')
        this.#connections.set(node.id, this.catalog.connectionOf(node.data));
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
    this.cancelResends();
    this.sessions.restoreSubmissions(saved.messages);
    this.run.restore(saved.state);
  }

  /** Forgets the run and every session, as for another canvas. */
  cancelResends(): void {
    this.#retries.clear();
    this.#cancelRetry?.();
    this.#cancelRetry = undefined;
  }

  reset(): void {
    this.cancelResends();
    this.run.reset();
    this.sessions.reset();
  }
}
