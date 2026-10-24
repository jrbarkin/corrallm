import path from 'node:path';

import type { Keyed } from '../../../shared/api/topics';
import type { CanvasId } from '../../../shared/canvas';
import type { CanvasDocument } from '../../../shared/model/canvas';
import type { PartyId } from '../../../shared/model/messages';
import { META } from '../../../shared/model/rows';
import type { EntityKey, MetaRow, Row } from '../../../shared/model/rows';
import type { Entities, Entity, MetaEntity, ProjectOf } from '../../../shared/model/state';
import type { CanvasMemory } from '../../memory';
import { OpFailure } from '../call';
import type { Database } from '../store/store';
import type { Commit, Documents } from './documents';

/*
 * What the core says of each canvas it keeps (B9 Design §7, Core Server §5.1): a canvas's entities,
 * as its `canvas:<c>` topic carries them and `canvas.get` reads them (its document's rows, each
 * stamped with the revision it took last and the party that wrote it, and its meta), and the list
 * of every canvas it keeps, as `canvas.list` and the `canvases` topic give it.
 *
 * A canvas's changes come from the commit path: each commit's diff, never a re-read (documents.ts
 * tells of each commit once it is on disk, before anything else reads it), which it says to whoever
 * listens with the commit's revision. Its meta is the document's (whether edits lay it out, which a
 * commit changes) and what the core says of the canvas: its file's name and its project folder, as
 * canvas memory keeps them, and whether it is edited, recomputed after commits at most every
 * EDITED_EVERY ms (a document's text is hashed to tell: B9 Design §3). A change to the meta alone (a
 * folder chosen, a file saved, `edited` flipping) takes the canvas's next revision in memory, between
 * its commits, without being written. `canvas.get` reads the meta as it was last said, so the two
 * never differ.
 *
 * A canvas is followed this way once read (`read`), which loads its document; until then nothing is
 * said of its changes but that the list may have changed.
 */

/** How often a canvas's `edited` is recomputed after commits, at most. */
export const EDITED_EVERY = 250;

/** A canvas in the list: as `canvas.list` gives it. */
export interface Listed {
  canvas: CanvasId;
  name: string | null;
  edited: boolean;
  running: boolean;
  open: boolean;
  project: ProjectOf | null;
  shownIn: number[];
}

/** A change to a canvas's entities: its revision, who made it, what it set and removed. */
export interface CanvasChange extends Keyed {
  rev: number;
  by: PartyId;
}

/** A canvas's entities as they are now, at its revision, with the document they hold. */
export interface Read {
  rev: number;
  entities: Entities;
  document: CanvasDocument;
}

/** What hears the canvases change. */
export interface StatesListener {
  /** A followed canvas's entities changed, at revision `change.rev`. */
  canvas?(canvas: CanvasId, change: CanvasChange): void;
  /** The list of canvases may have changed. */
  list?(): void;
}

export interface CanvasStatesDeps {
  documents: Pick<
    Documents,
    'load' | 'loaded' | 'live' | 'hasRows' | 'edited' | 'between' | 'bump' | 'subscribe'
  >;
  memory: Pick<CanvasMemory, 'get' | 'list' | 'keeps'>;
  /** The profile's database: which canvases are open, and their runs. */
  store: Pick<Database, 'prepare'>;
  /** The windows showing a canvas. */
  shownIn: (canvas: CanvasId) => number[];
  /** The canvases the core runs. */
  running: () => readonly CanvasId[];
  /**
   * Whether the run of a canvas the core runs is running now, from its live runtime (B11 §5); none
   * for a canvas it doesn't run (a window's, or one closed), whose run is as the journal last kept.
   */
  live?: (canvas: CanvasId) => boolean | undefined;
  now?: () => number;
}

/** A canvas followed: its meta as last said, its entities as last made, and its `edited` clock. */
interface Feed {
  meta: MetaEntity;
  /** Each entity as last made, with the row, revision and writer it was made of. */
  made: Map<EntityKey, { row: Row; rev: number; by: PartyId; entity: Entity }>;
  /** When `edited` was last recomputed after a commit (never: -Infinity). */
  computed: number;
  /** The recomputation waiting, if any. */
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Whether its document is kept in rows, as the list says (a draft's isn't until it holds something). */
  kept: boolean;
}

export class CanvasStates {
  readonly #deps: CanvasStatesDeps;
  readonly #now: () => number;
  /** The canvases followed, once followed. */
  readonly #feeds = new Map<CanvasId, Feed>();
  /** The canvases being followed, until they are. */
  readonly #following = new Map<CanvasId, Promise<Feed>>();
  readonly #listeners = new Set<StatesListener>();
  /** Each canvas's run as last read, invalidated by every journal save, not its wall-clock time. */
  readonly #runs = new Map<CanvasId, boolean>();
  readonly #stop: () => void;
  #closed = false;

  constructor(deps: CanvasStatesDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => Date.now());
    this.#stop = deps.documents.subscribe((commit) => {
      this.#committed(commit);
    });
  }

  /** Hears the canvases change. Returns what stops it hearing them. */
  listen(listener: StatesListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Whether the core keeps `canvas`: canvas memory does, or its document is loaded. */
  keeps(canvas: CanvasId): boolean {
    return this.#deps.documents.loaded(canvas) !== undefined || this.#deps.memory.keeps(canvas);
  }

  /**
   * The canvas's entities as they are now, following it from now on: its document loaded (from its
   * rows, else read from its file). Not-found for a canvas the core doesn't keep; rejects, saying
   * why, if its document can't be read.
   */
  async read(canvas: CanvasId): Promise<Read> {
    if (!this.keeps(canvas)) throw new OpFailure('not-found', `There is no canvas ${canvas}.`);
    await this.#follow(canvas);
    return this.now(canvas);
  }

  /**
   * A followed canvas's entities as they are now (`read` follows it): at once, so that nothing
   * committed comes between them and what is said of the next commit.
   */
  now(canvas: CanvasId): Read {
    const feed = this.#feeds.get(canvas);
    if (feed === undefined) throw new Error('That canvas isn’t followed.');
    const live = this.#deps.documents.live(canvas);
    const entities: Record<EntityKey, Entity> = {};
    for (const [key, row] of Object.entries(live.rows)) {
      entities[key] =
        key === META
          ? feed.meta
          : entityOf(feed, key, row, live.revs.get(key) ?? 0, live.bys.get(key) ?? 'corrallm');
    }
    return { rev: live.rev, entities, document: live.document };
  }

  /**
   * Every canvas the core keeps that is worth listing, the one used most recently first: one with a
   * file, a folder or a document kept in rows, or one open or shown in a window (not a draft never
   * shown that holds nothing).
   */
  async list(): Promise<Listed[]> {
    const { memory, store, shownIn, running } = this.#deps;
    const kept = await memory.list();
    const rows = new Set(
      store
        .prepare('SELECT canvas_id FROM document')
        .all()
        .map(({ canvas_id: id }) => String(id)),
    );
    const open = new Set([
      ...store
        .prepare('SELECT canvas_id FROM open_canvas')
        .all()
        .map(({ canvas_id: id }) => String(id)),
      ...running(),
    ]);
    const runs = this.#running();
    const items: Listed[] = [];
    for (const { canvas, file, project } of kept) {
      const shown = shownIn(canvas);
      const listed =
        file !== undefined ||
        project !== undefined ||
        rows.has(canvas) ||
        open.has(canvas) ||
        shown.length > 0;
      if (!listed) continue;
      items.push({
        canvas,
        name: file === undefined ? null : path.basename(file),
        edited: rows.has(canvas) ? await this.#edited(canvas) : false,
        running: this.#deps.live?.(canvas) ?? runs.get(canvas) ?? false,
        open: open.has(canvas) || shown.length > 0,
        project: project === undefined ? null : projectOf(project),
        shownIn: shown,
      });
    }
    return items;
  }

  /**
   * What canvas memory keeps of `canvas` changed (its file, its folder), or its file was saved: its
   * meta is said again, as it is now, if it is followed. The list may have changed too.
   */
  async refresh(canvas: CanvasId): Promise<void> {
    this.listChanged();
    const feed = await (this.#following.get(canvas) ?? this.#feeds.get(canvas));
    if (feed === undefined || this.#closed) return;
    const { name, project } = await this.#kept(canvas);
    await this.#deps.documents.between(canvas, () => {
      if (this.#closed) return;
      this.#settle(canvas, feed, { name, project, edited: this.#deps.documents.edited(canvas) });
    });
  }

  /** The list of canvases may have changed. */
  listChanged(): void {
    if (this.#closed) return;
    for (const listener of this.#listeners) listener.list?.();
  }

  /** The journal wrote this canvas: its timestamp can equal the preceding save's. */
  runChanged(canvas: CanvasId): void {
    this.#runs.delete(canvas);
    this.listChanged();
  }

  close(): void {
    this.#closed = true;
    this.#stop();
    for (const feed of this.#feeds.values()) clearTimeout(feed.timer);
    this.#listeners.clear();
  }

  /** Follows `canvas`, loading its document: once, however many ask. */
  #follow(canvas: CanvasId): Promise<Feed> {
    const followed = this.#feeds.get(canvas);
    if (followed !== undefined) return Promise.resolve(followed);
    let following = this.#following.get(canvas);
    if (following === undefined) {
      following = (async () => {
        const { documents } = this.#deps;
        await documents.load(canvas);
        const { name, project } = await this.#kept(canvas);
        // Between commits, so that its meta is the document's as its first change is said.
        return documents.between(canvas, () => {
          const live = documents.live(canvas);
          const feed: Feed = {
            meta: {
              arrange: (live.rows[META] as MetaRow).arrange,
              name,
              edited: documents.edited(canvas),
              project,
              rev: live.revs.get(META) ?? 0,
              by: live.bys.get(META) ?? 'corrallm',
            },
            made: new Map(),
            computed: -Infinity,
            timer: undefined,
            kept: live.kept,
          };
          this.#feeds.set(canvas, feed);
          return feed;
        });
      })();
      this.#following.set(canvas, following);
      const settled = () => {
        if (this.#following.get(canvas) === following) this.#following.delete(canvas);
      };
      following.then(settled, settled);
    }
    return following;
  }

  /** A commit, as it is on disk: what it changed of a followed canvas is said, with its revision. */
  #committed({ canvas, rev, by, changed, renumbered, live }: Commit): void {
    const feed = this.#feeds.get(canvas);
    if (this.#closed) return;
    // What the list says of a canvas not followed may have changed: whether it is kept, edited.
    if (feed === undefined) {
      this.listChanged();
      return;
    }
    const set: Record<EntityKey, Entity> = {};
    const remove: EntityKey[] = [];
    // Those renumbered too: a window places what comes next among them by their places.
    for (const key of [...changed, ...renumbered]) {
      if (key === META) continue;
      const row = live.rows[key];
      if (row === undefined) {
        feed.made.delete(key);
        remove.push(key);
      } else {
        set[key] = entityOf(feed, key, row, live.revs.get(key) ?? rev, live.bys.get(key) ?? by);
      }
    }
    const arrange = (live.rows[META] as MetaRow).arrange;
    let { edited } = feed.meta;
    if (feed.timer === undefined && this.#now() - feed.computed >= EDITED_EVERY) {
      feed.computed = this.#now();
      edited = this.#deps.documents.edited(canvas);
    } else {
      this.#later(canvas, feed);
    }
    const listed = edited !== feed.meta.edited || !feed.kept;
    feed.kept = true;
    if (arrange !== feed.meta.arrange || edited !== feed.meta.edited) {
      feed.meta = { ...feed.meta, arrange, edited, rev, by };
      set[META] = feed.meta;
    }
    this.#say(canvas, { rev, by, set, ...(remove.length === 0 ? {} : { remove }) });
    // Kept from now on, or edited now: listed so.
    if (listed) this.listChanged();
  }

  /** Recomputes a followed canvas's `edited` once EDITED_EVERY ms have passed since it last was. */
  #later(canvas: CanvasId, feed: Feed): void {
    if (feed.timer !== undefined) return;
    feed.timer = setTimeout(
      () => {
        void this.#deps.documents
          .between(canvas, () => {
            feed.timer = undefined;
            if (this.#closed) return;
            feed.computed = this.#now();
            this.#settle(canvas, feed, { edited: this.#deps.documents.edited(canvas) });
          })
          .catch((error: unknown) => {
            console.error('Could not tell whether the canvas is edited:', error);
          });
      },
      Math.max(0, feed.computed + EDITED_EVERY - this.#now()),
    );
  }

  /**
   * Between commits: a followed canvas's meta as `next` says it is now. If that changes it, it takes
   * the canvas's next revision, in memory, and is said; the list may have changed too.
   */
  #settle(
    canvas: CanvasId,
    feed: Feed,
    next: Partial<Pick<MetaEntity, 'name' | 'project' | 'edited'>>,
  ): void {
    const { meta } = feed;
    const changed =
      (next.name !== undefined && next.name !== meta.name) ||
      (next.edited !== undefined && next.edited !== meta.edited) ||
      (next.project !== undefined && !sameProject(next.project, meta.project));
    if (!changed) return;
    const rev = this.#deps.documents.bump(canvas);
    feed.meta = { ...meta, ...next, rev, by: 'corrallm' };
    this.#say(canvas, { rev, by: 'corrallm', set: { [META]: feed.meta } });
    this.listChanged();
  }

  #say(canvas: CanvasId, change: CanvasChange): void {
    for (const listener of this.#listeners) listener.canvas?.(canvas, change);
  }

  /** A canvas's file's name and its folder, as canvas memory keeps them. */
  async #kept(canvas: CanvasId): Promise<{ name: string | null; project: ProjectOf | null }> {
    const { file, project } = await this.#deps.memory.get(canvas);
    return {
      name: file === undefined ? null : path.basename(file),
      project: project === undefined ? null : projectOf(project),
    };
  }

  /** Whether a canvas whose document is kept in rows is edited, as its meta says (following it). */
  async #edited(canvas: CanvasId): Promise<boolean> {
    try {
      return (await this.#follow(canvas)).meta.edited;
    } catch {
      // A document that can't be read is said so where it is opened.
      return false;
    }
  }

  /**
   * Whether each canvas's run is running, as last journaled: its saved run state's (B9 Design §7),
   * read again after every journal notification. A canvas the core runs says its live run's instead
   * (`live`).
   */
  #running(): Map<CanvasId, boolean> {
    const { store } = this.#deps;
    const running = new Map<CanvasId, boolean>();
    for (const { canvas_id: id } of store.prepare('SELECT canvas_id FROM run').all()) {
      const canvas = String(id) as CanvasId;
      const known = this.#runs.get(canvas);
      if (known !== undefined) {
        running.set(canvas, known);
        continue;
      }
      const state = store
        .prepare(
          `SELECT json_extract(state, '$.run.run.running') AS running FROM run
          WHERE canvas_id = ?`,
        )
        .get(canvas);
      const now = state?.running === 1;
      this.#runs.set(canvas, now);
      running.set(canvas, now);
    }
    return running;
  }
}

/** An entity of a followed canvas: as last made, if its row, revision and writer are the same. */
function entityOf(feed: Feed, key: EntityKey, row: Row, rev: number, by: PartyId): Entity {
  const made = feed.made.get(key);
  if (made?.row === row && made.rev === rev && made.by === by) return made.entity;
  const entity = { ...row, rev, by } as Entity;
  feed.made.set(key, { row, rev, by, entity });
  return entity;
}

/** A project folder as every caller reads it: its name and its path. */
function projectOf(folder: string): ProjectOf {
  return { name: path.basename(folder) || folder, path: folder };
}

function sameProject(one: ProjectOf | null, other: ProjectOf | null): boolean {
  return one?.path === other?.path;
}
