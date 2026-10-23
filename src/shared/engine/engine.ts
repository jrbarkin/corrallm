import type { ConnectionId } from '../adapter';
import type { CanvasNode } from '../model/canvas';
import type { TaskMessage, UserMessage } from '../session';
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
  readonly #connections = new Map<string, ConnectionId>();
  readonly #retries = new Map<
    string,
    { recipient: string; item: string; attempt: string; until: number; confirmed: boolean }
  >();
  readonly #manualRetries = new Map<
    string,
    { messages: UserMessage[]; until: number; confirmed: boolean }
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
        retry: (recipient, request) => {
          if (request.cancel) {
            this.#manualRetries.delete(recipient);
            for (const [owner, requested] of this.#retries)
              if (requested.recipient === recipient) this.#retries.delete(owner);
            this.#checkRetries();
          } else if (request.update) {
            const manual = this.#manualRetries.get(recipient);
            if (manual) manual.until = request.until ?? 0;
            for (const requested of this.#retries.values())
              if (requested.recipient === recipient) requested.until = request.until ?? 0;
            this.#checkRetries();
          } else {
            // Only the engine that owns these live submissions may retry them. Repeated
            // decisions and another window's history never authorize another send.
            const submissions = sessions.of(recipient).submissions ?? [];
            const messages = (request.messages ?? []).filter((message) =>
              submissions.some((one) => one.id === message.id && one.status === 'running'),
            );
            if (messages.length)
              this.#manualRetries.set(recipient, {
                messages,
                until: request.until ?? 0,
                confirmed: false,
              });
            this.#retryInterrupted(recipient, request.tasks ?? [], request.until ?? 0);
          }
        },
        ending: (recipient, result, messages, sent) => {
          const manual = this.#manualRetries.get(recipient);
          if (manual?.messages.some((one) => messages.includes(one.id))) {
            if (
              result.status === 'cancelled' &&
              manual.messages.every((one) => messages.includes(one.id))
            )
              manual.confirmed = true;
            else this.#manualRetries.delete(recipient);
          }
          if (!sent) return;
          for (const [owner, requested] of this.#retries) {
            if (requested.recipient !== recipient) continue;
            const last = this.run.snapshot().agents[owner]?.attempts?.[requested.item]?.at(-1);
            if (
              result.status === 'cancelled' &&
              last?.id === requested.attempt &&
              last.status === 'running'
            )
              requested.confirmed = true;
            else this.#retries.delete(owner);
          }
        },
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
      send: (agent, text, done, images, refused, origin, displayText, task) =>
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
          task === undefined ? {} : { task },
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
    this.run.subscribe(() => {
      this.#checkRetries();
    });
    sessions.subscribe(() => {
      this.#checkRetries();
    });
  }

  #retryInterrupted(recipient: string, tasks: readonly TaskMessage[], until: number): void {
    for (const task of tasks) {
      const at = this.run.snapshot().agents[task.agent];
      const attempt = at?.attempts?.[task.item]?.at(-1);
      if (at?.current === task.item && attempt?.id === task.attempt && attempt.status === 'running')
        this.#retries.set(task.agent, {
          recipient,
          item: task.item,
          attempt: task.attempt,
          until,
          confirmed: false,
        });
    }
    this.#checkRetries();
  }

  #checkRetries(): void {
    if (this.#retries.size === 0 && this.#manualRetries.size === 0) {
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
      for (const [recipient, requested] of this.#manualRetries) {
        const session = this.sessions.of(recipient);
        const connection = this.#connections.get(recipient);
        const originals = requested.messages.map((message) =>
          session.submissions?.find((one) => one.id === message.id),
        );
        if (
          connection === undefined ||
          session.running === undefined ||
          originals.some(
            (one) =>
              one === undefined ||
              (one.status !== 'running' && (!requested.confirmed || one.status !== 'cancelled')),
          )
        ) {
          this.#manualRetries.delete(recipient);
          continue;
        }
        if (!requested.confirmed || originals.some((one) => one?.status === 'running')) continue;
        const rule = this.run.usageRule(recipient, this.#io.now());
        if (
          requested.until > this.#io.now() ||
          session.status !== 'idle' ||
          session.queued.length > 0 ||
          (session.asking?.length ?? 0) > 0 ||
          this.run.holding({ agent: recipient }).length > 0 ||
          this.run.sending(recipient) ||
          (rule !== undefined && rule.action !== 'warn' && rule.hold.resetsAt !== null) ||
          (session.mode === null
            ? session.asks !== true
            : this.catalog.neverAsks(connection, session.mode))
        )
          continue;
        // Re-check the holds for each native submission, rather than queuing fresh-user sends
        // that could bypass a pause imposed while the first retry is running.
        const message = requested.messages.shift();
        if (!requested.messages.length) this.#manualRetries.delete(recipient);
        if (message)
          this.sessions.send(
            recipient,
            this.catalog.adapterOf(connection),
            message.text,
            undefined,
            message.images,
            undefined,
            'user',
            undefined,
            { retryOf: message.id },
          );
      }
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
          requested.until > this.#io.now() ||
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
      if (this.#retries.size || this.#manualRetries.size)
        this.#cancelRetry = this.#io.later(() => {
          this.#cancelRetry = undefined;
          this.#checkRetries();
        }, 250);
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
    this.#manualRetries.clear();
    this.#cancelRetry?.();
    this.#cancelRetry = undefined;
  }

  reset(): void {
    this.cancelResends();
    this.run.reset();
    this.sessions.reset();
  }
}
