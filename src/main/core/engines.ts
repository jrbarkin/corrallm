import type { Children } from './children';
import type { ConnectionId } from '../../shared/adapter';
import { canvasIdOf } from '../../shared/canvas';
import type { CanvasId } from '../../shared/canvas';
import type { EngineCatalog } from '../../shared/model/catalog';
import { Engine } from './engine/engine';
import { needs } from '../../shared/model/needs-selectors';
import type { NeedsInput } from '../../shared/model/needs-selectors';
import type { Admission, AdmittedWork, RunMailbox } from './engine/run/runner';
import type { SessionBackend } from './engine/transcript/receive';
import type { CanvasDocument } from '../../shared/model/canvas';
import type { Message, MessageDisplay, PartyId } from '../../shared/model/messages';
import { agentParty } from '../../shared/model/messages';
import type { NeedsItem } from '../../shared/model/needs';
import type { HandoffView } from '../../shared/model/handoff';
import type { RunCheckpoint } from '../../shared/run';
import { MAX_FILE_MATCHES } from '../../shared/session';
import type { SessionEvent, TaskMessage, TurnResult, UserMessage } from '../../shared/session';
import { usedUpUntil } from '../../shared/usage';
import type { ProjectFiles } from '../files';
import type { ProjectFolders } from '../project';
import type { DirectoryResolver } from './workspaces/resolver';
import type { RunJournal } from '../run-journal';
import { installedClis } from '../sessions/installed';
import type { SessionManager } from '../sessions/manager';
import type { UsageReadings } from '../usage';
import type { Documents } from './canvas/documents';
import { recoverDecisions } from './decisions';
import { Delivery, HANDOFF_CARRIED } from './delivery/delivery';
import { HandoffStore } from './delivery/handoffs';
import type { HandoffTable } from './delivery/handoffs';
import { capBody, MessageStore, sentByRun } from './delivery/messages';
import type { MessageTable } from './delivery/messages';
import { WithdrawalNotes } from './delivery/withdrawals';
import { ReadPositions } from './delivery/reads';
import type { Database } from './store/store';

/*
 * The canvases the core runs, each with its engine (src/main/core/engine/engine.ts): the run and the
 * sessions it sends to, the sessions run by the core's own SessionManager, in the same process; and
 * its messages (delivery/messages.ts), which parties send its agents (delivery/delivery.ts). A
 * canvas opens by its id, from what the profile keeps of it: its file and its project folder, which
 * the user picked in the app (canvas memory), its document as the core keeps it (from its rows,
 * else read from its file: core/canvas/documents.ts; a file changed on disk is reviewed, never read
 * over its rows), whose live document it reads from then on, and its run as the journal last kept
 * it, restored paused. Each canvas has one runtime at a time (B11 Design §2), allocated once however
 * often and concurrently asked (`load`, `open`, `initialize`), passive (its document, run and
 * messages loaded, starting no CLI and delivering nothing) until it executes (its delivery started,
 * once, after what was cut off is settled on disk), then closing and closed (`closeCanvas`: its run
 * journaled, its sessions ended); a canvas allocated again while it closes waits for that close. A
 * passive runtime needs no project folder (an agent's session consults the working-directory
 * resolver as it starts); serve's admission (`open`) still needs one, and a file holding the canvas
 * or the core's rows of it, never a draft that holds nothing, nor a canvas whose file holds another.
 * It is open (the journal's `open_canvas`) until it is closed. One opened held stays passive until
 * `deliver()`, so a host that may still refuse to start (`corrallm serve`) sends nothing. A core
 * starting cold initializes every canvas open (`initialize`), once. Whatever its engine does is
 * journaled again: at most one
 * write per COALESCE_MS, and one before every message the run sends, so a sent message's record is
 * always on disk first. Its run and its messages are one record: each write of either holds every
 * change to the other not on disk yet (a run's only if it changed since it last was), so what
 * changes together lands together, or not at all (a kill's hold and its withdrawals, a turn's
 * reply and what its end changed in the run). An oversized or over-complex run keeps its refusal and last
 * good checkpoint instead, never failing messages for a run bound alone; its before-send gate
 * holds run prompts until their checkpoint can be kept. A `wait` moves every read position in one
 * write with them, or none, before it returns. Each message delivering is on disk before it is
 * sent. Whoever watches hears each message added to a canvas's store, closing it included, and each
 * thing newly waiting for an answer on it (`corrallm serve` logs them).
 */

const COALESCE_MS = 250;
const NO_FOLDER =
  'This canvas has no project folder: open it in corrallm and choose its folder there, so its agents can work.';
const NO_FILE = 'This canvas isn’t saved: save it in corrallm first.';
const ANOTHER = 'This canvas’s file holds another canvas now: open it in corrallm to run it.';
const JOURNAL_FAILED = 'Could not journal every canvas’s run as the core closed.';
const NOT_KEPT = 'corrallm keeps no such canvas.';
/** Whom the session manager lists conversations for when a canvas's own runtime asks. */
const RUNTIME_CALLER = 'runtime';

export interface EnginesDeps {
  processes: Pick<Children, 'run'>;
  /** What the engines read of the catalog. */
  engineCatalog: EngineCatalog;
  sessions: SessionManager;
  projects: Pick<ProjectFolders, 'restore'>;
  directories: DirectoryResolver;
  journal: RunJournal;
  /** Each canvas's document, its file checked as it opens. */
  documents: Pick<Documents, 'review' | 'live' | 'loaded' | 'hasRows'>;
  /** Every canvas's messages, in the profile's database. */
  messages: MessageTable;
  /** Every canvas's agents' latest handoffs, in the profile's database (B11a C7). */
  handoffs: HandoffTable;
  /** The profile's database, whose commits hold what changes together. */
  store: Pick<Database, 'write'>;
  usage: Pick<UsageReadings, 'state' | 'subscribe' | 'exhaust' | 'exhausted'>;
  files: ProjectFiles;
  /** The environment agents run in (environment.ts). */
  environment: () => Promise<Readonly<Record<string, string>>>;
  /** The locale the engines tell times of day in (the host's): the runtime's own, when none. */
  locale?: string;
  /** What else waits for you on a canvas, besides its run's holds and its sessions' prompts. */
  needs?: (canvas: CanvasId) => readonly NeedsItem[];
  /** How many prompts of an agent's the core's prompt owner holds (B13 C3), which its counts add. */
  prompted?: (canvas: CanvasId, agent: string) => number;
  /**
   * B11a's fallback service (core/fallback.ts), which each canvas's run and delivery ask before
   * automated work goes (admission), and whose switching the canvas's views say. None: nothing
   * switches, and a fallback rule asks.
   */
  fallback?: {
    admit(canvas: CanvasId, agent: string, work: AdmittedWork): Admission;
    limitNote(canvas: CanvasId, agent: string): string | undefined;
    switching(canvas: CanvasId, agent: string): boolean;
    /** A canvas's agents' availability changed: a switch a held workspace stopped may go. */
    availabilityChanged(canvas: CanvasId): void;
  };
  /**
   * B11a's handoff service (core/handoff.ts): what each canvas's sessions report of their context
   * and how their turns end, its handoff requests through delivery, the run's gate held while one
   * waits, and what the first send after a switch carries. None: no handoff is asked or carried.
   */
  handoff?: {
    attach(canvas: CanvasId, runtime: OpenCanvas): () => void;
    asking(canvas: CanvasId, agent: string): boolean;
    request(canvas: CanvasId, message: Message): 'go' | 'hold' | 'stale';
    replied(canvas: CanvasId, message: Message, reply: string, result: TurnResult): void;
    carry(
      canvas: CanvasId,
      agent: string,
      text: string,
      kind: 'run' | 'party',
      owner?: string,
    ): { text: string; carry: string; undo: () => void } | undefined;
    /** As a canvas's delivery starts: what sends cut off unsent carried waits to be carried again. */
    recover(canvas: CanvasId): void;
    view(canvas: CanvasId, agent: string): HandoffView | null;
  };
}

/**
 * Where a canvas's runtime is (B11 Design §2): passive, loaded but delivering nothing and starting
 * no CLI; or executing, its delivery started. Closing removes it.
 */
export type RuntimeState = 'passive' | 'executing';

/** How initializing a canvas open went, as a core starts cold (`initialize`). */
export type Initialized =
  { canvas: CanvasId; warnings: readonly string[] } | { canvas: CanvasId; error: string };

/** A canvas the core runs: its document, its engine and its messages. */
export interface OpenCanvas {
  /** Its document as the core has it now. */
  readonly document: CanvasDocument;
  /** Whether it executes yet, or is only allocated (passive). */
  readonly state: RuntimeState;
  engine: Engine;
  messages: MessageStore;
  /** Its agents' latest handoffs (B11a C7). */
  handoffs: HandoffStore;
  delivery: Delivery;
  /** Where each party's `wait` has read to in its messages. */
  reads: ReadPositions;
  /**
   * Commits the run as it is now, replacing its coalesced write, with every change to its messages
   * not on disk yet.
   */
  journal(): Promise<void>;
  /**
   * What opening it found to say: its run discarded, its messages unread, the database it is kept
   * in restored.
   */
  warnings: readonly string[];
  /**
   * The generation of an agent's running session (the session manager's), which its prompts'
   * Needs ids carry: none while none runs.
   */
  sessionGeneration?: (agent: string) => number | undefined;
  /**
   * How many prompts of an agent's the core's prompt owner holds (B13 C3), beside those its
   * session shows itself: none where the core composes no owner.
   */
  ownedPrompts?: (agent: string) => number;
  /** Whether corrallm switches an agent's backend now (B11a C4): what its views say. */
  switching?: (agent: string) => boolean;
  /** An agent's handoff as its views show it (B11a C11): none where no service is composed. */
  handoff?: (agent: string) => HandoffView | null;
}

/** How a canvas opens. */
export interface OpenOptions {
  /** Held: nothing is delivered on it until `deliver()`, though messages may be sent meanwhile. */
  held?: boolean;
}

/** What hears the canvases the core runs. */
export interface Watcher {
  /** A message added to a canvas's store. */
  message?(message: Message): void;
  /** Something newly waiting for an answer on a canvas: a hold of the run, a session's prompt. */
  need?(canvas: CanvasId, item: NeedsItem): void;
  /** What waits for an answer on a canvas may have changed (the `needs` op says what it is now). */
  needs?(canvas: CanvasId): void;
  /** A canvas opened. */
  opened?(canvas: CanvasId): void;
  /** A canvas it ran closed (canvas.close, or the core closing): it runs no more here. */
  closed?(canvas: CanvasId): void;
}

/** A run's attempt an Interrupt and resend reserved: its task link, and the id its turn names. */
interface ReservedAttempt {
  task: TaskMessage;
  as: string;
}

/** A canvas the core runs, with its sessions' listeners and its journal. */
interface Running extends OpenCanvas {
  state: RuntimeState;
  /** Its delivery starting (once: `#execute`), once it executes. */
  executing: Promise<void> | undefined;
  /** Whether the profile keeps it as serve admits it: in a file that holds it, or in rows. */
  kept: boolean;
  /** Its generation's token in the journal, which its writes carry. */
  token: string;
  listeners: Set<(agentId: string, connection: ConnectionId, event: SessionEvent) => void>;
  /** The coalesced write waiting, if any. */
  timer: ReturnType<typeof setTimeout> | undefined;
  /** How many times its run has changed, and how many of those the journal has on disk. */
  changes: number;
  saved: number;
  /** What stops it hearing its engine change, and usage readings. */
  stop: () => void;
  /** What stops watchers hearing its messages: once what closing it said is said too. */
  unwatch: () => void;
  /** The ids of what waited for an answer on it when watchers last looked. */
  needs: Set<string>;
  /** Whether watchers look at what waits on it again soon. */
  looking: boolean;
}

export class Engines {
  readonly #deps: EnginesDeps;
  /** Each canvas's runtime, allocated once (its one initialization). */
  readonly #running = new Map<CanvasId, Promise<Running>>();
  /** Each canvas closing: allocated again only once its close has finished. */
  readonly #closing = new Map<CanvasId, Promise<void>>();
  /** Every canvas open as the core started, initialized once (`initialize`). */
  #initialized: Promise<readonly Initialized[]> | undefined;
  /** The canvases open now, once opened. */
  readonly #canvases = new Map<CanvasId, Running>();
  readonly #mail = new Map<
    CanvasId,
    Promise<{ messages: MessageStore; notes: WithdrawalNotes; handoffs: HandoffStore }>
  >();
  readonly #watchers = new Set<Watcher>();
  readonly #events = new Map<string, Promise<void>>();
  #closed = false;
  /** Whether the core's shutdown barrier holds every canvas it runs (`freeze`). */
  #frozen = false;
  readonly #reports = new Map<string, Map<string, SessionEvent>>();
  readonly #inputs = new Map<string, Map<string, UserMessage>>();
  /**
   * Each Interrupt and resend reserved before its interrupt (by canvas and agent), on a canvas the
   * core runs: the native turn's ids, what was sent in it, and the run's attempts it carried (from
   * their durable messages), each retried on that turn's cancelled end (retryAttempt).
   */
  readonly #resends = new Map<
    string,
    { ids: readonly string[]; inputs: UserMessage[]; attempts: readonly ReservedAttempt[] }
  >();

  constructor(deps: EnginesDeps) {
    this.#deps = deps;
  }

  /** A canvas the core has open, if it has. */
  canvas(canvas: CanvasId): OpenCanvas | undefined {
    return this.#canvases.get(canvas);
  }

  /**
   * The canvas's document changed (an op committed to it): its engine follows it, its sessions and
   * its run, and what waits on it to be delivered is looked at again.
   */
  changed(canvas: CanvasId): void {
    const running = this.#canvases.get(canvas);
    if (!running) return;
    running.engine.update(running.document.nodes);
    running.delivery.schedule();
    // What waits there is worded from the document too.
    this.#look(running);
  }

  /**
   * What waits for an answer on the canvas may have changed beside its engine (a proposal raised
   * or settled): watchers look again.
   */
  needsChanged(canvas: CanvasId): void {
    const running = this.#canvases.get(canvas);
    if (running) this.#look(running);
  }

  /**
   * The canvas's messages, read once, whether or not it is open here: where corrallm's records to
   * its parties go (a proposal's settlement).
   */
  async messagesOf(canvas: CanvasId): Promise<MessageStore> {
    return (await this.#mailOf(canvas)).messages;
  }

  /** A silent turn tells each sender once. The record wakes wait and keeps its dedupe key. */
  async stalled(
    canvas: CanvasId,
    agent: string,
    ids: readonly string[],
    text: string,
  ): Promise<void> {
    const store = await this.messagesOf(canvas);
    const parties = new Set<PartyId>();
    const messages = store.active().filter(
      (message) =>
        message.kind === 'text' &&
        // The run's own sends tell no sender: the run holds their tasks.
        !sentByRun(message) &&
        message.to === agentParty(agent) &&
        message.delivery !== undefined &&
        ids.includes(message.delivery.as) &&
        (message.state === 'delivering' || message.state === 'delivered'),
    );
    for (const message of messages) {
      if (parties.has(message.from) || message.from === 'corrallm') continue;
      parties.add(message.from);
      // Use the delivered message, not a process-local turn id: native history cannot retell it
      // after a restart. Coalesced messages from one party still get just one notice.
      if (messages.some((one) => one.from === message.from && store.hasTold(`stalled:${one.id}`)))
        continue;
      store.add(
        {
          from: 'corrallm',
          to: message.from,
          kind: 'notice',
          origin: 'party',
          body: text,
          replyTo: message.id,
          state: 'delivered',
        },
        `stalled:${message.id}`,
      );
    }
    await store.durable();
  }

  ended(canvas: CanvasId, agent: string): void {
    const key = `${canvas}\u0000${agent}`;
    this.#inputs.delete(key);
    this.#resends.delete(key);
    this.#reports.delete(key);
  }

  /**
   * Reserves one explicit Interrupt and resend of an agent's native turn (its ids), before its
   * interrupt, never acting before its cancelled end arrives. On a canvas the core runs: the run's
   * attempts in that turn (read from their durable messages) are retried on that end
   * (retryAttempt), and the parties' and your messages in it sent again (#resend).
   */
  resendAfter(canvas: CanvasId, agent: string, ids: readonly string[]): Promise<void> {
    const key = `${canvas}\u0000${agent}`;
    const inputs = [...(this.#inputs.get(key)?.values() ?? [])].filter((one) =>
      ids.includes(one.id),
    );
    if (this.#running.has(canvas)) {
      const open = this.#canvases.get(canvas);
      const attempts = (open?.messages.active() ?? []).flatMap((message) =>
        sentByRun(message) &&
        message.task !== undefined &&
        message.to === agentParty(agent) &&
        message.delivery !== undefined &&
        ids.includes(message.delivery.as)
          ? [{ task: message.task, as: message.delivery.as }]
          : [],
      );
      this.#resends.set(key, { ids, inputs, attempts });
    }
    return Promise.resolve();
  }

  /** The interrupt a reservation was made for was refused: nothing is retried or sent again. */
  cancelResend(canvas: CanvasId, agent: string): Promise<void> {
    const key = `${canvas}\u0000${agent}`;
    this.#resends.delete(key);
    return Promise.resolve();
  }

  /**
   * Retries a run's attempt that its turn's cancelled end interrupted, as an Interrupt and resend
   * reserved (B11 Design §16.7): the core's alone (no event, window or token reaches it), on a
   * canvas it runs, through the attempt's held problem's Retry once nothing holds its recipient,
   * its backend's exhaustion included, as a new attempt with retryOf. Whether the attempt was
   * taken: not one that isn't its owner's cancelled hold (any more), nor on a canvas the core
   * doesn't run.
   */
  retryAttempt(canvas: CanvasId, attempt: TaskMessage): boolean {
    const open = this.#canvases.get(canvas);
    if (!open) return false;
    const { engine, document } = open;
    return engine.retryAttempt(attempt, () => {
      const recipient =
        engine.run.snapshot().agents[attempt.agent]?.problem?.agent ?? attempt.agent;
      const node = document.nodes.find((one) => one.id === recipient);
      const backend = node?.type === 'agent' ? engine.catalog.usageBackendOf(node.data) : undefined;
      return backend === undefined ? 0 : (this.#deps.usage.exhausted(backend, Date.now()) ?? 0);
    });
  }

  /** The canvases the core has open, in the order they opened. */
  opened(): CanvasId[] {
    return [...this.#canvases.keys()];
  }

  /**
   * The canvas's engine, opening it if it isn't yet, as serve admits a canvas: its document as the
   * core keeps it, and its run as the journal last kept it, restored paused, delivering at once
   * unless `held`. Rejects, saying why, for a canvas the profile keeps no project folder or file
   * for, or whose file holds another canvas now (one allocated passively stays so).
   */
  async open(canvas: CanvasId, { held = false }: OpenOptions = {}): Promise<Engine> {
    const running = await this.#allocate(canvas, true);
    // One allocated passively before meets serve's admission now.
    if (this.#deps.directories.projectRoot(canvas) === undefined) throw new Error(NO_FOLDER);
    if (!running.kept && !this.#deps.documents.hasRows(canvas)) throw new Error(NO_FILE);
    if (!held) await this.#execute(running);
    return running.engine;
  }

  /**
   * The canvas's engine, allocated passively if it isn't yet (B11 Design §2): its document, its run
   * restored paused and its messages, open until it is closed, with no project folder needed,
   * starting no CLI and delivering nothing until it executes. Rejects, saying why, for a canvas
   * corrallm keeps nothing of, or whose file holds another canvas now.
   */
  async load(canvas: CanvasId): Promise<Engine> {
    return (await this.#allocate(canvas, false)).engine;
  }

  /**
   * Runs the canvas a window is to show (B11 Design §8): allocated passively if it isn't yet, as
   * `load` does, then executing, its delivery started once what was cut off is settled on disk. A
   * window only views it: none going (closed, reloaded, crashed, or showing another canvas) stops
   * it. Rejects, saying why, as `load` does.
   */
  async view(canvas: CanvasId): Promise<void> {
    await this.#execute(await this.#allocate(canvas, false));
  }

  /**
   * Initializes every canvas open (`open_canvas`) as a core starts cold, once, however often asked:
   * each allocated (restored paused) and executing, its delivery started only once what was cut
   * off as the core stopped is settled on disk. How each went; one that can't is said, never
   * stopping the others.
   */
  initialize(): Promise<readonly Initialized[]> {
    if (this.#closed) return Promise.reject(new Error('The core’s canvases have closed.'));
    if (this.#initialized === undefined) {
      const initializing = this.#initialize();
      initializing.catch(() => {
        if (this.#initialized === initializing) this.#initialized = undefined;
      });
      this.#initialized = initializing;
    }
    return this.#initialized;
  }

  async #initialize(): Promise<readonly Initialized[]> {
    const canvases = await this.#deps.journal.openCanvases();
    return Promise.all(
      canvases.map(async (canvas): Promise<Initialized> => {
        try {
          const running = await this.#allocate(canvas, false);
          await this.#execute(running);
          return { canvas, warnings: running.warnings };
        } catch (error) {
          return { canvas, error: error instanceof Error ? error.message : String(error) };
        }
      }),
    );
  }

  /** Starts delivering on every canvas allocated passively (opened held): what waits goes once it can. */
  async deliver(): Promise<void> {
    await Promise.all([...this.#canvases.values()].map((running) => this.#execute(running)));
  }

  /**
   * The canvas's runtime, allocated once: one already allocated (or allocating), or a new one once
   * a close of its last has finished. `strict`: as serve admits it (#load).
   */
  #allocate(canvas: CanvasId, strict: boolean): Promise<Running> {
    if (this.#closed) return Promise.reject(new Error('The core’s canvases have closed.'));
    let running = this.#running.get(canvas);
    if (!running) {
      const closing = this.#closing.get(canvas);
      const allocating = (async () => {
        await closing?.catch(() => undefined);
        return this.#load(canvas, strict);
      })();
      allocating.catch(() => {
        if (this.#running.get(canvas) === allocating) this.#running.delete(canvas);
      });
      this.#running.set(canvas, allocating);
      running = allocating;
    }
    return running;
  }

  /**
   * The runtime executes: its delivery starts, once (what was being delivered as the core last
   * stopped settled unresolved, on disk, before anything goes).
   */
  #execute(running: Running): Promise<void> {
    running.executing ??= (async () => {
      if (this.#canvases.get(running.document.id) !== running) return;
      running.state = 'executing';
      await running.delivery.start();
    })();
    return running.executing;
  }

  /**
   * Moves `party`'s read position forward to its place in each canvas `places` names (never back):
   * all in one write, with what each canvas has to journal, or none. Resolves once it is on disk;
   * rejects, moving none, if it couldn't be.
   */
  async advance(party: PartyId, places: Readonly<Record<string, number>>): Promise<void> {
    const moving = Object.entries(places).flatMap(([canvas, seq]) => {
      const running = this.#canvases.get(canvas as CanvasId);
      return running && seq > running.reads.of(party) ? [{ running, seq }] : [];
    });
    if (moving.length === 0) return;
    const done: (() => void)[] = [];
    await this.#deps.store.write(() => {
      for (const { running, seq } of moving) {
        done.push(this.#journalWithin(running, false));
        this.#deps.journal.moveRead(running.document.id, party, seq);
      }
    });
    for (const one of done) one();
    for (const { running, seq } of moving) running.reads.moved(party, seq);
  }

  /**
   * Hears every canvas the core runs, from now on: each message added, and what newly waits for an
   * answer (the first watcher of needs hears at once what waits already).
   */
  watch(watcher: Watcher): () => void {
    this.#watchers.add(watcher);
    for (const running of this.#canvases.values()) this.#look(running);
    return () => {
      this.#watchers.delete(watcher);
    };
  }

  /**
   * What a session of one of the canvas's agents did (SessionManager's `emit`): resolves once
   * the core has reduced it and taken its durable effects. Runtime topics publish the view.
   */
  emit(
    canvas: CanvasId,
    agentId: string,
    connection: ConnectionId,
    event: SessionEvent,
  ): Promise<void> {
    const key = `${canvas}\u0000${agentId}`;
    const previous = this.#events.get(key) ?? Promise.resolve();
    const emitted = previous.then(() => this.#emit(canvas, agentId, connection, event));
    this.#events.set(key, emitted);
    const forget = () => {
      if (this.#events.get(key) === emitted) this.#events.delete(key);
    };
    void emitted.then(forget, forget);
    return emitted;
  }

  async #emit(
    canvas: CanvasId,
    agentId: string,
    connection: ConnectionId,
    given: SessionEvent,
  ): Promise<void> {
    const key = `${canvas}\u0000${agentId}`;
    if (given.type === 'started' || given.type === 'mode' || given.type === 'asking') {
      const reports = this.#reports.get(key) ?? new Map<string, SessionEvent>();
      if (given.type === 'started') reports.clear();
      reports.delete(given.type);
      reports.set(given.type, given);
      this.#reports.set(key, reports);
    }
    if (given.type === 'user') {
      const inputs = this.#inputs.get(key) ?? new Map<string, UserMessage>();
      if (!inputs.has(given.id)) inputs.set(given.id, { id: given.id, text: given.text });
      this.#inputs.set(key, inputs);
    }
    const event = given.type === 'end' ? await this.#ended(connection, given) : given;
    const mail = await this.#mail.get(canvas);
    mail?.notes.receive(agentId, event);
    const running = await this.#running.get(canvas);
    const request = event.type === 'end' ? this.#resends.get(key) : undefined;
    // The reserved attempts this cancelled end is what cancels: each still running as it arrives
    // (one a Kill or a Stop took back since is not), its message among the turn's.
    const retrying =
      event.type === 'end' && event.result.status === 'cancelled' && running !== undefined
        ? (request?.attempts ?? []).filter(({ task, as }) => {
            const last = running.engine.run.snapshot().agents[task.agent]?.attempts?.[task.item];
            const attempt = last?.at(-1);
            return (
              event.messages.includes(as) &&
              attempt?.id === task.attempt &&
              attempt.status === 'running'
            );
          })
        : [];
    for (const listener of running?.listeners ?? []) listener(agentId, connection, event);
    if (event.type === 'end') {
      this.#resends.delete(key);
      for (const id of event.messages) this.#inputs.get(key)?.delete(id);
      // Its run holds each cancelled now: retried once nothing holds its agent.
      for (const { task } of retrying) this.retryAttempt(canvas, task);
      if (request && event.result.status === 'cancelled') {
        // Do not hold this agent's event lane while committing its new rows.
        setImmediate(() => {
          void this.#resend(canvas, agentId, request, event.messages).catch((error: unknown) => {
            console.error('Could not resend the interrupted turn:', error);
          });
        });
      }
    } else if (event.type === 'closed' || event.type === 'cleared') {
      this.#resends.delete(key);
      this.#inputs.delete(key);
      this.#reports.delete(key);
    }
  }

  async #resend(
    canvas: CanvasId,
    agent: string,
    request: { ids: readonly string[]; inputs: UserMessage[] },
    ended: readonly string[],
  ): Promise<void> {
    const stopped = () => this.#closed;
    if (stopped()) return;
    const open = await this.#running.get(canvas);
    if (!open || stopped()) return;
    const store = open.messages;
    const originals = store.all().filter(
      (m) =>
        m.kind === 'text' &&
        // The run retries its own attempts (retryAttempt): never copied as a party's.
        !sentByRun(m) &&
        m.to === agentParty(agent) &&
        m.delivery &&
        request.ids.includes(m.delivery.as) &&
        ended.includes(m.delivery.as),
    );
    const partyIds = new Set(
      originals.flatMap((m) => (m.delivery === undefined ? [] : [m.delivery.as])),
    );
    // A manual submission's own message (the journal keeps each as yours: run-journal.ts), kept
    // unresolved while its turn went on, ended with that turn: cancelled, as Delivery's are.
    for (const m of originals) {
      if (store.originOf(m.id) === 'manual' && m.state === 'unresolved') {
        store.update(m.id, {
          state: 'replied',
          turn: { status: 'cancelled', reason: 'interrupted' },
        });
      }
    }
    const copies = originals
      .filter((m) => store.get(m.id)?.state === 'replied')
      .map((m) => ({
        id: m.id,
        from: m.from,
        // A submission's message may hold its text cut: its display holds the whole.
        body: store.displayOf(m.id)?.text ?? m.body,
        images: request.inputs.find((input) => input.id === m.delivery?.as)?.images,
      }));
    const runIds = new Set(
      store
        .all()
        .filter(sentByRun)
        .flatMap((m) => (m.delivery === undefined ? [] : [m.delivery.as])),
    );
    for (const input of request.inputs) {
      if (
        partyIds.has(input.id) ||
        runIds.has(input.id) ||
        input.from !== undefined ||
        !ended.includes(input.id)
      )
        continue;
      // Native user ids need not be UUIDs. Keep an original message record of our own,
      // linked to its native submission by delivery.as, before making a new UUID-to-UUID link.
      const recorded = store.add({
        from: 'you',
        to: agentParty(agent),
        kind: 'text',
        origin: 'manual',
        body: input.text,
        state: 'replied',
        turn: { status: 'cancelled', reason: 'interrupted' },
        delivery: { at: Date.now(), as: input.id, attempt: 1 },
      });
      copies.push({ id: recorded.id, from: 'you', body: input.text, images: input.images });
    }
    for (const original of copies) {
      // Once: its resend is kept as one (resend_of), never a reply to it (reply_to).
      if (store.resent(original.id)) continue;
      const images = original.images?.length ?? 0;
      const next = store.add({
        from: original.from,
        to: agentParty(agent),
        kind: 'text',
        origin: 'resend',
        // Its images are live-only: once a restart lost them, it is never sent without them.
        ...(images > 0 ? { display: { images, requiresImages: true } } : {}),
        body: original.body,
        state: 'pending',
        resendOf: original.id,
      });
      open.delivery.images(next.id, original.images);
      store.add(
        {
          from: 'corrallm',
          to: original.from,
          kind: 'notice',
          origin: 'party',
          state: 'delivered',
          replyTo: original.id,
          body: `At the user's request, message ${original.id} was resent as ${next.id}. Its reply will be addressed to that new message.`,
        },
        `resent:${original.id}`,
      );
    }
    await store.durable();
    open.delivery.schedule();
  }

  /**
   * A turn's end. One that failed on its usage backend's limit holds the backend until the limit
   * lifts, for every agent that spends it (UsageReadings.exhaust, on disk first). Its connection
   * says when, where its CLI did; otherwise the backend's latest reading does, where it shows the
   * backend used up (usedUpUntil), and the end goes on saying so. Where nothing says when, nothing
   * holds (a hold ends at a reset corrallm knows): a turn sent meanwhile fails at once, spending
   * nothing.
   */
  async #ended(
    connection: ConnectionId,
    event: Extract<SessionEvent, { type: 'end' }>,
  ): Promise<SessionEvent> {
    const { result } = event;
    const catalog = this.#deps.engineCatalog;
    const backend = catalog.usageBackendOf({ adapter: catalog.adapterOf(connection), connection });
    if (backend === undefined || result.status !== 'failed' || result.reason !== 'usage-limit') {
      return event;
    }
    const reading = this.#deps.usage.state().readings.find((one) => one.backend === backend);
    const resetsAt = result.resetsAt ?? (reading && usedUpUntil(reading.windows, Date.now()));
    if (resetsAt === undefined) return event;
    // A hold it can't keep holds all the same, until the core stops: the turn's end goes on.
    await this.#deps.usage.exhaust(backend, resetsAt).catch((error: unknown) => {
      console.error(
        `Could not keep ${catalog.backendName(backend)}’s usage limit: it holds only until corrallm stops.`,
        error,
      );
    });
    return result.resetsAt === undefined ? { ...event, result: { ...result, resetsAt } } : event;
  }

  /**
   * Every session send carries untold withdrawals from its message store. The app's run stays
   * in the renderer until B11: reading its notes or resending its manual submissions never
   * composes or journals another run. Its retry decision goes back to the owning engine. False if
   * it never went: a command its withdrawal note's turn went before, stopped first (`stopped`).
   */
  async sending(
    canvas: CanvasId,
    agentId: string,
    message: UserMessage,
    send: (message: UserMessage) => Promise<void>,
    stopped?: () => boolean,
  ): Promise<boolean> {
    if (this.#closed) throw new Error('The canvas closed before its message could be sent.');
    const key = `${canvas}\u0000${agentId}`;
    const inputs = this.#inputs.get(key) ?? new Map<string, UserMessage>();
    inputs.set(message.id, message);
    this.#inputs.set(key, inputs);
    const { notes } = await this.#mailOf(canvas);
    return notes.send(agentId, message, send, stopped);
  }

  /**
   * Closes a canvas it runs (canvas.close): what its messages were doing cut off, its run held
   * where it is and journaled, then its sessions closed. Nothing if it doesn't run it; rejects,
   * once its sessions are closed, if its run couldn't be journaled.
   */
  async closeCanvas(canvas: CanvasId): Promise<void> {
    const opening = this.#running.get(canvas);
    if (opening === undefined) {
      // One closing already: done once it is.
      await this.#closing.get(canvas);
      return;
    }
    this.#running.delete(canvas);
    const closing = this.#close(canvas, opening);
    this.#closing.set(canvas, closing);
    try {
      await closing;
    } finally {
      if (this.#closing.get(canvas) === closing) this.#closing.delete(canvas);
    }
  }

  async #close(canvas: CanvasId, opening: Promise<Running>): Promise<void> {
    let running: Running;
    try {
      running = await opening;
    } catch {
      // It never opened: nothing of it runs.
      return;
    }
    this.#canvases.delete(canvas);
    try {
      await this.#stop(running);
    } finally {
      try {
        await this.#deps.sessions.closeCanvas(canvas);
      } finally {
        for (const watcher of this.#watchers) watcher.closed?.(canvas);
      }
    }
  }

  /**
   * The core's shutdown barrier (B11 Design §16.5), prepared: on every canvas it runs, and every
   * one it opens meanwhile, no run task and no delivery starts until `thaw`; turns going on go on,
   * their ends kept, and their sessions stay usable. A message a session already queued behind its
   * turn was handed to it before, and is its own.
   */
  freeze(): void {
    this.#frozen = true;
    for (const running of this.#canvases.values()) {
      running.engine.run.freeze();
      running.delivery.freeze();
    }
  }

  /** The barrier lifted (a quit cancelled): every canvas goes on from where it is. */
  thaw(): void {
    if (!this.#frozen) return;
    this.#frozen = false;
    for (const running of this.#canvases.values()) {
      running.engine.run.thaw();
      running.delivery.thaw();
    }
  }

  /** Fallible saving before the app commits to closing: sessions and topics remain usable. */
  async flush(): Promise<void> {
    await Promise.all(this.#events.values());
    const running = await Promise.all(this.#running.values());
    await Promise.all(running.map((one) => this.#write(one)));
    const mail = await Promise.all(this.#mail.values());
    await Promise.all(mail.map(({ messages }) => messages.durable()));
    await this.#deps.journal.flush();
  }

  /**
   * Stops every canvas, as the core closes: its run held where it is (what was going on is
   * uncertain until inspected), journaled, then its sessions closed. Every session closes even if a
   * run can't be journaled; then it rejects, with why each couldn't.
   */
  async close(): Promise<void> {
    await Promise.all(this.#events.values());
    this.#closed = true;
    const mail = await Promise.all(this.#mail.values());
    for (const { notes } of mail) notes.close();
    await Promise.allSettled(this.#closing.values());
    const running = await Promise.allSettled(this.#running.values());
    this.#running.clear();
    const closing = [...this.#canvases.keys()];
    this.#canvases.clear();
    const stopped = await Promise.allSettled(
      running.flatMap((opened) =>
        opened.status === 'fulfilled' ? [this.#stop(opened.value)] : [],
      ),
    );
    await this.#deps.journal.flush();
    await this.#deps.sessions.closeEverything();
    await Promise.all(this.#events.values());
    // A message not on disk yet is written with its run: it fails as the run's journal did.
    const messages = await Promise.allSettled(mail.map(({ messages }) => messages.durable()));
    for (const canvas of closing) for (const watcher of this.#watchers) watcher.closed?.(canvas);
    const failed = [...stopped, ...messages].flatMap((result): unknown[] =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (failed.length > 0) throw new AggregateError(failed, JOURNAL_FAILED);
  }

  /**
   * Loads a canvas's runtime, passive. `strict`, as serve admits a canvas, before anything is
   * changed: only with a picked project root (not any one agent's eventual workspace), and a file
   * that holds it or the core's rows of it (one a token made, never saved: B9 Design §8), never a
   * draft that holds nothing, though the journal keeps one's run. Either way never one whose file
   * holds another canvas now, nor one corrallm keeps nothing of.
   */
  async #load(canvas: CanvasId, strict: boolean): Promise<Running> {
    const { projects, journal, documents } = this.#deps;
    await projects.restore(canvas);
    if (strict && this.#deps.directories.projectRoot(canvas) === undefined) {
      throw new Error(NO_FOLDER);
    }
    const context = await journal.get(canvas);
    const rows = documents.hasRows(canvas);
    let kept = rows;
    if (context.savedText !== undefined) {
      let holds: CanvasId | undefined;
      try {
        holds = canvasIdOf(context.savedText);
      } catch (error) {
        // One whose document the core keeps opens from it, its file reviewed (B9 Design §5).
        if (!rows) throw error;
      }
      // A file opened as a copy still contains the original's id until its first save. Its
      // adopted rows are authoritative for the window; serve retains its stricter admission.
      if (holds !== undefined && holds !== canvas && (strict || !rows)) throw new Error(ANOTHER);
      kept = true;
    }
    if (strict && !kept) throw new Error(NO_FILE);
    // A draft that holds nothing is loaded only while it is live here, or open (a window shows it).
    if (
      !kept &&
      documents.loaded(canvas) === undefined &&
      !(await journal.openCanvases()).includes(canvas)
    ) {
      throw new Error(NOT_KEPT);
    }
    // With its edits since, as the core keeps them: a file changed on disk meanwhile is never read
    // over them, but reviewed (B9 Design §5).
    const { document } = await documents.review(canvas);
    if (context.checkpoint) Engine.check(context.checkpoint);
    const listeners: Running['listeners'] = new Set();
    const { messages, handoffs } = await this.#mailOf(canvas);
    const warnings: readonly string[] = [
      context.warning,
      messages.warning,
      handoffs.warning,
    ].filter((one) => one !== undefined);
    // B11a C7: the handoffs of agents no longer on the canvas go as it opens.
    handoffs.prune(
      new Set(document.nodes.flatMap(({ id, type }) => (type === 'agent' ? [id] : []))),
    );
    await handoffs.durable().catch((error: unknown) => {
      console.error('Could not forget the handoffs of agents no longer on the canvas:', error);
    });
    // The engine and what journals it need each other.
    const running = {
      get document() {
        return documents.live(canvas).document;
      },
      messages,
      handoffs,
      warnings,
      unwatch: messages.subscribe((message) => {
        for (const watcher of this.#watchers) watcher.message?.(message);
      }),
      state: 'passive',
      executing: undefined,
      kept,
      token: context.token,
      listeners,
      timer: undefined,
      changes: 0,
      saved: 0,
      needs: new Set(),
      looking: false,
    } as Running;
    running.reads = new ReadPositions(await journal.reads(canvas));
    running.sessionGeneration = (agent) => this.#deps.sessions.generationOf(canvas, agent);
    running.ownedPrompts = (agent) => this.#deps.prompted?.(canvas, agent) ?? 0;
    const { fallback, handoff } = this.#deps;
    if (fallback !== undefined) running.switching = (agent) => fallback.switching(canvas, agent);
    if (handoff !== undefined) running.handoff = (agent) => handoff.view(canvas, agent);
    running.journal = () => this.#write(running);
    // What its messages write, they write with its run, if that changed since it was last on disk,
    // and its handoffs (a reply's accepted handoff, a send's carry cleared: B11a C7).
    messages.writeWith(() => {
      const done = [this.#runWithin(running, false), handoffs.changes()];
      return () => {
        for (const one of done) one();
      };
    });
    const engine: Engine = new Engine({
      catalog: this.#deps.engineCatalog,
      backend: this.#backend(canvas, listeners),
      later: (run, ms) => {
        const timer = setTimeout(run, ms);
        return () => {
          clearTimeout(timer);
        };
      },
      now: () => Date.now(),
      usage: () => this.#deps.usage.state(),
      beforeSend: async () => {
        await this.#write(running);
        // A committed refusal marker keeps parties' messages durable, but cannot authorize a
        // run prompt whose in-flight state was not kept. RunStore holds that attempt in Needs.
        const problem = journal.problem(canvas);
        if (problem !== undefined) throw new Error(problem);
      },
      // Each attempt the run sends is a message first, written with the run (B11 Design §3); the
      // first to an agent since a switch carries its handoff (B11a C7).
      mailbox: runMailbox(
        messages,
        handoff === undefined
          ? undefined
          : (agent, text, owner) => handoff.carry(canvas, agent, text, 'run', owner),
      ),
      ...(this.#deps.locale === undefined ? {} : { locale: this.#deps.locale }),
      // B11a C3: admission before each task's attempt goes.
      ...(fallback === undefined
        ? {}
        : {
            admit: (agent, work) => fallback.admit(canvas, agent, work),
            limitNote: (agent) => fallback.limitNote(canvas, agent),
          }),
      // B11a C7: an agent's next task waits while corrallm's handoff request to it waits or runs.
      ...(handoff === undefined ? {} : { handoff: (agent) => handoff.asking(canvas, agent) }),
    });
    running.engine = engine;
    engine.update(document.nodes);
    if (context.checkpoint) engine.restore(context.checkpoint);
    const delivery = new Delivery({
      availability: (agent) => this.#deps.sessions.availability(canvas, agent),
      canvas,
      engine,
      store: messages,
      nodes: () => running.document.nodes,
      usage: this.#deps.usage,
      now: () => Date.now(),
      later: (run, ms) => {
        const timer = setTimeout(run, ms);
        return () => {
          clearTimeout(timer);
        };
      },
      changed: () => {
        this.#look(running);
      },
      defaultAsks: (adapter, agent) =>
        this.#deps.processes
          .run(() => this.#deps.sessions.settingsOptions(canvas, adapter, agent))
          .then(({ defaults }) => defaults.asks),
      ...(this.#deps.locale === undefined ? {} : { locale: this.#deps.locale }),
      ...(fallback === undefined
        ? {}
        : { admit: (agent, work) => fallback.admit(canvas, agent, work) }),
      // B11a C7: corrallm's handoff requests, and what the first send after a switch carries.
      ...(handoff === undefined
        ? {}
        : {
            handoff: {
              request: (message) => handoff.request(canvas, message),
              replied: (message, reply, result) => {
                handoff.replied(canvas, message, reply, result);
              },
              carry: (agent, framed) => handoff.carry(canvas, agent, framed, 'party'),
              recover: () => {
                handoff.recover(canvas);
              },
            },
          }),
    });
    running.delivery = delivery;
    // One opened while the shutdown barrier holds is held by it too.
    if (this.#frozen) {
      engine.run.freeze();
      delivery.freeze();
    }
    const changed = () => {
      running.changes += 1;
      running.timer ??= setTimeout(() => {
        running.timer = undefined;
        // Written with its messages meanwhile, it has nothing more to journal.
        if (running.changes <= running.saved) return;
        void this.#write(running).catch((error: unknown) => {
          console.error('Could not journal the run:', error);
        });
      }, COALESCE_MS);
    };
    const look = () => {
      this.#look(running);
    };
    const unsubscribe = [
      engine.run.subscribe(changed),
      engine.sessions.subscribe(changed),
      engine.run.subscribe(look),
      engine.sessions.subscribe(look),
      // A message to an agent that can't start, or runs in a mode that never asks, waits for you.
      messages.subscribe(look),
      this.#deps.sessions.onAvailability(canvas, () => {
        fallback?.availabilityChanged(canvas);
        delivery.availabilityChanged();
        look();
      }),
      // Usage rules are checked again with each reading.
      this.#deps.usage.subscribe(() => {
        engine.run.usageChanged();
        delivery.schedule();
        look();
      }),
      // B11a C7: what its sessions report of their context, and how their turns end.
      ...(handoff === undefined ? [] : [handoff.attach(canvas, running)]),
    ];
    running.stop = () => {
      for (const stop of unsubscribe) stop();
      clearTimeout(running.timer);
      running.timer = undefined;
    };
    this.#canvases.set(canvas, running);
    // Open until it is closed (B9 Design §2).
    await journal.open(canvas, false);
    this.#look(running);
    for (const watcher of this.#watchers) watcher.opened?.(canvas);
    return running;
  }

  #mailOf(
    canvas: CanvasId,
  ): Promise<{ messages: MessageStore; notes: WithdrawalNotes; handoffs: HandoffStore }> {
    let mail = this.#mail.get(canvas);
    if (!mail) {
      mail = (async () => {
        const messages = new MessageStore(canvas, this.#deps.messages, () => Date.now());
        await messages.load();
        const handoffs = new HandoffStore(canvas, this.#deps.handoffs);
        handoffs.load();
        // A decision a crash cut off as it was being made is unresolved, never made again.
        if (recoverDecisions(messages)) {
          await messages.durable().catch((error: unknown) => {
            console.error('Could not settle the answers corrallm stopped making:', error);
          });
        }
        return {
          messages,
          notes: new WithdrawalNotes(messages, this.#deps.engineCatalog.shellPrefixes),
          handoffs,
        };
      })();
      this.#mail.set(canvas, mail);
    }
    return mail;
  }

  /**
   * Soon tells the watchers that hear needs what newly waits for an answer on a canvas: once,
   * however often asked before then.
   */
  #look(running: Running): void {
    const watchers = [...this.#watchers];
    if (
      running.looking ||
      !watchers.some((watcher) => watcher.need !== undefined || watcher.needs !== undefined)
    ) {
      return;
    }
    running.looking = true;
    queueMicrotask(() => {
      running.looking = false;
      if (this.#canvases.get(running.document.id) !== running) return;
      for (const watcher of this.#watchers) watcher.needs?.(running.document.id);
      if (![...this.#watchers].some((watcher) => watcher.need !== undefined)) return;
      const items = [
        ...needs(needsInput(running, this.#deps.locale)),
        ...(this.#deps.needs?.(running.document.id) ?? []),
      ];
      for (const item of items) {
        if (running.needs.has(item.id)) continue;
        for (const watcher of this.#watchers) watcher.need?.(running.document.id, item);
      }
      running.needs = new Set(items.map(({ id }) => id));
    });
  }

  /**
   * Stops a canvas as the core closes: what its messages were doing cut off (which watchers hear),
   * its run held where it is, and journaled.
   */
  async #stop(running: Running): Promise<void> {
    running.stop();
    running.engine.cancelResends();
    // No reservation outlives its runtime: one allocated again starts with none.
    const prefix = `${running.document.id}\u0000`;
    for (const key of [...this.#resends.keys()])
      if (key.startsWith(prefix)) this.#resends.delete(key);
    try {
      await running.delivery.close();
    } finally {
      running.unwatch();
      running.engine.run.pause();
      await this.#write(running);
    }
  }

  /**
   * Journals a canvas's run as it is now, the coalesced write it replaces cancelled, with every
   * change to its messages not on disk yet: in one write, on disk once it resolves.
   */
  async #write(running: Running): Promise<void> {
    clearTimeout(running.timer);
    running.timer = undefined;
    let done: () => void = () => undefined;
    await this.#deps.store.write(() => {
      done = this.#journalWithin(running, true);
    });
    done();
  }

  /**
   * Within a write: what a canvas has to journal, its run (if `run`, or if it changed since the
   * journal last had it on disk) and every change to its messages not on disk yet; returns what
   * marks them on disk once the write's commit returned.
   */
  #journalWithin(running: Running, run: boolean): () => void {
    const done = [
      this.#runWithin(running, run),
      running.messages.changes(),
      running.handoffs.changes(),
    ];
    return () => {
      for (const one of done) one();
    };
  }

  /**
   * Within a write: the canvas's run as it is now, if `force`, or if it changed since the journal
   * last had it on disk; returns what marks it on disk once the write's commit returned.
   */
  #runWithin(running: Running, force: boolean): () => void {
    const covered = running.changes;
    if (!force && covered <= running.saved) return () => undefined;
    const checkpoint: RunCheckpoint = {
      version: 2,
      ...running.engine.checkpoint(),
      updatedAt: Date.now(),
    };
    const problem = this.#deps.journal.keep(
      running.document.id,
      running.token,
      checkpoint,
      running.messages,
    );
    return () => {
      running.saved = Math.max(running.saved, covered);
      this.#deps.journal.kept(running.document.id, problem);
    };
  }

  /** Where a canvas's agents' sessions run: the core's SessionManager, in this process. */
  #backend(canvas: CanvasId, listeners: Running['listeners']): SessionBackend {
    const { sessions, directories, files, environment } = this.#deps;
    const run = <T>(call: () => T): T => this.#deps.processes.run(call);
    const done = (call: () => Promise<unknown>) => run(() => call().then(() => null));
    return {
      availability: (agent) => sessions.availability(canvas, agent),
      onAvailability: (listener) => sessions.onAvailability(canvas, listener),
      start: (agentId, options) =>
        done(async () => {
          await sessions.start(canvas, agentId, options);
          // A window may already own this native session. A newly opened core delivery driver
          // still checks the session's actual permissions, rather than an earlier default.
          for (const event of this.#reports.get(`${canvas}\u0000${agentId}`)?.values() ?? [])
            for (const listener of listeners) listener(agentId, options.connection, event);
        }),
      installed: () => run(async () => installedClis(await environment())),
      send: (agentId, message) => done(() => sessions.send(canvas, agentId, message)),
      answer: (agentId, promptId, answer) =>
        done(() => sessions.answer(canvas, agentId, promptId, answer)),
      interrupt: (agentId) => done(() => sessions.interrupt(canvas, agentId)),
      setMode: (agentId, mode) => done(() => sessions.setMode(canvas, agentId, mode)),
      setModel: (agentId, model) => done(() => sessions.setModel(canvas, agentId, model)),
      setEffort: (agentId, effort) => done(() => sessions.setEffort(canvas, agentId, effort)),
      stopTask: (agentId, taskId) => done(() => sessions.stopTask(canvas, agentId, taskId)),
      close: (agentId) => done(() => sessions.close(canvas, agentId)),
      fresh: (agentId, adapter) => done(() => sessions.fresh(canvas, agentId, adapter)),
      files: async (query, agent) => {
        let folder = directories.projectRoot(canvas);
        if (agent !== undefined) {
          const directory = await directories.workingDirectory(canvas, agent as never);
          folder = directory.state === 'ready' ? directory.cwd : undefined;
        }
        return folder === undefined ? [] : run(() => files.find(folder, query, MAX_FILE_MATCHES));
      },
      options: (adapter, agent) => run(() => sessions.settingsOptions(canvas, adapter, agent)),
      // The runtime's own lists, apart from any window's (B11 Design §7).
      sessions: (agentId) => run(() => sessions.listSessions(canvas, agentId, RUNTIME_CALLER)),
      resume: (agentId, sessionId) =>
        done(() => sessions.resumeSession(canvas, agentId, sessionId, RUNTIME_CALLER)),
      previewRewind: (agentId, messageId) =>
        run(() => sessions.previewRewind(canvas, agentId, messageId)),
      rewind: (agentId, messageId, restore) =>
        run(() => sessions.rewind(canvas, agentId, messageId, restore)),
      mcp: (agentId) => run(() => sessions.mcpServers(canvas, agentId)),
      changeMcp: (agentId, server, change) =>
        run(() => sessions.changeMcpServer(canvas, agentId, server, change)),
      onEvent: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
  }
}

/**
 * The run's mailbox over a canvas's message store (B11 Design §3): each of a task's attempts the
 * run sends is a message, origin `run`, from corrallm (from the queue's agent for a hand-off to
 * another), or, for a correction you typed with it, yours as you typed it (origin `manual`, what
 * you typed its display, beside the held task it corrects), its task link the attempt, delivering
 * under its own id; never a reply, a notice or a party's message to deliver. Its body is capped as
 * any message's is: the session gets the whole of it, from memory. The first of the run's own sends
 * to an agent since a switch (never your correction) carries the agent's handoff (`carry`, B11a
 * C7), taken as it is recorded, so the write that records it clears the carry, and kept with a
 * told key that says it carried one (HANDOFF_CARRIED and the switch, never the text); one whose
 * record couldn't be kept, or that was taken back before its session had it, leaves it to the
 * next, and a crash that cut it off unsent does too (Delivery.start).
 */
function runMailbox(
  messages: MessageStore,
  carry?: (
    to: string,
    text: string,
    owner: string,
  ) => { text: string; carry: string; undo: () => void } | undefined,
): RunMailbox {
  const carried = new Map<string, () => void>();
  return {
    record: ({ to, owner, text: given, task, images, typed }) => {
      const carrying = typed === undefined ? carry?.(to, given, owner) : undefined;
      const text = carrying?.text ?? given;
      const display: MessageDisplay = {
        ...(typed === undefined
          ? {}
          : { text: typed, task: { agent: task.agent, item: task.item } }),
        ...(images > 0 ? { images } : {}),
      };
      const message = messages.add(
        {
          from: typed !== undefined ? 'you' : owner === to ? 'corrallm' : agentParty(owner),
          to: agentParty(to),
          kind: 'text',
          origin: typed === undefined ? 'run' : 'manual',
          ...(Object.keys(display).length === 0 ? {} : { display }),
          body: capBody(given, 'prompt'),
          task,
          state: 'delivering',
        },
        carrying === undefined ? undefined : `${HANDOFF_CARRIED}${carrying.carry}`,
      );
      messages.update(message.id, { delivery: { at: message.at, as: message.id, attempt: 1 } });
      if (carrying !== undefined) carried.set(message.id, carrying.undo);
      return { id: message.id, text };
    },
    settle: (id, end) => {
      const { state, turn } = end;
      const undo = carried.get(id);
      carried.delete(id);
      if (undo !== undefined && (state === 'unresolved' || (state === 'withdrawn' && end.unsent))) {
        undo();
        messages.retell(id, undefined);
      }
      const message = messages.get(id);
      // Cut off meanwhile (the core stopping), it stays as that left it.
      if (message?.state !== 'delivering' && message?.state !== 'delivered') return;
      messages.update(id, { state, turn, ...(state === 'withdrawn' ? { by: 'corrallm' } : {}) });
    },
  };
}

/** What an open canvas's needs are worded from. */
export function needsInput(open: OpenCanvas, locale: string | undefined): NeedsInput {
  const { document, engine, delivery } = open;
  return {
    canvas: document.id,
    nodes: document.nodes,
    run: engine.run.snapshot(),
    sessions: engine.sessions.snapshot(),
    catalog: engine.catalog,
    now: Date.now(),
    stuck: delivery.stuck(),
    unasking: delivery.unasking(),
    limited: delivery.limited(),
    ...(open.sessionGeneration === undefined ? {} : { sessionGenerations: open.sessionGeneration }),
    ...(locale === undefined ? {} : { locale }),
  };
}
