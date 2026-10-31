import { createHash } from 'node:crypto';
import path from 'node:path';

import { isCanvasId } from '../../../shared/canvas';
import type { CanvasId } from '../../../shared/canvas';
import { MAX_NODE_ID } from '../../../shared/model/canvas';
import type { Database } from '../store/store';

/*
 * The merge journal (B9b Design §9 C8; schema 5's `merge_job`): each merge of an agent's branch into
 * your picked checkout's branch, recorded once its commits are prepared and before anything of your
 * checkout changes, so that a restart finds what it did by what your checkout shows, never by
 * running it again, and a caller's repeated request is answered from it, across a restart too.
 *
 * - Its **intent** (what it pinned, prepared and recorded) never changes once recorded: the
 *   destination checkout (its real top level, Git directories, repository identity), its branch
 *   and the commit pinned; the merge commit and its tree; the agent's branch, its tip, and the
 *   checkpoint commit with the digest it is bound to; ORIG_HEAD as it was; the requester; and a
 *   digest of the request's arguments, so a repeat with others isn't taken for it.
 * - Its **phase** (`installing` from the moment it is recorded, `installed` once your checkout was
 *   checked to be the merge, `published` once a checkpoint is on the agent's branch with its index
 *   not yet reset, `done`) and **outcome** (none while it goes on; `merged`, `refused`,
 *   `interrupted`, `held`, `superseded`) move compare-and-set, from where the caller thinks they
 *   are.
 * - At most one goes on per repository. A held merge into a checkout is superseded when another
 *   merge into the same checkout is recorded: that one passed the clean check there, so nothing
 *   partial of the held one shows any more.
 *
 * Every write is synchronous and runs within a write (`write`); it keeps nothing in memory, checks
 * what it is given and reads back only what it can read as it wrote it, failing the read
 * otherwise. Its paths are records, checked again before any use; it mints none.
 */

export type MergePhase = 'installing' | 'installed' | 'published' | 'done';
export type MergeOutcome = 'merged' | 'refused' | 'interrupted' | 'held' | 'superseded';

const PHASES: readonly MergePhase[] = ['installing', 'installed', 'published', 'done'];
const OUTCOMES: readonly MergeOutcome[] = [
  'merged',
  'refused',
  'interrupted',
  'held',
  'superseded',
];

/** What a merge pinned, prepared and recorded before it was installed: never changed. */
export interface MergeIntent {
  version: 1;
  /** The SHA-256 of the request's arguments: a repeat of its id with others isn't this one. */
  args: string;
  /** Who asked, as the merge commit's trailer names it: you, or `outside:<token name>`. */
  requester: string;
  /** Your checkout, as found when the merge was prepared, and the branch and commit pinned. */
  destination: {
    root: string;
    gitDir: string;
    commonDir: string;
    identity: string;
    branch: string;
    oid: string;
  };
  /** The prepared merge commit, M, and its tree. */
  merge: { tree: string; commit: string };
  /** The agent's branch, its tip, its checkout's Git directory, and its checkpoint (none: none). */
  source: {
    ref: string;
    tip: string;
    gitDir: string;
    checkpoint: string | null;
    digest: string | null;
  };
  /** ORIG_HEAD in your checkout before the install (none: there was none). */
  origHead: string | null;
}

export interface MergeJob {
  id: string;
  canvas: CanvasId;
  agent: string;
  workspace: string;
  repository: string;
  /** Who asked (you, or `token:<id>`) and the id of its request. */
  callerKey: string;
  requestId: string;
  intent: MergeIntent;
  phase: MergePhase;
  outcome: MergeOutcome | null;
  /** Why it ended as it did, for whoever asks again (a held one's, yours alone). */
  sentence: string | null;
  createdAt: number;
  updatedAt: number;
}

export type NewMergeJob = Pick<
  MergeJob,
  'id' | 'canvas' | 'agent' | 'workspace' | 'repository' | 'callerKey' | 'requestId' | 'intent'
>;

export type MergeJournalErrorCode = 'invalid' | 'refused' | 'stale' | 'not-found';

export class MergeJournalError extends Error {
  readonly code: MergeJournalErrorCode;
  constructor(code: MergeJournalErrorCode, message: string) {
    super(message);
    this.name = 'MergeJournalError';
    this.code = code;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const HASH = /^[0-9a-f]{64}$/;
/** Who asked: you, or an outside token by its id. */
const CALLER_KEY = /^(?:you|token:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
/** Who a merge commit's trailer names: you, or an outside orchestrator by its token's name. */
export const REQUESTER = /^(?:you|outside:[A-Za-z][A-Za-z0-9._-]{0,31})$/;
/** A branch's full ref, of a shape Git keeps and no option or revision syntax. */
const BRANCH =
  // eslint-disable-next-line no-control-regex
  /^refs\/heads\/(?!.*(?:\.\.|@\{|\/\/|\/\.|\.lock(?:\/|$)))[^\x00-\x20\x7f~^:?*[\\]+$/;
const MAX_PATH = 4096;
const MAX_IDENTITY = 1024;
const MAX_REF = 1024;
/** A sentence is at most 2 KiB of UTF-8, as a refusal's is. */
const MAX_SENTENCE_BYTES = 2048;

type Row = Record<string, unknown>;

export interface MergeJournalDeps {
  store: Database;
  /** The time, in epoch ms. */
  now?: () => number;
}

export class MergeJournal {
  readonly #store: Database;
  readonly #now: () => number;

  constructor({ store, now = () => Date.now() }: MergeJournalDeps) {
    this.#store = store;
    this.#now = now;
  }

  /**
   * Runs `run` in a write of its own: on disk once it resolves, with what it returned; rejects,
   * keeping nothing of it, if it threw or couldn't be written.
   */
  write<T>(run: (journal: this) => T): Promise<T> {
    return this.#store.write(() => run(this));
  }

  job(id: string): MergeJob | undefined {
    const row = this.#store.prepare('SELECT * FROM merge_job WHERE id = ?').get(id);
    return row === undefined ? undefined : jobOf(row);
  }

  /** The merge a caller's request recorded, if one did. */
  byRequest(callerKey: string, requestId: string): MergeJob | undefined {
    const row = this.#store
      .prepare('SELECT * FROM merge_job WHERE caller_key = ? AND request_id = ?')
      .get(callerKey, requestId);
    return row === undefined ? undefined : jobOf(row);
  }

  /** Every merge going on, oldest first: what a restart reconciles. */
  open(): MergeJob[] {
    return this.#store
      .prepare('SELECT * FROM merge_job WHERE outcome IS NULL ORDER BY created_at, id')
      .all()
      .map(jobOf);
  }

  /** The merge going on into the repository, if one is. */
  openIn(repository: string): MergeJob | undefined {
    const row = this.#store
      .prepare('SELECT * FROM merge_job WHERE repository_id = ? AND outcome IS NULL')
      .get(repository);
    return row === undefined ? undefined : jobOf(row);
  }

  /** Every merged checkpoint whose agent's index wasn't reset yet: what a restart finishes. */
  resetsPending(): MergeJob[] {
    return this.#store
      .prepare(
        `SELECT * FROM merge_job WHERE outcome = 'merged' AND phase = 'published'
         ORDER BY created_at, id`,
      )
      .all()
      .map(jobOf);
  }

  /** The workspace's latest merge, if it has had one. */
  latest(workspace: string): MergeJob | undefined {
    const row = this.#store
      .prepare(
        'SELECT * FROM merge_job WHERE workspace_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
      )
      .get(workspace);
    return row === undefined ? undefined : jobOf(row);
  }

  /**
   * Within a write: records a merge, `installing`, before it is installed. Refused if the caller's
   * request recorded one already (it is answered from that one) or a merge goes on into the
   * repository. A held merge into the same checkout is superseded.
   */
  record(job: NewMergeJob): MergeJob {
    const asked = checkJob(job);
    if (this.job(asked.id) !== undefined) {
      throw new MergeJournalError('refused', `The merge ${asked.id} is recorded already.`);
    }
    if (this.byRequest(asked.callerKey, asked.requestId) !== undefined) {
      throw new MergeJournalError('refused', 'That request recorded a merge already.');
    }
    if (this.openIn(asked.repository) !== undefined) {
      throw new MergeJournalError('refused', 'A merge into that repository goes on already.');
    }
    const at = this.#now();
    for (const held of this.#heldIn(asked.repository)) {
      if (held.intent.destination.gitDir === asked.intent.destination.gitDir) {
        this.#store
          .prepare(
            "UPDATE merge_job SET outcome = 'superseded', updated_at = ? WHERE id = ? AND outcome = 'held'",
          )
          .run(at, held.id);
      }
    }
    const recorded: MergeJob = {
      ...asked,
      phase: 'installing',
      outcome: null,
      sentence: null,
      createdAt: at,
      updatedAt: at,
    };
    const intent = JSON.stringify(recorded.intent);
    this.#store
      .prepare(
        `INSERT INTO merge_job (id, canvas_id, agent_id, workspace_id, repository_id, caller_key,
           request_id, intent, intent_hash, phase, outcome, sentence, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
      )
      .run(
        recorded.id,
        recorded.canvas,
        recorded.agent,
        recorded.workspace,
        recorded.repository,
        recorded.callerKey,
        recorded.requestId,
        intent,
        hashOf(intent),
        recorded.phase,
        at,
        at,
      );
    return recorded;
  }

  /** Within a write: a merge going on reached `to`, from `from` (stale if it isn't there). */
  advance(id: string, { from, to }: { from: MergePhase; to: MergePhase }): MergeJob {
    checkPhase(to);
    const kept = this.#going(id);
    if (kept.phase !== from) {
      throw new MergeJournalError('stale', `The merge ${id} is at ${kept.phase}, not ${from}.`);
    }
    const next: MergeJob = { ...kept, phase: to, updatedAt: this.#now() };
    this.#store
      .prepare('UPDATE merge_job SET phase = ?, updated_at = ? WHERE id = ?')
      .run(to, next.updatedAt, id);
    return next;
  }

  /**
   * Within a write: a merge going on ended (stale if it ended already), at `phase` if given, saying
   * `sentence` (none: none).
   */
  settle(
    id: string,
    {
      outcome,
      phase,
      sentence = null,
    }: { outcome: MergeOutcome; phase?: MergePhase; sentence?: string | null },
  ): MergeJob {
    if (!OUTCOMES.includes(outcome) || outcome === 'superseded') {
      throw invalid(`${outcome} isn’t how a merge going on ends.`);
    }
    if (phase !== undefined) checkPhase(phase);
    if (sentence !== null) checkSentence(sentence);
    const kept = this.#going(id);
    const next: MergeJob = {
      ...kept,
      phase: phase ?? kept.phase,
      outcome,
      sentence,
      updatedAt: this.#now(),
    };
    this.#store
      .prepare(
        'UPDATE merge_job SET phase = ?, outcome = ?, sentence = ?, updated_at = ? WHERE id = ?',
      )
      .run(next.phase, outcome, sentence, next.updatedAt, id);
    return next;
  }

  /** Within a write: a merged checkpoint's agent's index was reset (or needs it no more). */
  finishReset(id: string): MergeJob {
    const kept = this.job(id);
    if (kept === undefined) throw new MergeJournalError('not-found', `There is no merge ${id}.`);
    if (kept.outcome !== 'merged' || kept.phase !== 'published') {
      throw new MergeJournalError('stale', `The merge ${id} has no index to reset.`);
    }
    const next: MergeJob = { ...kept, phase: 'done', updatedAt: this.#now() };
    this.#store
      .prepare("UPDATE merge_job SET phase = 'done', updated_at = ? WHERE id = ?")
      .run(next.updatedAt, id);
    return next;
  }

  /** Within a write: a held merge is superseded (its destination shows its state no more). */
  supersede(id: string): MergeJob {
    const kept = this.job(id);
    if (kept === undefined) throw new MergeJournalError('not-found', `There is no merge ${id}.`);
    if (kept.outcome !== 'held') {
      throw new MergeJournalError('stale', `The merge ${id} isn’t held.`);
    }
    const next: MergeJob = { ...kept, outcome: 'superseded', updatedAt: this.#now() };
    this.#store
      .prepare("UPDATE merge_job SET outcome = 'superseded', updated_at = ? WHERE id = ?")
      .run(next.updatedAt, id);
    return next;
  }

  #heldIn(repository: string): MergeJob[] {
    return this.#store
      .prepare("SELECT * FROM merge_job WHERE repository_id = ? AND outcome = 'held'")
      .all(repository)
      .map(jobOf);
  }

  #going(id: string): MergeJob {
    const kept = this.job(id);
    if (kept === undefined) throw new MergeJournalError('not-found', `There is no merge ${id}.`);
    if (kept.outcome !== null) {
      throw new MergeJournalError('stale', `The merge ${id} ended (${kept.outcome}).`);
    }
    return kept;
  }
}

/** The SHA-256 of a merge's request's arguments, as its intent keeps them. */
export function argsDigest(args: unknown): string {
  return hashOf(canonical(args));
}

/** `value` as JSON with each object's keys in order: equal for equal values, however sent. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    typeof inner === 'object' && inner !== null && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : inner,
  );
}

function hashOf(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function invalid(message: string): MergeJournalError {
  return new MergeJournalError('invalid', message);
}

function checkPhase(phase: unknown): asserts phase is MergePhase {
  if (!PHASES.includes(phase as MergePhase)) throw invalid(`${String(phase)} isn’t a phase.`);
}

function checkSentence(sentence: unknown): asserts sentence is string {
  if (
    typeof sentence !== 'string' ||
    sentence === '' ||
    sentence.includes('\0') ||
    !sentence.isWellFormed() ||
    Buffer.byteLength(sentence) > MAX_SENTENCE_BYTES
  ) {
    throw invalid('A merge’s sentence is some text of at most 2 KiB.');
  }
}

function text(value: unknown, most: number, what: string): string {
  if (typeof value !== 'string' || value === '' || value.length > most || value.includes('\0')) {
    throw invalid(`That isn’t a ${what}.`);
  }
  return value;
}

function absolute(value: unknown, what: string): string {
  const at = text(value, MAX_PATH, what);
  if (!path.isAbsolute(at)) throw invalid(`The ${what} isn’t an absolute path.`);
  return at;
}

function oid(value: unknown, what: string): string {
  if (typeof value !== 'string' || !OID.test(value)) throw invalid(`That isn’t a ${what}.`);
  return value;
}

function branch(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length > MAX_REF || !BRANCH.test(value)) {
    throw invalid(`That isn’t a ${what}.`);
  }
  return value;
}

/** An intent as the merge service makes one, checked whole: one object format throughout. */
function checkIntent(value: unknown): MergeIntent {
  if (typeof value !== 'object' || value === null) throw invalid('That isn’t a merge’s intent.');
  const given = value as Record<string, unknown>;
  if (given.version !== 1) throw invalid('That isn’t a merge’s intent.');
  const args = given.args;
  if (typeof args !== 'string' || !HASH.test(args)) throw invalid('That isn’t a request’s digest.');
  const requester = given.requester;
  if (typeof requester !== 'string' || !REQUESTER.test(requester)) {
    throw invalid('That isn’t who may ask for a merge.');
  }
  const destination = (given.destination ?? {}) as Record<string, unknown>;
  const merge = (given.merge ?? {}) as Record<string, unknown>;
  const source = (given.source ?? {}) as Record<string, unknown>;
  const checkpoint =
    source.checkpoint === null ? null : oid(source.checkpoint, 'checkpoint commit');
  const digest =
    source.digest === null
      ? null
      : typeof source.digest === 'string' && HASH.test(source.digest)
        ? source.digest
        : (() => {
            throw invalid('That isn’t a digest.');
          })();
  if ((checkpoint === null) !== (digest === null)) {
    throw invalid('A checkpoint is bound to the digest it was reviewed by, and only one is.');
  }
  const intent: MergeIntent = {
    version: 1,
    args,
    requester,
    destination: {
      root: absolute(destination.root, 'checkout'),
      gitDir: absolute(destination.gitDir, 'Git directory'),
      commonDir: absolute(destination.commonDir, 'common Git directory'),
      identity: text(destination.identity, MAX_IDENTITY, 'repository’s identity'),
      branch: branch(destination.branch, 'branch'),
      oid: oid(destination.oid, 'commit'),
    },
    merge: { tree: oid(merge.tree, 'tree'), commit: oid(merge.commit, 'commit') },
    source: {
      ref: branch(source.ref, 'branch'),
      tip: oid(source.tip, 'commit'),
      gitDir: absolute(source.gitDir, 'Git directory'),
      checkpoint,
      digest,
    },
    origHead: given.origHead === null ? null : oid(given.origHead, 'commit'),
  };
  const length = intent.destination.oid.length;
  const oids = [
    intent.merge.tree,
    intent.merge.commit,
    intent.source.tip,
    ...(checkpoint === null ? [] : [checkpoint]),
    ...(intent.origHead === null ? [] : [intent.origHead]),
  ];
  if (oids.some((one) => one.length !== length)) {
    throw invalid('A merge’s commits are of one repository’s object format.');
  }
  return intent;
}

function checkJob(job: NewMergeJob): NewMergeJob {
  const { id, canvas, agent, workspace, repository, callerKey, requestId } = job;
  if (typeof id !== 'string' || !UUID.test(id)) throw invalid('That isn’t a merge’s id.');
  if (!isCanvasId(canvas)) throw invalid('That isn’t a canvas’s id.');
  if (typeof agent !== 'string' || agent === '' || agent.length > MAX_NODE_ID) {
    throw invalid('That isn’t an agent’s id.');
  }
  for (const [value, what] of [
    [workspace, 'workspace'],
    [repository, 'repository'],
    [requestId, 'request'],
  ] as const) {
    if (typeof value !== 'string' || !UUID.test(value)) throw invalid(`That isn’t a ${what}’s id.`);
  }
  if (typeof callerKey !== 'string' || !CALLER_KEY.test(callerKey)) {
    throw invalid('That isn’t who may ask for a merge.');
  }
  return {
    id,
    canvas,
    agent,
    workspace,
    repository,
    callerKey,
    requestId,
    intent: checkIntent(JSON.parse(JSON.stringify(job.intent)) as unknown),
  };
}

function jobOf(row: Row): MergeJob {
  try {
    const intentText = row.intent;
    if (typeof intentText !== 'string' || row.intent_hash !== hashOf(intentText)) {
      throw new TypeError('Not its intent');
    }
    const phase = row.phase;
    checkPhase(phase);
    const outcome = row.outcome;
    if (outcome !== null && !OUTCOMES.includes(outcome as MergeOutcome)) {
      throw new TypeError('Not an outcome');
    }
    const sentence = row.sentence;
    if (sentence !== null) checkSentence(sentence);
    const checked = checkJob({
      id: row.id as string,
      canvas: row.canvas_id as CanvasId,
      agent: row.agent_id as string,
      workspace: row.workspace_id as string,
      repository: row.repository_id as string,
      callerKey: row.caller_key as string,
      requestId: row.request_id as string,
      intent: JSON.parse(intentText) as MergeIntent,
    });
    const createdAt = row.created_at;
    const updatedAt = row.updated_at;
    if (!Number.isSafeInteger(createdAt) || !Number.isSafeInteger(updatedAt)) {
      throw new TypeError('Not a time');
    }
    return {
      ...checked,
      phase,
      outcome: outcome as MergeOutcome | null,
      sentence,
      createdAt: createdAt as number,
      updatedAt: updatedAt as number,
    };
  } catch {
    const id = typeof row.id === 'string' ? row.id : '?';
    throw new Error(
      `A merge_job record (${id}) can’t be read: no corrallm of this schema wrote it.`,
    );
  }
}
