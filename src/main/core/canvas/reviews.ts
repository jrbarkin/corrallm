import { randomUUID } from 'node:crypto';

import type { NeedId } from '../../../shared/api/ids';
import type { CanvasId } from '../../../shared/canvas';
import type { CanvasDocument } from '../../../shared/model/canvas';
import type { PartyId } from '../../../shared/model/messages';
import type { NeedsItem } from '../../../shared/model/needs';
import { diffRows, entityOf, META, nodeKey } from '../../../shared/model/rows';
import type { ItemRow, NodeRow, Rows } from '../../../shared/model/rows';
import { andList } from '../../../shared/model/words';
import { nameOf } from '../parties';
import type { Database } from '../store/store';

/*
 * The reviews of canvas files changed on disk (Core Server §5.10, B9 Design §5): a canvas's file
 * whose bytes are none the core last read or wrote of it is never read over what the core keeps of
 * the canvas. The core raises a review for you instead (`file/<uuid>`, in the profile's database:
 * `file_review`), worded with what the file changes of the canvas, and keeps it until you answer
 * it (`reply`: Apply, which reads the file as your change, or Keep, which keeps corrallm's canvas
 * for its next save to write over the file) or the file changes again (superseded, by corrallm).
 * One is open at a time on a canvas. A review keeps the hash of the bytes it reviewed and what they
 * change, never the file's text. When and how a file is checked is the canvas's document's to say
 * (documents.ts); this keeps the reviews and words them.
 */

/** How a review was settled. */
export type ReviewOutcome = 'applied' | 'kept' | 'superseded';

/** What a changed agent changes: its name, role, connection, settings, queue, group or place. */
export type Aspect = 'name' | 'role' | 'connection' | 'settings' | 'queue' | 'group' | 'place';

/** Some of what a list names (the first NAMED), and how many it names in all. */
export interface Named<T = string> {
  names: T[];
  count: number;
}

/** What a file changed on disk changes of its canvas, as its review says it. */
export interface ReviewSummary {
  /** The file's name. */
  file: string;
  /**
   * The hash of the bytes it changed from: the file as the core last read or wrote it. Keep holds
   * only until those change (a save writes the file over what was kept).
   */
  from: string | null;
  /** Why the file isn't a canvas this corrallm reads, when it isn't. */
  fault?: string;
  /** The agents the file adds, by its names for them. */
  added?: Named;
  /**
   * The agents it removes, and those it changes, by the canvas's names for them (and the file's,
   * `as`, for one it renames).
   */
  removed?: Named;
  changed?: Named<{ name: string; as?: string; what: Aspect[] }>;
  /** How many groups (frames) it adds, removes or changes, and links it adds or removes. */
  groups?: number;
  links?: number;
  /** Whether it has structural edits lay the canvas out, when it says otherwise. */
  arrange?: boolean;
}

/** A review open for you. */
export interface FileReview {
  /** Its Needs item's id: file/<uuid>. */
  id: NeedId;
  canvas: CanvasId;
  /** The hash of the file's bytes it reviews. */
  hash: string;
  summary: ReviewSummary;
  /** When it was raised, in epoch ms. */
  at: number;
}

/** What tells of a write's change to the reviews once it is on disk. */
export type Told = () => void;

export interface FileReviewsDeps {
  /** The profile's database, which keeps them. */
  store: Pick<Database, 'prepare'>;
  /** Hears what waits on a canvas change: a review raised or settled, and by whom. */
  changed?: (canvas: CanvasId, by: PartyId) => void;
  now?: () => number;
  /** The id each review raised takes: a random UUID but in tests. */
  newId?: () => string;
}

/** The most agents a review's words name in each list, then how many more there are. */
const NAMED = 5;
/** The most characters of why a file isn't a canvas a review keeps. */
const FAULT = 300;
/** Why only you may choose either of a review's choices. */
const YOURS =
  'A canvas file changed on disk is applied only once the user accepts what changed: no token’s say-so does it.';
const PREFIX = 'file/';

export class FileReviews {
  readonly #deps: FileReviewsDeps;
  readonly #now: () => number;
  readonly #newId: () => string;

  constructor(deps: FileReviewsDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => Date.now());
    this.#newId = deps.newId ?? randomUUID;
  }

  /** The review open on a canvas, if one is (none if they can't be read). */
  open(canvas: CanvasId): FileReview | undefined {
    try {
      const row = this.#deps.store
        .prepare(
          `SELECT id, file_hash, summary, raised_at FROM file_review
           WHERE canvas_id = ? AND outcome IS NULL`,
        )
        .get(canvas);
      return row === undefined ? undefined : reviewOf(row, canvas);
    } catch (error) {
      console.error('Could not read the canvas’s file reviews:', error);
      return undefined;
    }
  }

  /** The review open on a canvas, by its id. */
  get(canvas: CanvasId, id: string): FileReview | undefined {
    const open = this.open(canvas);
    return open?.id === id ? open : undefined;
  }

  /** How a review no longer open was settled, and by whom, if it was raised at all. */
  settled(canvas: CanvasId, id: string): { outcome: ReviewOutcome; by: PartyId } | undefined {
    if (!id.startsWith(PREFIX)) return undefined;
    try {
      const row = this.#deps.store
        .prepare(
          `SELECT outcome, settled_by FROM file_review
           WHERE id = ? AND canvas_id = ? AND outcome IS NOT NULL`,
        )
        .get(id.slice(PREFIX.length), canvas);
      return row === undefined
        ? undefined
        : { outcome: row.outcome as ReviewOutcome, by: row.settled_by as PartyId };
    } catch {
      return undefined;
    }
  }

  /** The Needs item of the review open on a canvas, for you: none if none is. */
  items(canvas: CanvasId): NeedsItem[] {
    const open = this.open(canvas);
    return open === undefined ? [] : [itemOf(open)];
  }

  /**
   * Whether you kept corrallm's canvas over the file's bytes hashing to `hash`, changed from those
   * hashing to `from` (the file as the core last read or wrote it): what Keep holds to, until the
   * file is written over them. Its generation must still match too: even a write of the same
   * baseline bytes expires the earlier Keep.
   */
  kept(canvas: CanvasId, hash: string, from: string | undefined): boolean {
    return this.#deps.store
      .prepare(
        `SELECT summary FROM file_review
         WHERE canvas_id = ? AND file_hash = ? AND outcome = 'kept'
           AND file_generation = (SELECT file_generation FROM document WHERE canvas_id = ?)`,
      )
      .all(canvas, hash, canvas)
      .some((row) => summaryOf(row.summary)?.from === (from ?? null));
  }

  /**
   * Within a write: a review of the canvas's file, its bytes hashing to `hash`, changing what
   * `summary` says, the one open before it settled superseded; what tells of it once the write is
   * on disk.
   */
  raiseWithin(canvas: CanvasId, hash: string, summary: ReviewSummary): Told {
    this.#supersede(canvas);
    const uuid = this.#newId();
    this.#deps.store
      .prepare(
        `INSERT INTO file_review (id, canvas_id, file_hash, file_generation, summary, raised_at)
         VALUES (?, ?, ?, (SELECT file_generation FROM document WHERE canvas_id = ?), ?, ?)`,
      )
      .run(uuid, canvas, hash, canvas, JSON.stringify(summary), this.#now());
    return () => {
      this.#deps.changed?.(canvas, 'corrallm');
    };
  }

  /**
   * Within a write: `review` settled as `outcome`, by `by`; what tells of it once the write is on
   * disk. Throws if it was settled already.
   */
  settleWithin(review: FileReview, outcome: ReviewOutcome, by: PartyId): Told {
    const { changes } = this.#deps.store
      .prepare(
        `UPDATE file_review SET outcome = ?, settled_by = ?, settled_at = ?
         WHERE id = ? AND outcome IS NULL`,
      )
      .run(outcome, by, this.#now(), review.id.slice(PREFIX.length));
    if (Number(changes) !== 1) throw new Error(`${review.id} was settled already.`);
    return () => {
      this.#deps.changed?.(review.canvas, by);
    };
  }

  /**
   * Within a write: the review open on the canvas, if one is, settled superseded by corrallm (the
   * file is as the core has it again, or another); what tells of it once the write is on disk.
   */
  supersedeWithin(canvas: CanvasId): Told | undefined {
    if (!this.#supersede(canvas)) return undefined;
    return () => {
      this.#deps.changed?.(canvas, 'corrallm');
    };
  }

  /** Within a write: the review open on the canvas settled superseded; whether one was. */
  #supersede(canvas: CanvasId): boolean {
    const { changes } = this.#deps.store
      .prepare(
        `UPDATE file_review SET outcome = 'superseded', settled_by = 'corrallm', settled_at = ?
         WHERE canvas_id = ? AND outcome IS NULL`,
      )
      .run(this.#now(), canvas);
    return Number(changes) > 0;
  }
}

/** A review's Needs item, for you: Apply (unless its file isn't a canvas) and Keep, yours alone. */
export function itemOf(review: FileReview): NeedsItem {
  const { summary } = review;
  const keep = {
    value: 'keep',
    label: 'Keep',
    description: 'Keep corrallm’s canvas: its next save writes it over the file.',
    humanOnly: YOURS,
  };
  return {
    id: review.id,
    canvas: review.canvas,
    kind: 'file',
    for: 'you',
    by: ['you'],
    title: `${summary.file} changed on disk`,
    detail: detailOf(summary),
    choices:
      summary.fault === undefined
        ? [
            {
              value: 'apply',
              label: 'Apply',
              description:
                'Replace corrallm’s canvas with the file’s, as your change, unless the file changed again since.',
              humanOnly: YOURS,
            },
            keep,
          ]
        : [keep],
    answerIn: 'api',
  };
}

/**
 * What the file named `file`, changed from the bytes hashing to `from`, changes of the canvas: the
 * live document kept in `rows`, against `next`, the canvas the file holds, or why it holds none.
 */
export function summarize(
  file: string,
  from: string | undefined,
  live: { document: CanvasDocument; rows: Rows },
  next: CanvasDocument | { fault: string },
): ReviewSummary {
  const summary: ReviewSummary = { file, from: from ?? null };
  if ('fault' in next) {
    const fault = next.fault.replace(/\s+/g, ' ').trim();
    return { ...summary, fault: fault.length > FAULT ? `${fault.slice(0, FAULT - 1)}…` : fault };
  }
  const { rows, changed } = diffRows(live.rows, next);
  const added: string[] = [];
  const removed: string[] = [];
  const aspects = new Map<string, Set<Aspect>>();
  const aspect = (agent: string, what: Aspect) => {
    const known = aspects.get(agent) ?? new Set<Aspect>();
    known.add(what);
    aspects.set(agent, known);
  };
  let groups = 0;
  let links = 0;
  let arrange: boolean | undefined;
  for (const key of changed) {
    const entity = entityOf(key);
    if (key === META) {
      arrange = next.arrange;
    } else if (entity === 'link') {
      links += 1;
    } else if (entity === 'item') {
      const { agent } = (rows[key] ?? live.rows[key]) as ItemRow;
      if (isAgent(live.rows, agent) && isAgent(rows, agent)) aspect(agent, 'queue');
    } else {
      const was = live.rows[key] as NodeRow | undefined;
      const is = rows[key] as NodeRow | undefined;
      if (is?.kind === 'agent' && was?.kind === 'agent') {
        for (const what of aspectsOf(was, is)) aspect(is.id, what);
      } else if (is?.kind === 'agent') {
        added.push(nameOf(next.nodes, is.id));
        if (was !== undefined) groups += 1;
      } else if (was?.kind === 'agent') {
        removed.push(nameOf(live.document.nodes, was.id));
        if (is !== undefined) groups += 1;
      } else {
        groups += 1;
      }
    }
  }
  const changedAgents = [...aspects].map(([agent, what]) => ({
    name: nameOf(live.document.nodes, agent),
    ...(what.has('name') ? { as: nameOf(next.nodes, agent) } : {}),
    what: ASPECTS.filter((one) => what.has(one)),
  }));
  return {
    ...summary,
    ...(added.length === 0 ? {} : { added: named(added) }),
    ...(removed.length === 0 ? {} : { removed: named(removed) }),
    ...(changedAgents.length === 0 ? {} : { changed: named(changedAgents) }),
    ...(groups === 0 ? {} : { groups }),
    ...(links === 0 ? {} : { links }),
    ...(arrange === undefined ? {} : { arrange }),
  };
}

/** The aspects in the order a review names them. */
const ASPECTS: readonly Aspect[] = [
  'name',
  'role',
  'connection',
  'settings',
  'queue',
  'group',
  'place',
];

/** What an agent's row changes, besides its place among its siblings. */
function aspectsOf(was: NodeRow, is: NodeRow): Aspect[] {
  const what: Aspect[] = [];
  if (was.label !== is.label) what.push('name');
  if (was.role !== is.role) what.push('role');
  if (was.adapter !== is.adapter || was.connection !== is.connection) what.push('connection');
  if (JSON.stringify(was.settings ?? null) !== JSON.stringify(is.settings ?? null)) {
    what.push('settings');
  }
  if (was.parent !== is.parent) what.push('group');
  if (was.x !== is.x || was.y !== is.y) what.push('place');
  return what;
}

/** Whether `rows` hold `id` as an agent. */
function isAgent(rows: Rows, id: string): boolean {
  return (rows[nodeKey(id)] as NodeRow | undefined)?.kind === 'agent';
}

function named<T>(all: readonly T[]): Named<T> {
  return { names: all.slice(0, NAMED), count: all.length };
}

/** A review's words: what its file changes, and what each choice does. */
function detailOf(summary: ReviewSummary): string {
  if (summary.fault !== undefined) {
    const why = summary.fault.replace(/[.\s]+$/, '');
    return `The file isn’t a canvas this corrallm reads (${why.charAt(0).toLowerCase()}${why.slice(1)}). Keep corrallm’s canvas, and its next save writes it over the file.`;
  }
  const parts = [
    ...(summary.added ? [`adds ${listOf(summary.added)}`] : []),
    ...(summary.removed ? [`removes ${listOf(summary.removed)}`] : []),
    ...(summary.changed
      ? [
          `changes ${listOf({
            names: summary.changed.names.map(({ name, as, what }) => {
              const others = what.filter((one) => one !== 'name');
              const words = [
                ...(as === undefined ? [] : [`renamed ${as}`]),
                ...(others.length === 0 ? [] : [`its ${andList(others)}`]),
              ];
              return `${name} (${words.length === 0 ? 'its order' : words.join('; ')})`;
            }),
            count: summary.changed.count,
          })}`,
        ]
      : []),
    ...(summary.groups ? [`changes ${counted(summary.groups, 'group')}`] : []),
    ...(summary.links ? [`changes ${counted(summary.links, 'link')}`] : []),
    ...(summary.arrange === undefined
      ? []
      : [summary.arrange ? 'arranges the canvas' : 'stops arranging the canvas']),
  ];
  const what =
    parts.length === 0
      ? 'The file orders what the canvas holds another way.'
      : `The file ${parts.join('; ')}.`;
  return `${what} Apply replaces corrallm’s canvas with the file’s, as your change; Keep keeps corrallm’s, and its next save writes it over the file.`;
}

/** Names, and how many more there are. */
function listOf({ names, count }: Named): string {
  const more = count - names.length;
  return andList(more > 0 ? [...names, `${String(more)} more`] : names);
}

function counted(count: number, what: string): string {
  return `${String(count)} ${what}${count === 1 ? '' : 's'}`;
}

/** A row of `file_review`, open: undefined if it isn't one this code reads. */
function reviewOf(row: Record<string, unknown>, canvas: CanvasId): FileReview | undefined {
  const { id, file_hash: hash, raised_at: at } = row;
  const summary = summaryOf(row.summary);
  if (
    typeof id !== 'string' ||
    typeof hash !== 'string' ||
    typeof at !== 'number' ||
    summary === undefined
  ) {
    return undefined;
  }
  return { id: `${PREFIX}${id}` as NeedId, canvas, hash, summary, at };
}

/** A review's summary as kept: undefined if it isn't one this code reads. */
function summaryOf(value: unknown): ReviewSummary | undefined {
  try {
    const summary: unknown = JSON.parse(String(value));
    if (typeof summary !== 'object' || summary === null || Array.isArray(summary)) return undefined;
    const { file, from } = summary as Record<string, unknown>;
    if (typeof file !== 'string' || (from !== null && typeof from !== 'string')) return undefined;
    return summary as ReviewSummary;
  } catch {
    return undefined;
  }
}
