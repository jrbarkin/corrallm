import type { Catalog, ConnectionId } from '../../shared/adapter';
import { canvasIdOf } from '../../shared/canvas';
import type { CanvasId } from '../../shared/canvas';
import type { EngineCatalog } from '../../shared/engine/catalog';
import { Engine } from '../../shared/engine/engine';
import { needs } from '../../shared/engine/needs';
import type { NeedsInput } from '../../shared/engine/needs';
import type { SessionBackend } from '../../shared/engine/transcript/receive';
import type { CanvasDocument } from '../../shared/model/canvas';
import { fromFile, toFile } from '../../shared/model/file';
import type { Message } from '../../shared/model/messages';
import type { NeedsItem } from '../../shared/model/needs';
import type { RunCheckpoint } from '../../shared/run';
import { MAX_FILE_MATCHES } from '../../shared/session';
import type { SessionEvent } from '../../shared/session';
import type { ProjectFiles } from '../files';
import type { ProjectFolders } from '../project';
import type { RunJournal } from '../run-journal';
import { installedClis } from '../sessions/installed';
import type { SessionManager } from '../sessions/manager';
import type { UsageReadings } from '../usage';
import { Delivery } from './delivery/delivery';
import { MessageStore } from './delivery/messages';
import { ReadPositions } from './delivery/reads';

/*
 * The canvases the core runs, each with its engine (src/shared/engine/engine.ts): the run and the
 * sessions it sends to, the sessions run by the core's own SessionManager, in the same process;
 * and its messages (delivery/messages.ts), which parties send its agents (delivery/delivery.ts).
 * A canvas opens by its id, from what the profile keeps of it: its file and its project folder,
 * which the user picked in the app (canvases.json), and its run as the journal last kept it
 * (runs/<id>/record.json), restored paused. A draft, which has no file, never opens, nor does a
 * canvas whose file holds another canvas. Whatever its engine does is journaled again: at most
 * one write per COALESCE_MS, and one before every message the run sends, so a sent message's
 * record is always on disk first; its messages are journaled beside its run, each one delivering
 * forced to disk before it is sent, and so is where each party's `wait` has read to in them, before
 * the `wait` that moved it returns. Whoever watches hears each message added to a canvas's store,
 * and each thing newly waiting for an answer on it (`corrallm serve` logs them).
 */

const COALESCE_MS = 250;
const NO_FOLDER =
  'This canvas has no project folder: open it in corrallm and choose its folder there, so its agents can work.';
const NO_FILE = 'This canvas isn’t saved: save it in corrallm first.';
const ANOTHER = 'This canvas’s file holds another canvas now: open it in corrallm to run it.';
const NO_SWITCH = 'Switch this agent to another connection in the corrallm app.';
const JOURNAL_FAILED = 'Could not journal every canvas’s run as the core closed.';

export interface EnginesDeps {
  /** What every adapter declares: what a canvas's file is read against. */
  catalog: Catalog;
  /** What the engines read of it. */
  engineCatalog: EngineCatalog;
  sessions: SessionManager;
  projects: ProjectFolders;
  journal: RunJournal;
  usage: Pick<UsageReadings, 'state' | 'subscribe'>;
  files: ProjectFiles;
  /** The environment agents run in (environment.ts). */
  environment: () => Promise<Readonly<Record<string, string>>>;
  /** The locale the engines tell times of day in (the host's): the runtime's own, when none. */
  locale?: string;
}

/** A canvas the core runs: its document, its engine and its messages. */
export interface OpenCanvas {
  document: CanvasDocument;
  engine: Engine;
  messages: MessageStore;
  delivery: Delivery;
  /** Where each party's `wait` has read to in its messages. */
  reads: ReadPositions;
}

/** What hears the canvases the core runs. */
export interface Watcher {
  /** A message added to a canvas's store. */
  message?(message: Message): void;
  /** Something newly waiting for an answer on a canvas: a hold of the run, a session's prompt. */
  need?(canvas: CanvasId, item: NeedsItem): void;
}

/** A canvas the core runs, with its sessions' listeners and its journal. */
interface Running extends OpenCanvas {
  /** Its generation's token in the journal, which its writes carry. */
  token: string;
  listeners: Set<(agentId: string, connection: ConnectionId, event: SessionEvent) => void>;
  /** The coalesced write waiting, if any. */
  timer: ReturnType<typeof setTimeout> | undefined;
  /** What stops it hearing its engine change, and usage readings. */
  stop: () => void;
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
  readonly #watchers = new Set<Watcher>();

  constructor(deps: EnginesDeps) {
    this.#deps = deps;
  }

  /** A canvas the core has open, if it has. */
  canvas(canvas: CanvasId): OpenCanvas | undefined {
    return this.#canvases.get(canvas);
  }

  /** The canvases the core has open, in the order they opened. */
  opened(): CanvasId[] {
    return [...this.#canvases.keys()];
  }

  /**
   * The canvas's engine, opening it if it isn't yet: its document and run as the journal last kept
   * them (else its file), restored paused. Rejects, saying why, for a canvas the profile keeps no
   * project folder or file for, or whose file holds another canvas now.
   */
  open(canvas: CanvasId): Promise<Engine> {
    let running = this.#running.get(canvas);
    if (!running) {
      running = this.#open(canvas);
      running.catch(() => {
        if (this.#running.get(canvas) === running) this.#running.delete(canvas);
      });
      this.#running.set(canvas, running);
    }
    return running.then(({ engine }) => engine);
  }

  /**
   * Hears every canvas the core runs, from now on: each message added, and what newly waits for an
   * answer (what waits already, on each canvas open, at once).
   */
  watch(watcher: Watcher): () => void {
    this.#watchers.add(watcher);
    for (const running of this.#canvases.values()) this.#look(running);
    return () => {
      this.#watchers.delete(watcher);
    };
  }

  /** What a session of one of the canvas's agents did (SessionManager's `emit`). */
  emit(canvas: CanvasId, agentId: string, connection: ConnectionId, event: SessionEvent): void {
    void this.#running.get(canvas)?.then(
      ({ listeners }) => {
        for (const listener of listeners) listener(agentId, connection, event);
      },
      () => undefined,
    );
  }

  /**
   * Stops every canvas, as the core closes: its run held where it is (what was going on is
   * uncertain until inspected), journaled, then its sessions closed. Every session closes even if a
   * run can't be journaled; then it rejects, with why each couldn't.
   */
  async close(): Promise<void> {
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
    const failed = stopped.flatMap((result): unknown[] =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (failed.length > 0) throw new AggregateError(failed, JOURNAL_FAILED);
  }

  async #open(canvas: CanvasId): Promise<Running> {
    const { projects, journal } = this.#deps;
    if ((await projects.restore(canvas)) === undefined) throw new Error(NO_FOLDER);
    const context = await journal.get(canvas);
    // Only a canvas saved in the file canvases.json names for it, while that file still holds it:
    // never a draft, though the journal keeps one's run.
    if (context.savedText === undefined) throw new Error(NO_FILE);
    if (canvasIdOf(context.savedText) !== canvas) throw new Error(ANOTHER);
    // With its edits since, as the app journaled them.
    const document = fromFile(
      context.checkpoint?.workflow ?? context.savedText,
      this.#deps.catalog,
      this.#deps.engineCatalog.defaultAdapter,
    );
    if (document.id !== canvas) throw new Error(ANOTHER);
    if (context.checkpoint) Engine.check(context.checkpoint);
    const listeners: Running['listeners'] = new Set();
    const messages = new MessageStore(canvas, journal, () => Date.now());
    await messages.load();
    if (messages.warning !== undefined) console.warn(messages.warning);
    // The engine and what journals it need each other.
    const running = {
      document,
      messages,
      token: context.token,
      listeners,
      timer: undefined,
      needs: new Set(),
      looking: false,
    } as Running;
    running.reads = new ReadPositions(await journal.reads(canvas), () => this.#write(running));
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
      now: () => Date.now(),
      later: (run, ms) => {
        const timer = setTimeout(run, ms);
        return () => {
          clearTimeout(timer);
        };
      },
      ...(this.#deps.locale === undefined ? {} : { locale: this.#deps.locale }),
    });
    running.delivery = delivery;
    await delivery.start();
    const changed = () => {
      running.timer ??= setTimeout(() => {
        running.timer = undefined;
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
      messages.subscribe((message) => {
        for (const watcher of this.#watchers) watcher.message?.(message);
      }),
      // Usage rules are checked again with each reading.
      this.#deps.usage.subscribe(() => {
        engine.run.usageChanged();
        delivery.schedule();
      }),
    ];
    running.stop = () => {
      for (const stop of unsubscribe) stop();
      clearTimeout(running.timer);
      running.timer = undefined;
    };
    this.#canvases.set(canvas, running);
    this.#look(running);
    return running;
  }

  /**
   * Soon tells the watchers that hear needs what newly waits for an answer on a canvas: once,
   * however often asked before then.
   */
  #look(running: Running): void {
    if (running.looking || ![...this.#watchers].some((watcher) => watcher.need !== undefined)) {
      return;
    }
    running.looking = true;
    queueMicrotask(() => {
      running.looking = false;
      if (this.#canvases.get(running.document.id) !== running) return;
      const items = needs(needsInput(running, this.#deps.locale));
      for (const item of items) {
        if (running.needs.has(item.id)) continue;
        for (const watcher of this.#watchers) watcher.need?.(running.document.id, item);
      }
      running.needs = new Set(items.map(({ id }) => id));
    });
  }

  /**
   * Stops a canvas as the core closes: what its messages were doing cut off, its run held where it
   * is, and journaled.
   */
  async #stop(running: Running): Promise<void> {
    running.stop();
    try {
      await running.delivery.close();
    } finally {
      running.engine.run.pause();
      await this.#write(running);
    }
  }

  /** Journals a canvas's run as it is now, the coalesced write it replaces cancelled. */
  #write(running: Running): Promise<void> {
    clearTimeout(running.timer);
    running.timer = undefined;
    const checkpoint: RunCheckpoint = {
      version: 2,
      workflow: toFile(running.document),
      ...running.engine.checkpoint(),
      updatedAt: Date.now(),
    };
    return this.#deps.journal.save(
      running.document.id,
      running.token,
      checkpoint,
      running.reads.all(),
    );
  }

  /** Where a canvas's agents' sessions run: the core's SessionManager, in this process. */
  #backend(canvas: CanvasId, listeners: Running['listeners']): SessionBackend {
    const { sessions, projects, files, environment } = this.#deps;
    const done = (call: Promise<unknown>) => call.then(() => null);
    return {
      start: (agentId, options) => done(sessions.start(canvas, agentId, options)),
      installed: async () => installedClis(await environment()),
      send: (agentId, message) => done(sessions.send(canvas, agentId, message)),
      answer: (agentId, promptId, answer) =>
        done(sessions.answer(canvas, agentId, promptId, answer)),
      interrupt: (agentId) => done(sessions.interrupt(canvas, agentId)),
      setMode: (agentId, mode) => done(sessions.setMode(canvas, agentId, mode)),
      setModel: (agentId, model) => done(sessions.setModel(canvas, agentId, model)),
      setEffort: (agentId, effort) => done(sessions.setEffort(canvas, agentId, effort)),
      stopTask: (agentId, taskId) => done(sessions.stopTask(canvas, agentId, taskId)),
      close: (agentId) => done(sessions.close(canvas, agentId)),
      fresh: (agentId, adapter) => done(sessions.fresh(canvas, agentId, adapter)),
      files: async (query) => {
        const folder = projects.of(canvas);
        return folder === undefined ? [] : files.find(folder, query, MAX_FILE_MATCHES);
      },
      options: (adapter) => sessions.settingsOptions(canvas, adapter),
      sessions: (agentId) => sessions.listSessions(canvas, agentId),
      resume: (agentId, sessionId) => done(sessions.resumeSession(canvas, agentId, sessionId)),
      previewRewind: (agentId, messageId) => sessions.previewRewind(canvas, agentId, messageId),
      rewind: (agentId, messageId, restore) => sessions.rewind(canvas, agentId, messageId, restore),
      mcp: (agentId) => sessions.mcpServers(canvas, agentId),
      changeMcp: (agentId, server, change) =>
        sessions.changeMcpServer(canvas, agentId, server, change),
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
    ...(locale === undefined ? {} : { locale }),
  };
}
