import type { Children } from './children';
import type { ConnectionId } from '../../shared/adapter';
import { canvasIdOf } from '../../shared/canvas';
import type { CanvasId } from '../../shared/canvas';
import type { EngineCatalog } from '../../shared/engine/catalog';
import { Engine } from '../../shared/engine/engine';
import { needs } from '../../shared/engine/needs';
import type { NeedsInput } from '../../shared/engine/needs';
import type { SessionBackend } from '../../shared/engine/transcript/receive';
import type { CanvasDocument } from '../../shared/model/canvas';
import type { Message, PartyId } from '../../shared/model/messages';
import { agentParty } from '../../shared/model/messages';
import type { NeedsItem } from '../../shared/model/needs';
import type { RunCheckpoint } from '../../shared/run';
import { MAX_FILE_MATCHES } from '../../shared/session';
import type { SessionEvent, UserMessage } from '../../shared/session';
import { usedUpUntil } from '../../shared/usage';
import type { ProjectFiles } from '../files';
import type { ProjectFolders } from '../project';
import type { RunJournal } from '../run-journal';
import { installedClis } from '../sessions/installed';
import type { SessionManager } from '../sessions/manager';
import type { UsageReadings } from '../usage';
import type { Documents } from './canvas/documents';
import { Delivery } from './delivery/delivery';
import { MessageStore } from './delivery/messages';
import type { MessageTable } from './delivery/messages';
import { WithdrawalNotes } from './delivery/withdrawals';
import { ReadPositions } from './delivery/reads';
import type { Database } from './store/store';

/*
 * The canvases the core runs, each with its engine (src/shared/engine/engine.ts): the run and the
 * sessions it sends to, the sessions run by the core's own SessionManager, in the same process; and
 * its messages (delivery/messages.ts), which parties send its agents (delivery/delivery.ts). A
 * canvas opens by its id, from what the profile keeps of it: its file and its project folder, which
 * the user picked in the app (canvas memory), its document as the core keeps it (from its rows,
 * else read from its file: core/canvas/documents.ts; a file changed on disk is reviewed, never read
 * over its rows), whose live document it reads from then on, and its run as the journal last kept
 * it, restored paused. A canvas with no file opens only if
 * the core keeps its document (one a token made), and none whose file holds another canvas. It is
 * open (the journal's `open_canvas`) until it is closed (`closeCanvas`: its run journaled, its
 * sessions ended). One opened held delivers nothing until `deliver()`, so a host that may still
 * refuse to start (`corrallm serve`) sends nothing. Whatever its engine does is journaled again: at most one
 * write per COALESCE_MS, and one before every message the run sends, so a sent message's record is
 * always on disk first. Its run and its messages are one record: each write of either holds every
 * change to the other not on disk yet (a run's only if it changed since it last was), so what
 * changes together lands together, or not at all (a kill's hold and its withdrawals, a turn's
 * reply and what its end changed in the run). An oversized run keeps a size refusal and its last
 * good checkpoint instead, never failing messages for size alone. A `wait` moves every read position in one
 * write with them, or none, before it returns. Each message delivering is on disk before it is
 * sent. Whoever watches hears each message added to a canvas's store, closing it included, and each
 * thing newly waiting for an answer on it (`corrallm serve` logs them).
 */

const COALESCE_MS = 250;
const NO_FOLDER =
  'This canvas has no project folder: open it in corrallm and choose its folder there, so its agents can work.';
const NO_FILE = 'This canvas isn’t saved: save it in corrallm first.';
const ANOTHER = 'This canvas’s file holds another canvas now: open it in corrallm to run it.';
const NO_SWITCH = 'Switch this agent to another connection in the corrallm app.';
const JOURNAL_FAILED = 'Could not journal every canvas’s run as the core closed.';

export interface EnginesDeps {
  processes: Pick<Children, 'run'>;
  /** What the engines read of the catalog. */
  engineCatalog: EngineCatalog;
  sessions: SessionManager;
  projects: ProjectFolders;
  journal: RunJournal;
  /** Each canvas's document, its file checked as it opens. */
  documents: Pick<Documents, 'review' | 'live' | 'hasRows'>;
  /** Every canvas's messages, in the profile's database. */
  messages: MessageTable;
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
}

/** A canvas the core runs: its document, its engine and its messages. */
export interface OpenCanvas {
  /** Its document as the core has it now. */
  readonly document: CanvasDocument;
  engine: Engine;
  messages: MessageStore;
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
}

/** A canvas the core runs, with its sessions' listeners and its journal. */
interface Running extends OpenCanvas {
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
  readonly #running = new Map<CanvasId, Promise<Running>>();
  /** The canvases open now, once opened. */
  readonly #canvases = new Map<CanvasId, Running>();
  readonly #mail = new Map<CanvasId, Promise<{ messages: MessageStore; notes: WithdrawalNotes }>>();
  readonly #watchers = new Set<Watcher>();
  readonly #events = new Map<string, Promise<SessionEvent>>();
  #closed = false;

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
    const messages = store
      .active()
      .filter(
        (message) =>
          message.kind === 'text' &&
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
          body: text,
          replyTo: message.id,
          state: 'delivered',
        },
        `stalled:${message.id}`,
      );
    }
    await store.durable();
  }

  /** The canvases the core has open, in the order they opened. */
  opened(): CanvasId[] {
    return [...this.#canvases.keys()];
  }

  /**
   * The canvas's engine, opening it if it isn't yet: its document as the core keeps it, and its run
   * as the journal last kept it, restored paused, delivering at once unless `held`. Rejects, saying
   * why, for a canvas the profile keeps no project folder or file for, or whose file holds another
   * canvas now.
   */
  open(canvas: CanvasId, { held = false }: OpenOptions = {}): Promise<Engine> {
    if (this.#closed) return Promise.reject(new Error('The core’s canvases have closed.'));
    let running = this.#running.get(canvas);
    if (!running) {
      running = this.#open(canvas, held);
      running.catch(() => {
        if (this.#running.get(canvas) === running) this.#running.delete(canvas);
      });
      this.#running.set(canvas, running);
    }
    return running.then(({ engine }) => engine);
  }

  /** Starts delivering on every canvas opened held: what waits on each goes once it can. */
  async deliver(): Promise<void> {
    await Promise.all([...this.#canvases.values()].map(({ delivery }) => delivery.start()));
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
   * What a session of one of the canvas's agents did (SessionManager's `emit`): resolves with the
   * event as the core took it, for its windows (a turn's end that hit a usage limit saying when it
   * lifts, where its connection couldn't: `#ended`).
   */
  emit(
    canvas: CanvasId,
    agentId: string,
    connection: ConnectionId,
    event: SessionEvent,
  ): Promise<SessionEvent> {
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
  ): Promise<SessionEvent> {
    const event = given.type === 'end' ? await this.#ended(connection, given) : given;
    const mail = await this.#mail.get(canvas);
    mail?.notes.receive(agentId, event);
    const running = await this.#running.get(canvas);
    for (const listener of running?.listeners ?? []) listener(agentId, connection, event);
    return event;
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
   * in the renderer until B11: reading its notes never composes or journals another run.
   */
  async sending(
    canvas: CanvasId,
    agentId: string,
    message: UserMessage,
    send: (message: UserMessage) => Promise<void>,
  ): Promise<void> {
    if (this.#closed) throw new Error('The canvas closed before its message could be sent.');
    const { notes } = await this.#mailOf(canvas);
    await notes.send(agentId, message, send);
  }

  /**
   * Closes a canvas it runs (canvas.close): what its messages were doing cut off, its run held
   * where it is and journaled, then its sessions closed. Nothing if it doesn't run it; rejects,
   * once its sessions are closed, if its run couldn't be journaled.
   */
  async closeCanvas(canvas: CanvasId): Promise<void> {
    const opening = this.#running.get(canvas);
    if (opening === undefined) return;
    this.#running.delete(canvas);
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
      await this.#deps.sessions.closeCanvas(canvas);
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
    const running = await Promise.allSettled(this.#running.values());
    this.#running.clear();
    this.#canvases.clear();
    const stopped = await Promise.allSettled(
      running.flatMap((opened) =>
        opened.status === 'fulfilled' ? [this.#stop(opened.value)] : [],
      ),
    );
    await this.#deps.journal.flush();
    await this.#deps.sessions.closeEverything();
    await Promise.all(this.#events.values());
    await Promise.all(mail.map(({ messages }) => messages.durable()));
    const failed = stopped.flatMap((result): unknown[] =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (failed.length > 0) throw new AggregateError(failed, JOURNAL_FAILED);
  }

  async #open(canvas: CanvasId, held: boolean): Promise<Running> {
    const { projects, journal, documents } = this.#deps;
    if ((await projects.restore(canvas)) === undefined) throw new Error(NO_FOLDER);
    const context = await journal.get(canvas);
    // A canvas the core keeps the document of opens with no file (one a token made, never saved:
    // B9 Design §8); any other only from the file canvas memory names for it, while that file
    // holds no other canvas: never a draft that holds nothing, though the journal keeps one's run.
    if (context.savedText === undefined) {
      if (!documents.hasRows(canvas)) throw new Error(NO_FILE);
    } else {
      let holds: CanvasId | undefined;
      try {
        holds = canvasIdOf(context.savedText);
      } catch (error) {
        // One whose document the core keeps opens from it, its file reviewed (B9 Design §5).
        if (!documents.hasRows(canvas)) throw error;
      }
      if (holds !== undefined && holds !== canvas) throw new Error(ANOTHER);
    }
    // With its edits since, as the core keeps them: a file changed on disk meanwhile is never read
    // over them, but reviewed (B9 Design §5).
    const { document } = await documents.review(canvas);
    if (context.checkpoint) Engine.check(context.checkpoint);
    const listeners: Running['listeners'] = new Set();
    const { messages } = await this.#mailOf(canvas);
    const warnings: readonly string[] = [context.warning, messages.warning].filter(
      (one) => one !== undefined,
    );
    // The engine and what journals it need each other.
    const running = {
      get document() {
        return documents.live(canvas).document;
      },
      messages,
      warnings,
      unwatch: messages.subscribe((message) => {
        for (const watcher of this.#watchers) watcher.message?.(message);
      }),
      token: context.token,
      listeners,
      timer: undefined,
      changes: 0,
      saved: 0,
      needs: new Set(),
      looking: false,
    } as Running;
    running.reads = new ReadPositions(await journal.reads(canvas));
    running.journal = () => this.#write(running);
    // What its messages write, they write with its run, if that changed since it was last on disk.
    messages.writeWith(() => this.#runWithin(running, false));
    const engine = new Engine({
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
      // Only you switch how an agent runs, in the app (the run's refusal asks you there).
      connect: (agent) => {
        engine.sessions.notice(agent, 'warning', NO_SWITCH);
      },
      beforeSend: () => this.#write(running),
      ...(this.#deps.locale === undefined ? {} : { locale: this.#deps.locale }),
    });
    running.engine = engine;
    engine.update(document.nodes);
    if (context.checkpoint) engine.restore(context.checkpoint);
    const delivery = new Delivery({
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
      defaultAsks: (adapter) =>
        this.#deps.processes
          .run(() => this.#deps.sessions.settingsOptions(canvas, adapter))
          .then(({ defaults }) => defaults.asks),
      ...(this.#deps.locale === undefined ? {} : { locale: this.#deps.locale }),
    });
    running.delivery = delivery;
    if (!held) await delivery.start();
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
      // Usage rules are checked again with each reading.
      this.#deps.usage.subscribe(() => {
        engine.run.usageChanged();
        delivery.schedule();
        look();
      }),
    ];
    running.stop = () => {
      for (const stop of unsubscribe) stop();
      clearTimeout(running.timer);
      running.timer = undefined;
    };
    this.#canvases.set(canvas, running);
    // Open until it is closed (B9 Design §2).
    await journal.open(canvas);
    this.#look(running);
    for (const watcher of this.#watchers) watcher.opened?.(canvas);
    return running;
  }

  #mailOf(canvas: CanvasId): Promise<{ messages: MessageStore; notes: WithdrawalNotes }> {
    let mail = this.#mail.get(canvas);
    if (!mail) {
      mail = (async () => {
        const messages = new MessageStore(canvas, this.#deps.messages, () => Date.now());
        await messages.load();
        return {
          messages,
          notes: new WithdrawalNotes(messages, this.#deps.engineCatalog.shellPrefixes),
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
    const done = [this.#runWithin(running, run), running.messages.changes()];
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
    const problem = this.#deps.journal.keep(running.document.id, running.token, checkpoint);
    return () => {
      running.saved = Math.max(running.saved, covered);
      this.#deps.journal.kept(running.document.id, problem);
    };
  }

  /** Where a canvas's agents' sessions run: the core's SessionManager, in this process. */
  #backend(canvas: CanvasId, listeners: Running['listeners']): SessionBackend {
    const { sessions, projects, files, environment } = this.#deps;
    const run = <T>(call: () => T): T => this.#deps.processes.run(call);
    const done = (call: () => Promise<unknown>) => run(() => call().then(() => null));
    return {
      start: (agentId, options) => done(() => sessions.start(canvas, agentId, options)),
      installed: () => run(async () => installedClis(await environment())),
      send: (agentId, message) => done(() => sessions.send(canvas, agentId, message)),
      answer: (agentId, promptId, answer) =>
        done(() => sessions.answer(canvas, agentId, promptId, answer)),
      interrupt: (agentId, options) =>
        done(() => sessions.interrupt(canvas, agentId, ...(options ? [options] : []))),
      setMode: (agentId, mode) => done(() => sessions.setMode(canvas, agentId, mode)),
      setModel: (agentId, model) => done(() => sessions.setModel(canvas, agentId, model)),
      setEffort: (agentId, effort) => done(() => sessions.setEffort(canvas, agentId, effort)),
      stopTask: (agentId, taskId) => done(() => sessions.stopTask(canvas, agentId, taskId)),
      close: (agentId) => done(() => sessions.close(canvas, agentId)),
      fresh: (agentId, adapter) => done(() => sessions.fresh(canvas, agentId, adapter)),
      files: async (query) => {
        const folder = projects.of(canvas);
        return folder === undefined ? [] : run(() => files.find(folder, query, MAX_FILE_MATCHES));
      },
      options: (adapter) => run(() => sessions.settingsOptions(canvas, adapter)),
      sessions: (agentId) => run(() => sessions.listSessions(canvas, agentId)),
      resume: (agentId, sessionId) =>
        done(() => sessions.resumeSession(canvas, agentId, sessionId)),
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
    ...(locale === undefined ? {} : { locale }),
  };
}
