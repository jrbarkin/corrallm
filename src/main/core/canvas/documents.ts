import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import type { AdapterId, Catalog } from '../../../shared/adapter';
import type { CanvasId } from '../../../shared/canvas';
import { MAX_CANVAS_BYTES } from '../../../shared/canvas';
import type { CanvasDocument } from '../../../shared/model/canvas';
import { fromFile, toFile } from '../../../shared/model/file';
import type { PartyId } from '../../../shared/model/messages';
import {
  diffRows,
  entityOf,
  fromRows,
  itemKey,
  linkKey,
  META,
  nodeKey,
  rowsFault,
  toRows,
} from '../../../shared/model/rows';
import type {
  EntityKey,
  ItemRow,
  LinkRow,
  MetaRow,
  NodeRow,
  Row,
  Rows,
  RowsChange,
} from '../../../shared/model/rows';
import { editFault } from '../../../shared/model/valid';
import type { CanvasMemory } from '../../memory';
import { writeWhole } from '../../whole-file';
import { OpFailure } from '../call';
import type { TrustedPath } from '../host';
import type { Staged } from '../delivery/messages';
import type { Database } from '../store/store';
import { safeRemovals } from '../workspaces/planner';
import type { Forks, Losses, Made, Removals, WorkspacePlanner } from '../workspaces/planner';
import { changeSetOf } from './change';
import type { ChangeSet } from './change';
import { summarize } from './reviews';
import type { FileReview, FileReviews, Told } from './reviews';

/*
 * Each canvas's document as the core keeps it (B9 Design §2, §5): in its database's rows
 * (document, node, link, queue_item: src/shared/model/rows.ts), read once as the canvas loads, and
 * in memory from then on, the live document every reader reads. A canvas with no rows yet is read
 * from the file canvas memory keeps for it (`file.open`, by you), and kept in rows from then on: so
 * its edits since it was saved survive a restart, and a file changed on disk is never read over
 * them. A draft is kept once it holds something.
 *
 * An op changes a loaded document (`change`, B9 Design §3): what it builds from the live document is
 * diffed by reference against it (diffRows), refused if its rows couldn't hold it (rowsFault: they
 * would read back as another document) or, whoever made it, what it touched couldn't be a file's
 * or names what isn't there (editFault, revision R34), checked (expect, the change rules) and committed
 * write-through, past its point of no return once its write is queued: what it changed, entity by
 * entity, is written in one write of the database's lane with the revision it takes (the
 * document's next) and what it was, and the live document is the changed one only once that write
 * is on disk. A commit that fails (CommitFailed) keeps nothing of the change, and the live document
 * stays as it was, which is what the canvas's rows hold: the database keeps nothing of a write it
 * rejects, and takes back one whose log's flush failed, failing closed (store.ts: every read and
 * write, of every canvas, refused from then on with its error, until the core opens it again).
 * Commits on a canvas go one at a time, each built against what the one before left. Each entity
 * changed is stamped with the revision and the party; a row whose place alone was numbered anew
 * keeps its own. Revisions past the last REVISIONS_KEPT are trimmed every TRIM_EVERY commits, with
 * what each changed. Each agent keeps the party whose change made it one (none for one read from
 * a file), which counts a party's live agents (`created`, R11): from when its change passed its
 * checks, so that changes on two canvases checked one after the other never both pass a cap.
 * Each commit is told, once it is on disk and the live document is the changed one, to whoever
 * subscribes (`subscribe`), before anything else reads it: the canvas's topic is said from there
 * (canvas/states.ts). A change may hold more in its write (`within`: Allow's settlement of a
 * proposal and its proposer's record), told after them, or undone if the write failed. A change that isn't the document's (its meta) takes the canvas's next
 * revision in memory alone (`bump`), between its commits (`between`), so no commit takes it too.
 *
 * A canvas made by a party (canvas.create) keeps it as its creator (document.created_by), which an
 * outside token's reach reads: kept once it holds something, or when asked. Discarding a canvas's
 * edits reverts it to its file, as one change; a draft discarded is forgotten, with everything kept
 * of it. Whether a canvas not loaded has edits not saved is read from its rows (`unsaved`), so that
 * canvas memory never forgets one that has.
 *
 * The core saves its own document, as its file's text (toFile), in order: the hash of the text it
 * writes (writing_hash) committed first, then the file written whole and forced to disk, then its
 * hash committed as the file's (file_hash) and as what was saved (saved_hash), with the file canvas
 * memory keeps for the canvas. A save cut short is settled as the canvas next loads: its file's
 * bytes hashing to writing_hash were saved; any others were not. Whether a document is edited is
 * whether its text's hash is saved_hash (a draft never saved: whether it holds anything).
 *
 * A canvas's file changed on disk is never read over its document (B9 Design §5, Core Server
 * §5.10). Its file is checked in the canvas's turn as its document loads from its rows, as it is
 * opened again (`review`, `open`: a file opened), and before a save writes over it: bytes hashing
 * to file_hash are the file as the core last read or wrote it; to writing_hash, a save of its own
 * cut short once its text was there, adopted as saved; to those of a review you kept, changed from
 * the file the core has now, what you kept corrallm's canvas over. A file holding the canvas the
 * core has, or last saved, written another way, has its bytes adopted as the file's. Any other
 * raises a review for you (reviews.ts), superseding the one open, and a save over the file is
 * refused while one is open. Apply (`applyFile`) commits the canvas the file holds as one change,
 * with the bytes' hashes and the review's settlement in its write, if the bytes are still those
 * reviewed; Keep (`keepFile`) settles it, and the next save writes the canvas over the file. A file
 * that is missing or can't be read raises no review.
 */

/** How many of a canvas's revisions are kept (what they changed with them), the latest. */
const REVISIONS_KEPT = 1000;
/** How often the revisions past those are trimmed: every this many commits. */
const TRIM_EVERY = 100;
const ANOTHER = 'This canvas’s text is another canvas’s.';
const NOT_LOADED = 'This canvas’s document isn’t loaded in the core.';
const NOT_OPEN = 'That canvas isn’t open in corrallm.';
const NO_FILE_TO_REVERT =
  'This canvas has no file to go back to: its file was never saved, or isn’t there any more.';

export interface DocumentsDeps {
  /** The profile's database, which keeps the documents. */
  store: Database;
  /** What the core remembers of each canvas: its file. */
  memory: CanvasMemory;
  /** What files are read against. */
  catalog: Catalog;
  /** The adapter an agent naming none runs. */
  defaultAdapter: AdapterId;
  /** An accepted file changes the saved baseline without changing the document's rows. */
  baselineChanged?: (canvas: CanvasId) => void;
  /** The reviews of files changed on disk. Without them, no file is checked (a document's tests). */
  reviews?: Pick<FileReviews, 'open' | 'kept' | 'raiseWithin' | 'settleWithin' | 'supersedeWithin'>;
  /**
   * The workspaces' side of every commit, whatever made it (an op's change, a file's Apply, a
   * discard's revert: B9a Design §3, workspaces/planner.ts): its loss preflight before the commit's
   * point of no return, which may refuse it and reads the bases of the trees it forks, and who
   * works where within the commit's write (those trees' intents too). Without it, none (a
   * document's tests).
   */
  workspaces?: Pick<WorkspacePlanner, 'preflight' | 'within' | 'removed' | 'made'>;
  now?: () => number;
}

/** What Apply did: committed the file's canvas, at a revision; or found the file changed since. */
export type Applied = { rev: number } | { superseded: FileReview | undefined };

/** What made a revision: the op, the party that called it, and the request it carried. */
export interface Revision {
  op: string;
  by: PartyId;
  /** The party that proposed it, when you allowed its proposal. */
  proposedBy?: PartyId;
  request?: string;
}

/** What an op builds from a canvas's live document: the next one, and its result. */
export interface Built<R> {
  next: CanvasDocument;
  result: R;
  /** The agents it created as exact copies of another (spawnAgent's), new → source. */
  copies?: ReadonlyMap<string, string>;
}

/** A change an op makes to a canvas's document. */
export interface Change<R> {
  revision: Revision;
  /** The next document, and the op's result, built purely from the live one. */
  build(document: CanvasDocument): Built<R>;
  /**
   * Refuses what it changes by throwing, before anything is written: expect, the change rules, the
   * workspaces' confirmation (B9a C7: what its loss preflight found of the trees it leaves with no
   * agent, `losses`). Says what is decided of those trees: removed, or kept (none: kept).
   */
  check(change: ChangeSet, live: LiveDocument, losses?: Losses): Removals | undefined;
  /** Said once it is past its point of no return: as its write is queued. */
  committing(): void;
  /**
   * Within its write, after its rows: what else that write holds (B9 Design §3: a proposal's
   * settlement and the record its proposer gets, with Allow's change), so that all of it is on disk
   * or none. Told once the commit returned and the live document is the changed one, or undone if
   * the write failed.
   */
  within?(): Staged;
}

/** What a change did: the op's result; and, if it changed anything, its revision and what changed. */
export interface Changed<R> {
  result: R;
  committed?: { rev: number; change: ChangeSet };
}

/**
 * A change's write failed, so nothing of it was kept: the live document is as it was. A retry may
 * succeed, unless the database failed closed (a flush of its log failed), whose error, which this
 * one ends with, says it keeps nothing more until the core opens it again. (Had it failed to take
 * that write back, it said on stderr that the write may come back after a restart: in doubt, as in
 * PostgreSQL and SQLite.)
 */
export class CommitFailed extends Error {
  constructor(cause: unknown) {
    super(
      `The change couldn’t be written, so nothing changed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = 'CommitFailed';
  }
}

/** A change's new agents on their way to disk: its party's, on its canvas, how many. */
interface Creating {
  by: PartyId;
  canvas: CanvasId;
  count: number;
}

/** A canvas's document as the core has it now. */
export interface LiveDocument {
  readonly document: CanvasDocument;
  /** Its revision: the last given. */
  readonly rev: number;
  /** Its rows, as written. */
  readonly rows: Rows;
  /** The revision each entity took last, as far as it is known. */
  readonly revs: ReadonlyMap<EntityKey, number>;
  /** The party that wrote each entity last, as far as it is known. */
  readonly bys: ReadonlyMap<EntityKey, PartyId>;
  /** Whether it is kept: in rows, or read from a file. Not a draft that never held anything. */
  readonly kept: boolean;
}

/**
 * A commit, as those who hear it are told once it is on disk and the live document is the changed
 * one: the revision it took, the party that made it, the entities it changed (added, removed,
 * moved, or changed in more than their place) and those whose place alone was numbered anew.
 */
export interface Commit {
  canvas: CanvasId;
  rev: number;
  by: PartyId;
  changed: readonly EntityKey[];
  renumbered: readonly EntityKey[];
  live: LiveDocument;
}

interface Live extends LiveDocument {
  document: CanvasDocument;
  rev: number;
  rows: Record<EntityKey, Row>;
  revs: Map<EntityKey, number>;
  bys: Map<EntityKey, PartyId>;
  kept: boolean;
  /** The party that created each agent, by its id: none for one read from a file. */
  creators: Map<string, PartyId>;
  /** The party that made the canvas (canvas.create): none for one opened or begun otherwise. */
  createdBy: PartyId | undefined;
  /** The SHA-256 of its text as last saved or read. */
  savedHash: string | undefined;
  /** Of its file's bytes as last read or written. */
  fileHash: string | undefined;
  /** Of the text a save is writing, until its file is written. */
  writingHash: string | undefined;
}

export class Documents {
  readonly #deps: DocumentsDeps;
  readonly #now: () => number;
  readonly #lives = new Map<CanvasId, Live>();
  /** What each canvas's document is doing: its loads, commits and saves, one at a time. */
  readonly #busy = new Map<CanvasId, Promise<void>>();
  /** Saves may choose the same file, even on different canvases: publish each file with its owner. */
  #saving: Promise<void> = Promise.resolve();
  /** Each document's text, and its hash, as toFile writes it. */
  readonly #texts = new WeakMap<CanvasDocument, { text: string; hash: string }>();
  /** The new agents of changes past their checks whose rows don't hold them yet. */
  readonly #creating = new Set<Creating>();
  /** What hears each commit. */
  readonly #listeners = new Set<(commit: Commit) => void>();
  /**
   * Whether each canvas not loaded has edits not saved, as its rows said when canvas memory last
   * asked: they change only once it is loaded.
   */
  readonly #unsaved = new Map<CanvasId, boolean>();

  constructor(deps: DocumentsDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => Date.now());
  }

  /**
   * The canvas's document: from its rows, else read from the file canvas memory keeps for it (a
   * draft's is empty). Rejects, saying why, if its file isn't a canvas this corrallm reads.
   */
  load(canvas: CanvasId): Promise<LiveDocument> {
    return this.#queue(canvas, () => this.#load(canvas));
  }

  /**
   * The canvas whose file, named `name`, holds `text` was opened: its document, from its rows if it
   * has them, else read from `text` under the canvas's id (a copy's own). One kept is checked
   * against `text`, which raises a review if it isn't the file as the core last read or wrote it.
   * Rejects, saying why, if `text` isn't a canvas this corrallm reads, keeping nothing of it.
   */
  async open(canvas: CanvasId, text: string, name: string): Promise<LiveDocument> {
    const document = this.read(text);
    return this.#queue(canvas, async () => {
      const loaded = this.#lives.get(canvas);
      const live = await this.#load(canvas, { text, document, name });
      // One loaded now was checked as it loaded.
      if (loaded !== undefined) await this.#review(live, { name, text });
      return live;
    });
  }

  /**
   * The canvas opens, or its file may have changed (its folder's watch said so, a window showing it
   * gained focus): its document loaded, if it isn't, and its file checked, in its turn, against what
   * the core last read or wrote of it, which raises a review if it is none of that. Resolves with
   * its document; rejects, saying why, if it can't be loaded.
   */
  review(canvas: CanvasId): Promise<LiveDocument> {
    return this.#queue(canvas, async () => {
      const loaded = this.#lives.get(canvas);
      const live = await this.#load(canvas);
      if (loaded !== undefined) await this.#review(live);
      return live;
    });
  }

  /**
   * Applies `review` (B9 Design §5), by `by`, once what the canvas's document was doing is done:
   * its file is read again, and if its bytes are still those reviewed, the canvas it holds is
   * committed as one change (`file.apply`), the bytes' hashes as its file's and as saved and the
   * review settled applied in the same write: the revision it took. If the file changed since (or
   * went), what is there now is checked instead, which settles the review superseded: the review
   * open now, if any. Rejects, changing nothing, for a review no longer open, a file that can't be
   * read or isn't a canvas this corrallm reads, cancellation before the commit, or a write that
   * failed (CommitFailed). Once committing, it is irreversible as an op's ctx.commit is.
   */
  applyFile(
    canvas: CanvasId,
    review: FileReview,
    by: PartyId,
    turn: { signal: AbortSignal; noReturn(): void },
  ): Promise<Applied> {
    return this.#queue(canvas, async () => {
      const reviews = this.#reviewing(canvas, review);
      const live = await this.#load(canvas);
      let file;
      try {
        file = await this.#file(canvas);
      } catch (error) {
        throw new OpFailure(
          'unavailable',
          `${review.summary.file} can’t be read: ${reasonOf(error)}`,
        );
      }
      turn.signal.throwIfAborted();
      if (file === undefined) {
        // Gone: nothing is there to apply.
        turn.noReturn();
        const told = await this.#writeAlone(() => reviews.supersedeWithin(canvas));
        told?.();
        return { superseded: undefined };
      }
      if (sha256(file.text) !== review.hash) {
        turn.noReturn();
        return { superseded: await this.#review(live, file) };
      }
      let next: CanvasDocument;
      try {
        next = { ...this.read(file.text), id: canvas };
      } catch (error) {
        throw new OpFailure(
          'invalid',
          `${review.summary.file} isn’t a canvas this corrallm reads: ${reasonOf(error)}`,
        );
      }
      // Apply bypasses no workspace: its loss preflight runs as an op's change's does. What it
      // leaves with no agent is kept, unless safe to remove (B9a C7: a file's Apply asks nothing
      // more of it; the trees it keeps are in the Kept worktrees).
      const losses = await this.#deps.workspaces?.preflight({
        canvas,
        before: live.document,
        after: next,
      });
      const removals = safeRemovals(losses);
      turn.noReturn();
      const rev = await this.#commit(
        live,
        next,
        diffRows(live.rows, next, live.document),
        { op: 'file.apply', by },
        {
          hashes: { saved: this.#text(next).hash, file: review.hash },
          within: () => staged(reviews.settleWithin(review, 'applied', by)),
          removals,
          forks: losses?.forks,
        },
      );
      this.#deps.workspaces?.removed(removals);
      return { rev };
    });
  }

  /**
   * Keeps the canvas's document over `review`'s file (B9 Design §5), by `by`, once what its
   * document was doing is done: the review settled kept, on disk once it resolves; the canvas's next
   * save writes it over the file. Rejects for a review no longer open.
   */
  keepFile(canvas: CanvasId, review: FileReview, by: PartyId): Promise<void> {
    return this.#queue(canvas, async () => {
      const reviews = this.#reviewing(canvas, review);
      const told = await this.#writeAlone(() => reviews.settleWithin(review, 'kept', by));
      told?.();
    });
  }

  /** The canvas's document, loaded. Throws if it isn't. */
  live(canvas: CanvasId): LiveDocument {
    const live = this.#lives.get(canvas);
    if (live === undefined) throw new Error(NOT_LOADED);
    return live;
  }

  /** The canvas's document, if it is loaded. */
  loaded(canvas: CanvasId): LiveDocument | undefined {
    return this.#lives.get(canvas);
  }

  /** Whether the canvas's document is kept in rows. */
  hasRows(canvas: CanvasId): boolean {
    return (
      this.#deps.store.prepare('SELECT 1 AS kept FROM document WHERE canvas_id = ?').get(canvas) !==
      undefined
    );
  }

  /**
   * Hears each commit, once it is on disk and the live document is the changed one (B9 Design §3:
   * the topics publish from the commit path): synchronously, before anything else reads it. Returns
   * what stops it hearing them.
   */
  subscribe(listener: (commit: Commit) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Runs `task` between the canvas's commits: once what its document was doing (loads, commits,
   * saves) is done, before what is asked of it after. Resolves with what it returned.
   */
  between<T>(canvas: CanvasId, task: () => T): Promise<T> {
    return this.#queue(canvas, () => Promise.resolve(task()));
  }

  /**
   * The canvas's next revision, given to a change that isn't the document's (B9 Design §7: its meta,
   * a folder chosen or `edited` flipping) in memory only: the next commit takes the one after it.
   * Only between its commits (`between`), so that no commit going on takes it too.
   */
  bump(canvas: CanvasId): number {
    const live = this.#lives.get(canvas);
    if (live === undefined) throw new Error(NOT_LOADED);
    live.rev += 1;
    return live.rev;
  }

  /** Whether the canvas's document differs from its text as last saved or read. */
  edited(canvas: CanvasId): boolean {
    const live = this.#lives.get(canvas);
    return live !== undefined && this.#edited(live);
  }

  /**
   * Whether the canvas's document has edits not saved, loaded or not: what canvas memory never
   * forgets (B9 Design §2). Synchronous, so that it is asked within a write: one not loaded is read
   * from its rows, once. One whose rows can't be read is said to have them: forgetting it would lose
   * what can't be told.
   */
  unsaved(canvas: CanvasId): boolean {
    const live = this.#lives.get(canvas);
    if (live !== undefined) return this.#edited(live);
    // Losing a file invalidates a cached clean result even when this document is not loaded.
    if (this.#deps.memory.fileOf(canvas) === undefined) {
      try {
        return (this.#read(canvas)?.document.nodes.length ?? 0) > 0;
      } catch {
        return true;
      }
    }
    let known = this.#unsaved.get(canvas);
    if (known === undefined) {
      try {
        const kept = this.#read(canvas);
        known = kept !== undefined && this.#edited(kept);
      } catch {
        known = true;
      }
      this.#unsaved.set(canvas, known);
    }
    return known;
  }

  /**
   * Makes canvas `canvas` (canvas.create), by `by`, its creator: its document empty, loaded, and
   * kept once it holds something (a template's agents, committed as any change is) or when asked
   * (`keep`), with its creator, which a token's reach reads. Throws for a canvas the core keeps a
   * document of already.
   */
  create(canvas: CanvasId, by: PartyId): void {
    if (this.#lives.has(canvas) || this.hasRows(canvas)) {
      throw new Error(`There is a canvas ${canvas} already.`);
    }
    this.#unsaved.delete(canvas);
    this.#lives.set(canvas, { ...emptyLive(canvas), createdBy: by });
  }

  /**
   * Keeps the canvas's document in rows now, though it holds nothing (a canvas a token made: its
   * creator with it). On disk once it resolves. Throws if it isn't loaded.
   */
  keep(canvas: CanvasId): Promise<void> {
    return this.#queue(canvas, async () => {
      const live = this.#lives.get(canvas);
      if (live === undefined) throw new Error(NOT_LOADED);
      await this.#deps.store.write(() => {
        this.#ensure(live, live.createdBy ?? 'you');
      });
      live.kept = true;
    });
  }

  /** Drops a canvas made (`create`) and never kept: a change to it was refused. */
  drop(canvas: CanvasId): Promise<void> {
    return this.#queue(canvas, () => {
      if (this.#lives.get(canvas)?.kept === false) this.#lives.delete(canvas);
      return Promise.resolve();
    });
  }

  /** The canvases `party` made (canvas.create) that the core keeps: those its reach reads. */
  createdBy(party: PartyId): CanvasId[] {
    return this.#deps.store
      .prepare('SELECT canvas_id FROM document WHERE created_by = ? ORDER BY canvas_id')
      .all(party)
      .flatMap(({ canvas_id: id }) => (typeof id === 'string' ? [id as CanvasId] : []));
  }

  /**
   * Reverts the canvas's document to its file as it is on disk (a discard, B9 Design §5), as one
   * change by `revision`, after what it was doing: not edited once it resolves, with the revision
   * it took; none if there was nothing to revert. Rejects, changing nothing, if it has no file, or
   * its file isn't a canvas this corrallm reads.
   */
  revert(canvas: CanvasId, revision: Revision): Promise<number | undefined> {
    return this.#queue(canvas, async () => {
      const live = await this.#load(canvas);
      const file = await this.#file(canvas);
      if (file === undefined) throw new Error(NO_FILE_TO_REVERT);
      const next = { ...this.#readFile(file), id: canvas };
      const hashes = { saved: this.#text(next).hash, file: sha256(file.text) };
      const rows = diffRows(live.rows, next, live.document);
      if (
        rows.changed.length === 0 &&
        live.savedHash === hashes.saved &&
        live.fileHash === hashes.file &&
        live.writingHash === undefined
      ) {
        return undefined;
      }
      // A discard bypasses no workspace: its loss preflight runs as an op's change's does, and
      // keeps what it leaves with no agent unless that is safe to remove, as Apply does.
      const losses = await this.#deps.workspaces?.preflight({
        canvas,
        before: live.document,
        after: next,
      });
      const removals = safeRemovals(losses);
      // Back to its file as it is: a review open of it is moot.
      const { reviews } = this.#deps;
      const rev = await this.#commit(live, next, rows, revision, {
        hashes,
        ...(reviews === undefined ? {} : { within: () => staged(reviews.supersedeWithin(canvas)) }),
        removals,
        forks: losses?.forks,
      });
      this.#deps.workspaces?.removed(removals);
      return rev;
    });
  }

  /**
   * Forgets the canvas, a draft discarded (B9 Design §5): its document, and everything the profile
   * keeps of it (canvas memory's `forget`), unless it owns a workspace record, which keeps all of
   * it. Resolves with whether it forgot it, once that is on disk; rejects, forgetting nothing, if
   * it couldn't be written.
   */
  forget(canvas: CanvasId): Promise<boolean> {
    return this.#queue(canvas, async () => {
      const forgot = await this.#deps.memory.forget(canvas);
      if (forgot) {
        this.#lives.delete(canvas);
        this.#unsaved.delete(canvas);
      }
      return forgot;
    });
  }

  /**
   * How many live agents `party` created (R11): on `canvas`, or on every canvas the core keeps,
   * those of changes past their checks on their way to disk included.
   */
  created(
    party: PartyId,
    canvas?: CanvasId,
    removing?: Pick<ChangeSet, 'canvas' | 'removed'>,
  ): number {
    const { store } = this.#deps;
    const kept =
      canvas === undefined
        ? store
            .prepare(`SELECT count(*) AS n FROM node WHERE created_by = ? AND kind = 'agent'`)
            .get(party)
        : store
            .prepare(
              `SELECT count(*) AS n FROM node
               WHERE created_by = ? AND kind = 'agent' AND canvas_id = ?`,
            )
            .get(party, canvas);
    let count = Number(kept?.n ?? 0);
    if (
      removing !== undefined &&
      removing.removed.size > 0 &&
      (canvas === undefined || canvas === removing.canvas)
    ) {
      // Only this party's rows on the changed canvas count as removals: ids may repeat elsewhere.
      const owned = store
        .prepare(`SELECT id FROM node WHERE created_by = ? AND kind = 'agent' AND canvas_id = ?`)
        .all(party, removing.canvas);
      count -= owned.filter((row) => removing.removed.has(String(row.id))).length;
    }
    for (const one of this.#creating) {
      if (one.by === party && (canvas === undefined || one.canvas === canvas)) count += one.count;
    }
    return count;
  }

  /** A canvas file's text as a document, read against the catalog. Throws, saying why. */
  read(text: string): CanvasDocument {
    return fromFile(text, this.#deps.catalog, this.#deps.defaultAdapter);
  }

  /**
   * Makes `change` to the canvas's document, which must be loaded: once what the canvas's document
   * was doing is done, builds it over the live document, and if that changes anything, checks it,
   * says it is committing and commits it. Resolves once it is on disk, with what it did; rejects,
   * leaving the document as it was, if it was refused, or couldn't be written (CommitFailed).
   */
  change<R>(canvas: CanvasId, change: Change<R>): Promise<Changed<R>> {
    return this.#queue(canvas, async () => {
      const live = this.#lives.get(canvas);
      if (live === undefined) throw new Error(NOT_OPEN);
      const { next, result, copies } = change.build(live.document);
      if (next.id !== canvas) throw new Error(ANOTHER);
      const rows = diffRows(live.rows, next, live.document);
      if (rows.changed.length === 0) return { result };
      const fault = rowsFault(next);
      if (fault !== undefined)
        throw new OpFailure('invalid', `That change can’t be kept: ${fault}.`);
      const set = changeSetOf(live, next, rows, change.revision, copies);
      // Whoever makes it (revision R34): what a file would hold, and names what is there.
      const invalid = editFault(next, set.entities, this.#deps.catalog, this.#deps.defaultAdapter);
      if (invalid !== undefined) throw new OpFailure('invalid', invalid);
      // The workspaces' loss preflight, before the checks (nothing awaited between them and the
      // commit, so a cap a change passed is counted from then on).
      const losses = await this.#deps.workspaces?.preflight({
        canvas,
        before: live.document,
        after: next,
        copies,
      });
      const removals = change.check(set, live, losses);
      const creating = { by: change.revision.by, canvas, count: set.created.size };
      this.#creating.add(creating);
      try {
        change.committing();
        const rev = await this.#commit(live, next, rows, change.revision, {
          creator: change.revision.by,
          creating,
          ...(copies === undefined ? {} : { copies }),
          ...(change.within === undefined ? {} : { within: () => change.within?.() }),
          ...(removals === undefined ? {} : { removals }),
          forks: losses?.forks,
        });
        this.#deps.workspaces?.removed(removals);
        return { result, committed: { rev, change: set } };
      } finally {
        this.#creating.delete(creating);
      }
    });
  }

  /**
   * Saves the canvas's document to `file`, which becomes its file (canvas memory's), in order: the
   * hash of its text committed as being written, the file written whole and on disk, then its hash
   * committed as the file's and as saved. Over its own file, the file is checked first, and the save
   * refused while a review of it is open (B9 Design §5); to another, a review of the one it had is
   * moot once it is saved. Rejects if it couldn't be.
   */
  save(canvas: CanvasId, file: TrustedPath): Promise<void> {
    return this.#queue(canvas, () => {
      const saving = this.#saving.then(async () => {
        const loaded = this.#lives.get(canvas);
        const live = await this.#load(canvas);
        const { store, memory, reviews } = this.#deps;
        if (reviews !== undefined && (await sameFile(memory.fileOf(canvas), file))) {
          // One loaded now was checked as it loaded.
          const open = loaded === undefined ? reviews.open(canvas) : await this.#review(live);
          if (open !== undefined) throw new OpFailure('refused', saveRefusal(open));
        }
        const { text, hash } = this.#text(live.document);
        await store.write(() => {
          this.#ensure(live, 'you');
          store
            .prepare('UPDATE document SET writing_hash = ? WHERE canvas_id = ?')
            .run(hash, canvas);
        });
        live.kept = true;
        live.writingHash = hash;
        await writeWhole(file, text, { durable: true });
        // The chosen path and hashes are one savepoint, so neither can succeed alone.
        let told: Told | undefined;
        await memory.setFile(canvas, file, () => {
          store
            .prepare(
              `UPDATE document SET saved_hash = ?, file_hash = ?, writing_hash = NULL,
                 file_generation = file_generation + 1 WHERE canvas_id = ?`,
            )
            .run(hash, hash, canvas);
          // The file is corrallm's now: a review of the one it had (Save As) is moot.
          told = reviews?.supersedeWithin(canvas);
        });
        live.savedHash = hash;
        live.fileHash = hash;
        live.writingHash = undefined;
        told?.();
      });
      this.#saving = saving.catch(() => undefined);
      return saving;
    });
  }

  /** Runs `task` once what the canvas's document was doing is done, failed or not. */
  #queue<T>(canvas: CanvasId, task: () => Promise<T>): Promise<T> {
    const before = this.#busy.get(canvas) ?? Promise.resolve();
    const run = before.then(task);
    const done = run.then(
      () => undefined,
      () => undefined,
    );
    this.#busy.set(canvas, done);
    void done.then(() => {
      if (this.#busy.get(canvas) === done) this.#busy.delete(canvas);
    });
    return run;
  }

  /**
   * The canvas's document, loaded once: from its rows (a save cut short settled by its file's
   * bytes, those `opened` holds if it was just opened, and its file checked against them), else
   * from `opened`'s text or its file's, read under its id and kept in rows, else a draft's, empty.
   */
  async #load(
    canvas: CanvasId,
    opened?: { text: string; document: CanvasDocument; name: string },
  ): Promise<Live> {
    const loaded = this.#lives.get(canvas);
    if (loaded !== undefined) return loaded;
    this.#unsaved.delete(canvas);
    const kept = this.#read(canvas);
    if (kept !== undefined) {
      this.#lives.set(canvas, kept);
      if (kept.writingHash !== undefined) await this.#settle(canvas, kept, opened?.text);
      await this.#review(kept, opened && { name: opened.name, text: opened.text });
      return kept;
    }
    let text = opened?.text;
    let document = opened?.document;
    if (text === undefined) {
      const file = await this.#file(canvas);
      text = file?.text;
      if (file !== undefined) document = this.#readFile(file);
    }
    const live = emptyLive(canvas);
    if (text === undefined || document === undefined) {
      this.#lives.set(canvas, live);
      return live;
    }
    // Read from its file: kept in rows from now on, under its own id, its hashes with them.
    const read = { ...document, id: canvas };
    const hashes = { saved: this.#text(read).hash, file: sha256(text) };
    await this.#commit(
      live,
      read,
      diffRows(live.rows, read),
      { op: 'file.open', by: 'you' },
      { hashes },
    );
    this.#lives.set(canvas, live);
    return live;
  }

  /** The canvas's document as its rows keep it, if they do. */
  #read(canvas: CanvasId): Live | undefined {
    const { store } = this.#deps;
    const head = store
      .prepare(
        `SELECT rev, arrange, saved_hash, file_hash, writing_hash, created_by FROM document
         WHERE canvas_id = ?`,
      )
      .get(canvas);
    if (head === undefined) return undefined;
    const rows: Record<EntityKey, Row> = { [META]: { arrange: head.arrange === 1 } };
    const revs = new Map<EntityKey, number>();
    const bys = new Map<EntityKey, PartyId>();
    const creators = new Map<string, PartyId>();
    const keep = (key: EntityKey, row: Row, rev: unknown, by: unknown) => {
      rows[key] = row;
      revs.set(key, Number(rev));
      if (typeof by === 'string') bys.set(key, by as PartyId);
    };
    for (const node of store
      .prepare(
        `SELECT id, kind, parent_id, place, label, x, y, color, adapter, connection, settings, role,
           created_by, rev, by_party FROM node WHERE canvas_id = ? ORDER BY place`,
      )
      .all(canvas)) {
      const id = String(node.id);
      if (typeof node.created_by === 'string') creators.set(id, node.created_by as PartyId);
      const row = present({
        id,
        kind: node.kind,
        parent: node.parent_id,
        place: node.place,
        label: node.label,
        x: node.x,
        y: node.y,
        color: node.color,
        adapter: node.adapter,
        connection: node.connection,
        settings: parsed(node.settings),
        role: node.role,
      }) as NodeRow;
      keep(nodeKey(id), row, node.rev, node.by_party);
    }
    for (const link of store
      .prepare(
        'SELECT a, b, source, dots, place, rev, by_party FROM link WHERE canvas_id = ? ORDER BY place',
      )
      .all(canvas)) {
      const row = present({
        a: link.a,
        b: link.b,
        source: link.source,
        dots: parsed(link.dots),
        place: link.place,
      }) as LinkRow;
      keep(linkKey(row.a, row.b), row, link.rev, link.by_party);
    }
    for (const item of store
      .prepare(
        `SELECT agent_id, id, container, place, kind, body, rev, by_party FROM queue_item
         WHERE canvas_id = ? ORDER BY place`,
      )
      .all(canvas)) {
      const row = present({
        agent: item.agent_id,
        id: item.id,
        container: item.container,
        place: item.place,
        kind: item.kind,
        body: parsed(item.body),
      }) as ItemRow;
      keep(itemKey(row.agent, row.id), row, item.rev, item.by_party);
    }
    const document = fromRows(canvas, rows);
    return {
      document,
      rev: Number(head.rev),
      // In the document's order, each in its place.
      rows: toRows(document, rows),
      revs,
      bys,
      kept: true,
      creators,
      createdBy: text(head.created_by) as PartyId | undefined,
      savedHash: text(head.saved_hash),
      fileHash: text(head.file_hash),
      writingHash: text(head.writing_hash),
    };
  }

  /**
   * Settles a save cut short: its file's bytes (those just read, else read now) hashing to the
   * text it was writing were saved; any others were not, and the file is as it was.
   */
  async #settle(canvas: CanvasId, live: Live, read: string | undefined): Promise<void> {
    const bytes = read ?? (await this.#file(canvas))?.text;
    const written = bytes !== undefined && sha256(bytes) === live.writingHash;
    const { store } = this.#deps;
    await store.write(() => {
      if (written) {
        store
          .prepare(
            `UPDATE document SET saved_hash = writing_hash, file_hash = writing_hash,
               writing_hash = NULL, file_generation = file_generation + 1 WHERE canvas_id = ?`,
          )
          .run(canvas);
      } else {
        store.prepare('UPDATE document SET writing_hash = NULL WHERE canvas_id = ?').run(canvas);
      }
    });
    if (written) {
      live.savedHash = live.writingHash;
      live.fileHash = live.writingHash;
    }
    live.writingHash = undefined;
  }

  /**
   * Checks the canvas's file (`read`, just read, else read now) against what the core last read or
   * wrote of it, in the canvas's turn (B9 Design §5): the review open on it after, if any. Bytes as
   * a review open has them change nothing. A save of its own cut short once its text was there is
   * saved; bytes as the core has them, or as you kept them over the file it has now, settle the
   * review open superseded, moot; so does a file holding the canvas the core has, or last saved,
   * written another way, whose bytes are the file's from then on. Any other raises a review,
   * superseding the one open. A file that is gone or can't be read checks nothing, nor does a draft.
   */
  async #review(
    live: Live,
    read?: { name: string; text: string },
  ): Promise<FileReview | undefined> {
    const { reviews, store } = this.#deps;
    const canvas = live.document.id;
    if (reviews === undefined || !live.kept) return undefined;
    let file = read;
    if (file === undefined) {
      try {
        file = await this.#file(canvas);
      } catch {
        // Checked again once it can be read (a watch, a window's focus, a save).
        return reviews.open(canvas);
      }
      if (file === undefined) return reviews.open(canvas);
    }
    const hash = sha256(file.text);
    const open = reviews.open(canvas);
    if (open?.hash === hash) return open;
    if (live.writingHash !== undefined) await this.#settle(canvas, live, file.text);
    if (hash === live.fileHash || reviews.kept(canvas, hash, live.fileHash)) {
      if (open !== undefined) (await this.#writeAlone(() => reviews.supersedeWithin(canvas)))?.();
      return undefined;
    }
    let next: CanvasDocument | { fault: string };
    try {
      next = { ...this.read(file.text), id: canvas };
    } catch (error) {
      next = { fault: reasonOf(error) };
    }
    if (!('fault' in next)) {
      const text = this.#text(next).hash;
      if (text === this.#text(live.document).hash || text === live.savedHash) {
        // Written another way: nothing to review, and these bytes are the file's from now on.
        const saved = text === this.#text(live.document).hash ? text : live.savedHash;
        const told = await this.#writeAlone(() => {
          store
            .prepare('UPDATE document SET file_hash = ?, saved_hash = ? WHERE canvas_id = ?')
            .run(hash, saved ?? null, canvas);
          return reviews.supersedeWithin(canvas);
        });
        live.fileHash = hash;
        const changed = live.savedHash !== saved;
        live.savedHash = saved;
        told?.();
        if (changed) this.#deps.baselineChanged?.(canvas);
        return undefined;
      }
    }
    const summary = summarize(file.name, live.fileHash, live, next);
    (await this.#writeAlone(() => reviews.raiseWithin(canvas, hash, summary)))?.();
    return reviews.open(canvas);
  }

  /** The reviews, while `review` is open on the canvas: else it was settled, a conflict. */
  #reviewing(canvas: CanvasId, review: FileReview): NonNullable<DocumentsDeps['reviews']> {
    const { reviews } = this.#deps;
    if (reviews === undefined || reviews.open(canvas)?.id !== review.id) {
      throw new OpFailure('conflict', `${review.id} is settled already.`);
    }
    return reviews;
  }

  /** Writes what `within` does in a write of its own: what tells of it, once it is on disk. */
  async #writeAlone(within: () => Told | undefined): Promise<Told | undefined> {
    let told: Told | undefined;
    await this.#deps.store.write(() => {
      told = within();
    });
    return told;
  }

  /**
   * Commits `next` over `live`, by what it changes of it (`change`): in one write, at the next
   * revision; `live` is `next` once it is on disk. With `hashes`, its text's and its file's as read
   * from it; with `creator`, the party that created the agents it makes (none: they are read from
   * a file), whose count `creating` holds until their rows do; with `within`, what else its write
   * holds (told once it is on disk, after those who hear commits); the workspaces' records of it,
   * whatever made it (`copies`: the new agents copied from another; `forks`: the bases its
   * preflight read for the trees it forks, whose jobs run once it is on disk). Throws CommitFailed,
   * leaving `live` as it was (and undoing what `within` staged), if the write failed.
   */
  async #commit(
    live: Live,
    next: CanvasDocument,
    { rows, changed, renumbered }: RowsChange,
    revision: Revision,
    {
      hashes,
      creator,
      creating,
      copies,
      within,
      removals,
      forks,
    }: {
      hashes?: { saved: string; file: string };
      creator?: PartyId;
      creating?: Creating;
      copies?: ReadonlyMap<string, string>;
      within?: () => Staged | undefined;
      /** What is decided of the trees it leaves with no agent (B9a C7): removed, as said. */
      removals?: Removals;
      /** The bases of the trees it forks, as its preflight read them (B9a Design §3). */
      forks?: Forks | undefined;
    } = {},
  ): Promise<number> {
    if (changed.length === 0 && hashes === undefined) return live.rev;
    const rev = live.rev + 1;
    const at = this.#now();
    const creators = creatorsAfter(live, rows, changed, creator);
    let staged: Staged | undefined;
    let made: Made | undefined;
    try {
      await this.#deps.store.write(() => {
        this.#write(live, { rows, changed, renumbered, rev, at, revision, creators });
        // Its rows hold them now: counted there.
        if (creating !== undefined) this.#creating.delete(creating);
        if (hashes !== undefined) {
          this.#deps.store
            .prepare(
              'UPDATE document SET saved_hash = ?, file_hash = ?, writing_hash = NULL WHERE canvas_id = ?',
            )
            .run(hashes.saved, hashes.file, next.id);
        }
        // Who works where, in the same write (B9a Design §3): on disk with the document, or neither.
        made = this.#deps.workspaces?.within(
          { canvas: next.id, before: live.document, after: next, copies, forks },
          removals,
        );
        // Last, so that nothing after it fails the write once it has staged what it holds.
        staged = within?.();
      });
    } catch (error) {
      staged?.undo();
      throw new CommitFailed(error);
    }
    live.document = next;
    live.rows = rows;
    for (const key of changed) {
      if (Object.hasOwn(rows, key)) {
        live.revs.set(key, rev);
        live.bys.set(key, revision.by);
      } else {
        live.revs.delete(key);
        live.bys.delete(key);
      }
    }
    live.rev = rev;
    live.kept = true;
    live.creators = creators;
    if (hashes !== undefined) {
      live.savedHash = hashes.saved;
      live.fileHash = hashes.file;
      live.writingHash = undefined;
    }
    const commit = { canvas: next.id, rev, by: revision.by, changed, renumbered, live };
    for (const listener of this.#listeners) {
      try {
        listener(commit);
      } catch (error) {
        // What hears a commit never undoes it.
        console.error('Could not tell of a commit:', error);
      }
    }
    staged?.reveal();
    // The trees it forks, made now that their intents are on disk (in the background).
    this.#deps.workspaces?.made(made);
    return rev;
  }

  /**
   * Within a write: the document's change. What stays or comes is written in its order (a node
   * after what holds it, an item after the if-then or repeat holding it), what goes in the reverse
   * of its order before (an item before what holds it, a node before its parent), so every
   * reference holds as each statement ends.
   */
  #write(
    live: Live,
    change: {
      rows: Record<EntityKey, Row>;
      changed: readonly EntityKey[];
      renumbered: readonly EntityKey[];
      rev: number;
      at: number;
      revision: Revision;
      creators: ReadonlyMap<string, PartyId>;
    },
  ): void {
    const { store } = this.#deps;
    const canvas = live.document.id;
    const { rows, rev, at, revision, creators } = change;
    const by = revision.by;
    this.#ensure(live, by);
    store
      .prepare(
        `INSERT INTO document (canvas_id, rev, arrange, by_party, changed_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (canvas_id) DO UPDATE SET rev = excluded.rev, arrange = excluded.arrange,
           by_party = excluded.by_party, changed_at = excluded.changed_at`,
      )
      .run(canvas, rev, (rows[META] as MetaRow).arrange ? 1 : 0, by, at);
    store
      .prepare(
        `INSERT INTO revision (canvas_id, rev, op, by_party, proposed_by, request, at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(canvas, rev, revision.op, by, revision.proposedBy ?? null, revision.request ?? null, at);
    const changed = new Set(change.changed);
    const renumbered = new Set(change.renumbered);
    for (const [key, row] of Object.entries(rows)) {
      if (changed.has(key)) this.#upsert(canvas, key, row, rev, by, creators);
      else if (renumbered.has(key)) this.#replace(canvas, key, row);
    }
    for (const key of Object.keys(live.rows).reverse()) {
      const row = live.rows[key];
      if (!Object.hasOwn(rows, key) && row !== undefined) this.#remove(canvas, key, row);
    }
    const record = store.prepare(
      `INSERT INTO change (canvas_id, rev, entity, rev_before, before_data, after_data)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const key of change.changed) {
      const before = live.rows[key];
      const after = rows[key];
      record.run(
        canvas,
        rev,
        key,
        live.revs.get(key) ?? null,
        before === undefined ? null : JSON.stringify(before),
        after === undefined ? null : JSON.stringify(after),
      );
    }
    if (rev % TRIM_EVERY === 0) {
      store
        .prepare('DELETE FROM revision WHERE canvas_id = ? AND rev <= ?')
        .run(canvas, rev - REVISIONS_KEPT);
    }
  }

  /**
   * Within a write: the entity's row as `row` is, at revision `rev`, by `by`; a node's with the
   * party that created it, as `creators` says.
   */
  #upsert(
    canvas: CanvasId,
    key: EntityKey,
    row: Row,
    rev: number,
    by: PartyId,
    creators: ReadonlyMap<string, PartyId>,
  ): void {
    const { store } = this.#deps;
    switch (entityOf(key)) {
      case 'meta':
        return;
      case 'node': {
        const node = row as NodeRow;
        store
          .prepare(
            `INSERT INTO node (canvas_id, id, kind, parent_id, place, label, x, y, color, adapter,
               connection, settings, role, created_by, rev, by_party)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (canvas_id, id) DO UPDATE SET kind = excluded.kind,
               parent_id = excluded.parent_id, place = excluded.place, label = excluded.label,
               x = excluded.x, y = excluded.y, color = excluded.color, adapter = excluded.adapter,
               connection = excluded.connection, settings = excluded.settings,
               role = excluded.role, created_by = excluded.created_by, rev = excluded.rev,
               by_party = excluded.by_party`,
          )
          .run(
            canvas,
            node.id,
            node.kind,
            node.parent ?? null,
            node.place,
            node.label,
            node.x,
            node.y,
            node.color ?? null,
            node.adapter ?? null,
            node.connection ?? null,
            node.settings === undefined ? null : JSON.stringify(node.settings),
            node.role ?? null,
            creators.get(node.id) ?? null,
            rev,
            by,
          );
        return;
      }
      case 'link': {
        const link = row as LinkRow;
        store
          .prepare(
            `INSERT INTO link (canvas_id, a, b, source, dots, place, rev, by_party)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (canvas_id, a, b) DO UPDATE SET source = excluded.source,
               dots = excluded.dots, place = excluded.place, rev = excluded.rev,
               by_party = excluded.by_party`,
          )
          .run(
            canvas,
            link.a,
            link.b,
            link.source,
            link.dots === undefined ? null : JSON.stringify(link.dots),
            link.place,
            rev,
            by,
          );
        return;
      }
      case 'item': {
        const item = row as ItemRow;
        store
          .prepare(
            `INSERT INTO queue_item (canvas_id, agent_id, id, container, place, kind, body, rev,
               by_party)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (canvas_id, agent_id, id) DO UPDATE SET container = excluded.container,
               place = excluded.place, kind = excluded.kind, body = excluded.body,
               rev = excluded.rev, by_party = excluded.by_party`,
          )
          .run(
            canvas,
            item.agent,
            item.id,
            item.container ?? null,
            item.place,
            item.kind,
            JSON.stringify(item.body),
            rev,
            by,
          );
      }
    }
  }

  /** Within a write: the row's place as `row`'s, the entity unchanged. */
  #replace(canvas: CanvasId, key: EntityKey, row: Row): void {
    const { store } = this.#deps;
    const entity = entityOf(key);
    if (entity === 'node') {
      const { id, place } = row as NodeRow;
      store
        .prepare('UPDATE node SET place = ? WHERE canvas_id = ? AND id = ?')
        .run(place, canvas, id);
    } else if (entity === 'link') {
      const { a, b, place } = row as LinkRow;
      store
        .prepare('UPDATE link SET place = ? WHERE canvas_id = ? AND a = ? AND b = ?')
        .run(place, canvas, a, b);
    } else if (entity === 'item') {
      const { agent, id, place } = row as ItemRow;
      store
        .prepare('UPDATE queue_item SET place = ? WHERE canvas_id = ? AND agent_id = ? AND id = ?')
        .run(place, canvas, agent, id);
    }
  }

  /** Within a write: the entity's row gone. */
  #remove(canvas: CanvasId, key: EntityKey, row: Row): void {
    const { store } = this.#deps;
    const entity = entityOf(key);
    if (entity === 'node') {
      store
        .prepare('DELETE FROM node WHERE canvas_id = ? AND id = ?')
        .run(canvas, (row as NodeRow).id);
    } else if (entity === 'link') {
      const { a, b } = row as LinkRow;
      store.prepare('DELETE FROM link WHERE canvas_id = ? AND a = ? AND b = ?').run(canvas, a, b);
    } else if (entity === 'item') {
      const { agent, id } = row as ItemRow;
      store
        .prepare('DELETE FROM queue_item WHERE canvas_id = ? AND agent_id = ? AND id = ?')
        .run(canvas, agent, id);
    }
  }

  /**
   * Within a write: the canvas's row, and its document's as the live document has it, if it has
   * none (a draft's first, or one canvas memory forgot with its canvas while it was loaded: then
   * every row it has is written again, as corrallm, at the revision it had), so what is on disk is
   * what the live document's rows say before a change is written over them.
   */
  #ensure(live: Live, by: PartyId): void {
    const { store, memory } = this.#deps;
    const canvas = live.document.id;
    memory.ensure(canvas);
    if (store.prepare('SELECT 1 FROM document WHERE canvas_id = ?').get(canvas) !== undefined) {
      return;
    }
    store
      .prepare(
        `INSERT INTO document (canvas_id, rev, arrange, saved_hash, file_hash, created_by, by_party,
           changed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        canvas,
        live.rev,
        live.document.arrange ? 1 : 0,
        live.savedHash ?? null,
        live.fileHash ?? null,
        live.createdBy ?? null,
        by,
        this.#now(),
      );
    for (const [key, row] of Object.entries(live.rows)) {
      this.#upsert(canvas, key, row, live.revs.get(key) ?? live.rev, 'corrallm', live.creators);
    }
  }

  /**
   * The file canvas memory keeps for the canvas, its name and text: none if it has none, or it's
   * gone.
   */
  async #file(canvas: CanvasId): Promise<{ name: string; text: string } | undefined> {
    const file = (await this.#deps.memory.get(canvas)).file;
    if (file === undefined) return undefined;
    const name = path.basename(file);
    try {
      if ((await stat(file)).size > MAX_CANVAS_BYTES) {
        throw new Error(`${name} is too large to be a canvas`);
      }
      return { name, text: await readFile(file, 'utf8') };
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  /** The canvas a file holds, read against the catalog. Throws, naming the file and saying why. */
  #readFile({ name, text }: { name: string; text: string }): CanvasDocument {
    try {
      return this.read(text);
    } catch (error) {
      throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
  }

  /** Whether a document differs from its text as last saved or read (a draft: holds anything). */
  #edited(live: Live): boolean {
    if (live.savedHash === undefined) return live.document.nodes.length > 0;
    try {
      if (this.#deps.memory.fileOf(live.document.id) === undefined)
        return live.document.nodes.length > 0;
    } catch {
      // A failed-closed store changed no confirmed baseline: keep comparing the last saved hash.
    }
    return this.#text(live.document).hash !== live.savedHash;
  }

  /** A document's text, as toFile writes it, and its hash: once for each document. */
  #text(document: CanvasDocument): { text: string; hash: string } {
    let known = this.#texts.get(document);
    if (known === undefined) {
      const text = toFile(document);
      known = { text, hash: sha256(text) };
      this.#texts.set(document, known);
    }
    return known;
  }
}

/** A canvas's document as a draft's is: empty, kept nowhere yet. */
function emptyLive(canvas: CanvasId): Live {
  return {
    document: { id: canvas, arrange: false, nodes: [], links: [] },
    rev: 0,
    rows: { [META]: { arrange: false } },
    revs: new Map(),
    bys: new Map(),
    kept: false,
    creators: new Map(),
    createdBy: undefined,
    savedHash: undefined,
    fileHash: undefined,
    writingHash: undefined,
  };
}

/**
 * Who created each agent once `rows` replace `live`'s, by what `changed`: a node that becomes an
 * agent, by `creator` (none: read from a file); one gone, or no longer an agent, by none.
 */
function creatorsAfter(
  live: Live,
  rows: Readonly<Record<EntityKey, Row>>,
  changed: readonly EntityKey[],
  creator: PartyId | undefined,
): Map<string, PartyId> {
  const creators = new Map(live.creators);
  for (const key of changed) {
    if (entityOf(key) !== 'node') continue;
    const was = live.rows[key] as NodeRow | undefined;
    const is = rows[key] as NodeRow | undefined;
    if (is?.kind !== 'agent') {
      if (was !== undefined) creators.delete(was.id);
    } else if (was?.kind !== 'agent') {
      if (creator === undefined) creators.delete(is.id);
      else creators.set(is.id, creator);
    }
  }
  return creators;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** What tells of a change to the reviews as a write's other change (`within`): nothing to undo. */
function staged(told: Told | undefined): Staged | undefined {
  return told === undefined ? undefined : { reveal: told, undo: () => undefined };
}

/** Why a save over a canvas's file is refused while `review` of it is open. */
function saveRefusal(review: FileReview): string {
  return `${review.summary.file} changed on disk since corrallm last read or wrote it: apply it or keep corrallm’s canvas (${review.id}, in Needs you) before saving it.`;
}

/** Whether `one` and `other` are the same file: their real paths, else as they are written. */
async function sameFile(one: string | undefined, other: string): Promise<boolean> {
  if (one === undefined) return false;
  if (path.resolve(one) === path.resolve(other)) return true;
  const [a, b] = await Promise.all([
    realpath(one).catch(() => undefined),
    realpath(other).catch(() => undefined),
  ]);
  return a !== undefined && a === b;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A row's columns that aren't NULL: a row of the document's, as its columns name what it holds
 * (rows.ts), which leaves out what it lacks.
 */
function present(columns: Readonly<Record<string, unknown>>): object {
  return Object.fromEntries(Object.entries(columns).filter(([, value]) => value !== null));
}

/** A JSON column's value: NULL as NULL. */
function parsed(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : null;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
