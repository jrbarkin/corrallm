import type { Catalog, ConnectionId } from '../../shared/adapter';
import type { CanvasId } from '../../shared/canvas';
import type { EngineCatalog } from '../../shared/engine/catalog';
import { Engine } from '../../shared/engine/engine';
import type { SessionBackend } from '../../shared/engine/transcript/receive';
import type { CanvasDocument } from '../../shared/model/canvas';
import { fromFile, toFile } from '../../shared/model/file';
import type { RunCheckpoint } from '../../shared/run';
import { MAX_FILE_MATCHES } from '../../shared/session';
import type { SessionEvent } from '../../shared/session';
import type { ProjectFiles } from '../files';
import type { ProjectFolders } from '../project';
import type { RunJournal } from '../run-journal';
import { installedClis } from '../sessions/installed';
import type { SessionManager } from '../sessions/manager';
import type { UsageReadings } from '../usage';

/*
 * The canvases the core runs, each with its engine (src/shared/engine/engine.ts): the run and the
 * sessions it sends to, the sessions run by the core's own SessionManager, in the same process.
 * A canvas opens by its id, from what the profile keeps of it: its file and its project folder,
 * which the user picked in the app (canvases.json), and its run as the journal last kept it
 * (runs/<id>/record.json), restored paused. Whatever its engine does is journaled again: at most
 * one write per COALESCE_MS, and one before every message the run sends, so a sent message's
 * record is always on disk first.
 */

const COALESCE_MS = 250;
const NO_FOLDER =
  'This canvas has no project folder: open it in corrallm and choose its folder there, so its agents can work.';
const NO_FILE = 'This canvas isn’t saved: save it in corrallm first.';
const ANOTHER = 'This canvas’s file holds another canvas now: open it in corrallm to run it.';
const NO_SWITCH = 'This agent is switched to another connection in the corrallm app.';

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

/** A canvas the core runs: its document, its engine, its sessions' listeners and its journal. */
interface Running {
  document: CanvasDocument;
  engine: Engine;
  /** Its generation's token in the journal, which its writes carry. */
  token: string;
  listeners: Set<(agentId: string, connection: ConnectionId, event: SessionEvent) => void>;
  /** The coalesced write waiting, if any. */
  timer: ReturnType<typeof setTimeout> | undefined;
  /** What stops it hearing its engine change, and usage readings. */
  stop: () => void;
}

export class Engines {
  readonly #deps: EnginesDeps;
  readonly #running = new Map<CanvasId, Promise<Running>>();

  constructor(deps: EnginesDeps) {
    this.#deps = deps;
  }

  /**
   * The canvas's engine, opening it if it isn't yet: its document and run as the journal last kept
   * them (else its file), restored paused. Rejects, saying why, for a canvas the profile keeps no
   * project folder or file for.
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
   * uncertain until inspected), journaled, then its sessions closed.
   */
  async close(): Promise<void> {
    const running = await Promise.allSettled(this.#running.values());
    this.#running.clear();
    await Promise.all(
      running.flatMap((opened) => {
        if (opened.status !== 'fulfilled') return [];
        const { value } = opened;
        value.stop();
        value.engine.run.pause();
        return [this.#write(value)];
      }),
    );
    await this.#deps.journal.flush();
    await this.#deps.sessions.closeEverything();
  }

  async #open(canvas: CanvasId): Promise<Running> {
    const { projects, journal } = this.#deps;
    if ((await projects.restore(canvas)) === undefined) throw new Error(NO_FOLDER);
    const context = await journal.get(canvas);
    const text = context.checkpoint?.workflow ?? context.savedText;
    if (text === undefined) throw new Error(NO_FILE);
    const document = fromFile(text, this.#deps.catalog, this.#deps.engineCatalog.defaultAdapter);
    if (document.id !== canvas) throw new Error(ANOTHER);
    if (context.checkpoint) Engine.check(context.checkpoint);
    const listeners: Running['listeners'] = new Set();
    // The engine and what journals it need each other.
    const running = { document, token: context.token, listeners, timer: undefined } as Running;
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
    const changed = () => {
      running.timer ??= setTimeout(() => {
        running.timer = undefined;
        void this.#write(running).catch((error: unknown) => {
          console.error('Could not journal the run:', error);
        });
      }, COALESCE_MS);
    };
    const unsubscribe = [
      engine.run.subscribe(changed),
      engine.sessions.subscribe(changed),
      // Usage rules are checked again with each reading.
      this.#deps.usage.subscribe(() => {
        engine.run.usageChanged();
      }),
    ];
    running.stop = () => {
      for (const stop of unsubscribe) stop();
      clearTimeout(running.timer);
      running.timer = undefined;
    };
    return running;
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
    return this.#deps.journal.save(running.document.id, running.token, checkpoint);
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
