import { randomUUID } from 'node:crypto';
import { lstatSync, readdirSync } from 'node:fs';
import path from 'node:path';

import type { OpResult } from '../../../shared/api/errors';
import type { CanvasId } from '../../../shared/canvas';
import { branchPathSentence } from '../../../shared/model/branch-patch';
import { andList } from '../../../shared/model/words';
import { OpFailure } from '../call';
import type { Caller } from '../caller';
import type { TrustedPath } from '../host';
import { verifiedCheckout } from './checkout';
import { discoverRepository } from './discovery';
import type { DrainWords, TreeKey, WorkspaceGate } from './gate';
import { GitError, MERGE_TIMEOUT_MS } from './git';
import type { GitCall, GitIdentity, GitRunner } from './git';
import {
  anotherGit,
  checkClean,
  checkIncoming,
  checkOrigHead,
  hiddenEntries,
  readOrigHead,
  restoreOrigHead,
  statusEntries,
  WORKTREE_READ_CONFIG,
} from './merge-checks';
import type { OrigHead } from './merge-checks';
import { makeTemporaryIndex, removeTemporaryIndex } from './merge-index';
import { argsDigest, MergeJournalError, REQUESTER } from './merge-journal';
import type { MergeIntent, MergeJob, MergeJournal, MergePhase } from './merge-journal';
import {
  checkInto,
  checkMergeable,
  checkSource,
  findDestination,
  gitRefusal,
  selectSource,
  shown,
} from './merge-select';
import type { MergeDestination, MergeRefusal, MergeSource } from './merge-select';
import { GitMetadataError, verifyMergeWrites } from './metadata';
import type { MergeWrites } from './metadata';
import { QueueFull } from './queue';
import type { ProvisioningQueue } from './queue';
import { ACTIVE_STATES } from './store';
import type { AgentBinding, WorkspaceStore, WorktreeRecord } from './store';
import { inventoryUncommitted, treeDigest } from './uncommitted';

/*
 * The merge service (B9b Design §9 C5 to C8, and §9.3 step by step): an agent's branch merged into
 * the branch your picked checkout is on, as a two-parent merge commit by you, without ever running
 * a program your repository configures, overwriting or hiding your work, or leaving a half-done
 * state it can't recover from. `branch.merge` (X2) is registered over `merge`.
 *
 * 1. **Admission**: the agent's workspace (its binding, ready, no change waiting), no member of its
 *    tree writing, a place in the queue; then its repository's lane of the provisioning queue (the
 *    one creation, removal and every merge into the repository share, across canvases), held for
 *    the whole job. With a checkpoint, the lane then takes a non-waiting drain of the agent's tree
 *    (every member, every canvas), never the reverse; without one, nothing of that tree is held,
 *    its writers checked again.
 * 2. **Checks**, in the lane: the source (`selectSource`, `checkMergeable`, the caller's pin), the
 *    destination found again from the canvas's picked folder (`findDestination`, the caller's pin),
 *    no agent working in your checkout itself, the clean check, the agent's uncommitted work (a
 *    choice is required when it has some; `commit` only the very work the caller reviewed), and,
 *    immediately before the first write, everything the admission read: the canvas run by the core,
 *    its project, the agent's binding and membership, the caller still authorized.
 * 3. **Already merged**: with no checkpoint and the tip in your branch's history, nothing written.
 * 4. **Preparation**, writing only objects (`MergeWrites` checked around each write): a checkpoint
 *    (a temporary index of the core's, `read-tree` of the tip, `add -A`, `write-tree`, the tree's
 *    digest the one reviewed, `commit-tree` by corrallm: unpublished); `merge-tree` of your
 *    branch's commit and the source, in your checkout (its attributes apply as `git merge`'s would),
 *    under the runner's merge profile (a conflict refused, naming the files); your identity as Git
 *    resolves it there; `commit-tree` of the merge, M, its first parent your commit; then what M
 *    writes checked (corrallm's folder, submodules, filtered files, missing objects, ignored files).
 * 5. **Record**: ORIG_HEAD as it is, then the journal's row (`merge_job`), on disk.
 * 6. **Last check**: your checkout found again, on the pinned branch at the pinned commit, clean,
 *    ORIG_HEAD as recorded and a plain ref; with a checkpoint, the agent's branch still at its tip.
 * 7. **Install** (the point of no return: from here the job is never cancelled; quitting waits for
 *    it): a fast-forward to M (`GitRunner.install`). Git refusing it before writing anything but
 *    ORIG_HEAD (a file in its way) is still "nothing changed": ORIG_HEAD is put back.
 * 8. **Postconditions**: your branch at M, HEAD on it, ORIG_HEAD your commit, the index M's tree,
 *    the files clean, no lock left. Anything else is `held`, never reported merged or unchanged.
 * 9. **The checkpoint published**: the agent's branch moved from its tip to the checkpoint
 *    (`update-ref` with the tip as the expected old value, in its checkout), its index reset to the
 *    checkpoint's tree (`read-tree --reset`, no file written). A branch that moved meanwhile keeps
 *    its own commits: the merge stands, and the result says the work wasn't recorded on it.
 * 10. **Settle**: the outcome on disk, then the answer.
 *
 * A restart reconciles every merge left going on (`reconcile`), after child recovery and before any
 * merge into its repository or any new work in the agent's tree, by what your checkout shows: never
 * installed (`interrupted`, ORIG_HEAD put back), installed (finished, `merged`), Git stopped between
 * its index and your branch (the branch moved to M, then as installed), or anything else (`held`:
 * nothing reset, no lock removed). A caller's repeated request is answered from the journal.
 */

/** Who asks for a merge, as the service keeps it: across restarts, and in the merge's trailer. */
export interface MergeCaller {
  /** What its repeated requests are kept by: `you`, or `token:<the token's id>`. */
  key: string;
  /** Who the merge commit's trailer names: `you`, or `outside:<the token's name>`. */
  requester: string;
}

/**
 * Who a caller of `branch.merge` is to the merge service: you, or an outside token that may merge
 * (by its id, which a renewal or replacement changes, and its name). An agent, or a token made
 * with `--no-merge` or read-only, is never one: core.call refuses them first (`merge-permits`).
 */
export function mergeCallerOf(caller: Caller): MergeCaller {
  if (caller.kind === 'human') return { key: 'you', requester: 'you' };
  if (caller.kind === 'outside' && caller.access === 'write' && caller.merge) {
    return { key: `token:${caller.token}`, requester: `outside:${caller.name}` };
  }
  throw new OpFailure('refused', 'This caller can’t merge an agent’s branch.');
}

/** A merge, as `branch.merge` asks for it. */
export interface MergeRequest {
  canvas: CanvasId;
  /** Reached by the caller (core.call checks it, as for every op naming an agent). */
  agent: string;
  /** What the caller saw: the agent's branch and its tip, your checkout's branch and its commit. */
  source: { ref: string; oid: string };
  into: { ref: string; oid: string };
  /** What becomes of the agent's uncommitted work: required when it has some. */
  uncommitted?: { choice: 'leave' } | { choice: 'commit'; digest: string } | undefined;
  /** The request's id: a repeat of it by the same caller is answered with its first result. */
  request: string;
  caller: MergeCaller;
  /** Whether the caller still reaches the agent: asked again in the lane and before the install. */
  authorized?: (() => boolean) | undefined;
  /** The caller left: work before the point of no return stops, changing nothing. */
  signal?: AbortSignal | undefined;
}

/** What a merge answers once it settled. */
export type MergeResult =
  | {
      outcome: 'merged';
      /** The commit merged: the agent's tip, or its checkpoint. */
      source: string;
      /** Your branch, and its commit before and after (after: the merge commit). */
      into: { ref: string; before: string; after: string };
      mergeCommit: string;
      /** The checkpoint commit of the agent's uncommitted work, if one was made and merged. */
      checkpoint?: string;
      /**
       * False when the checkpoint couldn't be recorded on the agent's branch (it moved meanwhile):
       * its files keep the work, uncommitted. The operation maps this to checkpointRecorded: false.
       */
      recorded?: false;
    }
  | {
      outcome: 'already-merged';
      source: string;
      into: { ref: string; before: string; after: string };
    };

/** Where a fault test stops a merge (B9b Design §9.3's phases). */
export type MergePoint =
  /** In the lane, before step 2. */
  | 'admitted'
  /** Step 4 done: objects written, nothing recorded. */
  | 'prepared'
  /** Step 5 done: on disk, `installing`. */
  | 'recorded'
  /** Step 6 done, past the point of no return, immediately before the install. */
  | 'installing'
  /** Step 7 done: the install answered, nothing checked yet. */
  | 'installed'
  /** Step 8 done: `installed` on disk. */
  | 'verified'
  /** The checkpoint on the agent's branch, `published` on disk; its index not yet reset. */
  | 'published'
  /** Step 9 done, nothing settled. */
  | 'reset';

export interface MergeServiceDeps {
  git: GitRunner;
  workspaces: WorkspaceStore;
  journal: MergeJournal;
  /** The core's one provisioning queue: a merge takes its repository's lane. */
  queue: ProvisioningQueue;
  /** The workspace mutation gate: a checkpoint drains the agent's tree. */
  gate: Pick<WorkspaceGate, 'drain' | 'writers' | 'occupied' | 'hold'>;
  /** The canvas's picked project folder, as the core keeps it now (none: not chosen or restored). */
  projectRoot: (canvas: CanvasId) => TrustedPath | undefined;
  /** For a restart's reconciliation: the canvas's picked folder, restored or as memory keeps it. */
  pickedRoot: (canvas: CanvasId) => Promise<TrustedPath | undefined>;
  /** What setup copied into a workspace (`WorkspaceSetups.copied`): none if unknown. */
  copied: (workspace: string) => readonly string[] | undefined;
  /** Whether the core runs the canvas now. */
  running: (canvas: CanvasId) => boolean;
  /** Whether the agent is on the canvas's document now. */
  member: (canvas: CanvasId, agent: string) => boolean;
  /** What sentences call an agent. */
  nameOf: (canvas: CanvasId, agent: string) => string | undefined;
  /** The profile's folder of merge jobs' temporary indexes (merge-index.ts' `temporaryIndexes`). */
  indexes: string;
  /**
   * A merge into a canvas was admitted, recorded, settled, held or ended, or a restart looked at
   * one: its worktrees to publish again.
   */
  changed?: (canvas: CanvasId) => void;
  /**
   * The merge state of the canvas's cards read again at once (B9b C12, observe.ts' `now`): your
   * checkout and the agent's tree, after a merge that ran in its repository's lane, before it
   * answers, so the answer's receipt carries what it settled. Never holds the lane, and never the
   * answer past `observeWithinMs`.
   */
  observe?: (canvas: CanvasId, workspace: string) => Promise<void>;
  /** An observation exceeded its bound: publish this workspace as unknown before answering. */
  observationTimedOut?: (workspace: string) => void;
  /** Tests only: how long a merge's answer waits for its observation (OBSERVED_WITHIN_MS). */
  observeWithinMs?: number;
  /** Tests only: called at each point of §9.3 a fault test stops at. */
  fault?: (at: MergePoint, job: string) => Promise<void>;
}

/** How long a merge's answer waits for its cards' merge state to be read again, at most. */
export const OBSERVED_WITHIN_MS = 10_000;

/** corrallm's own identity: a checkpoint's author and committer (§9 C6). */
const CORRALLM: GitIdentity = { name: 'corrallm', email: 'noreply@corrallm.invalid' };
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CALLER_KEY = /^(?:you|token:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
/** How much a listing of your checkout may print (as C3's checks read it). */
const LISTING_BYTES = 64 * 1024 * 1024;
/** How many times the agent's index reset is tried, a moment apart, before a restart tries. */
const RESET_ATTEMPTS = 3;
const RESET_PAUSE_MS = 100;

const CLOSING =
  'corrallm is closing: the merge stopped before it changed anything, so nothing changed. Merge again once it is open again.';
const CANCELLED = 'The merge was cancelled before it changed anything: nothing changed.';
const RECONCILING = 'A merge of its branch is being finished: new work waits until it is done.';

/** A checkpoint's message: what it is, and who asked. */
function checkpointMessage(requester: string): string {
  return `corrallm: commit uncommitted work before merging\n\nCorrallm-Requested-By: ${requester}\n`;
}

/** The merge commit's message: Git's own subject, and who asked. */
function mergeMessage(source: string, branch: string, requester: string): string {
  const name = (ref: string) => ref.slice('refs/heads/'.length);
  return `Merge branch '${name(source)}' into ${name(branch)}\n\nCorrallm-Requested-By: ${requester}\n`;
}

/** What a held merge says, on its agent's card too: never "nothing changed". */
function heldSentence(branch: string): string {
  return `A merge into ${shown(branch)} was interrupted; your checkout may be partly merged: check git status there.`;
}

/**
 * What a merge left going on says on its agent's card once no one is finishing it (a restart
 * couldn't read your checkout): it holds merges into the repository until it is checked.
 */
function uncheckedSentence(branch: string): string {
  return `A merge into ${shown(branch)} was interrupted, and corrallm couldn’t check your checkout to finish it: merges into this repository wait until it can, as it next starts or before the next merge into it. Your checkout may be partly merged: check git status there.`;
}

/** A refusal as the operation's failure. */
function failure(refusal: MergeRefusal): OpFailure {
  return new OpFailure(refusal.code, refusal.sentence);
}

function refusing(refusal: MergeRefusal | undefined): void {
  if (refusal !== undefined) throw failure(refusal);
}

/** What the admission read, compared again in the lane and before the install. */
interface Admitted {
  workspace: string;
  generation: number;
  project: number | undefined;
}

/** What a merge in the lane has: its id, its request, who it names, what it was admitted on. */
interface Job {
  id: string;
  request: MergeRequest;
  name: string;
  admitted: Admitted;
  /** The SHA-256 of the request's arguments. */
  args: string;
}

/** What a destination shows, as a restart (or a refused install) reads it. */
type Seen =
  /** Your branch at its commit, HEAD on it, the index its tree, files clean: never installed. */
  | { kind: 'untouched'; orig: OrigHead }
  /** Your branch at M, HEAD on it, the index M's tree, files clean. */
  | { kind: 'installed'; orig: OrigHead }
  /** Your branch at its commit, the index exactly M's tree, files equal to it: Git stopped there. */
  | { kind: 'index-ahead' }
  /** Anything else: another commit, edits, a lock or an operation of another Git. */
  | { kind: 'other' };

export class MergeService {
  readonly #deps: MergeServiceDeps;
  /** The merges in a lane now, by job id: the workspace each is of. */
  readonly #jobs = new Map<string, { workspace: string; done: Promise<unknown> }>();
  /** The merges past their point of no return: what closing waits for. */
  readonly #installing = new Set<Promise<unknown>>();
  /** Merges left going on that a reconciliation is finishing now (or is about to), by job id. */
  readonly #finishing = new Set<string>();
  #closing = false;
  #reconciling: Promise<void> | undefined;

  constructor(deps: MergeServiceDeps) {
    this.#deps = deps;
  }

  /**
   * Merges the agent's branch into your picked checkout's branch (§9.3), answering once it
   * settled: `merged` or `already-merged`, or why not (the operation's error). A refusal before the
   * install changed nothing (unreachable objects aside); a merge that can't be shown to have
   * finished is `unavailable`, saying your checkout may be partly merged, never "nothing changed".
   */
  async merge(request: MergeRequest): Promise<OpResult<MergeResult>> {
    try {
      return { ok: true, value: await this.#merge(request) };
    } catch (error) {
      if (error instanceof OpFailure) {
        return { ok: false, error: { code: error.code, sentence: error.message } };
      }
      // Past the point of no return every failure is an OpFailure saying so: this one came before.
      console.error('A merge failed before it changed anything:', error);
      return {
        ok: false,
        error: {
          code: 'unavailable',
          sentence: 'corrallm couldn’t merge just now, so nothing changed: try again.',
        },
      };
    }
  }

  /**
   * Reconciles every merge a crash left going on, and every merged checkpoint whose agent's index
   * wasn't reset (§9 C8), once: after child recovery, each in its repository's lane (queued before
   * any other work there), the agent's tree's new work held until it is done. Merges wait for it.
   */
  reconcile(): Promise<void> {
    this.#reconciling ??= this.#reconcile();
    return this.#reconciling;
  }

  /**
   * What a workspace's merge is now, for its card (B9b C12): going on (admitted, waiting its turn,
   * running, or left going on by a crash and being finished), or held (yours alone: the sentence).
   * One left going on that no one is finishing (a restart couldn't read your checkout) is held
   * too, saying so: it holds merges into its repository until it is checked.
   */
  state(workspace: string): { job: 'merging' } | { job: 'held'; sentence: string } | undefined {
    if ([...this.#jobs.values()].some((one) => one.workspace === workspace)) {
      return { job: 'merging' };
    }
    const latest = this.#deps.journal.latest(workspace);
    if (latest?.outcome === null) {
      if (this.#reconciling === undefined || this.#finishing.has(latest.id)) {
        return { job: 'merging' };
      }
      return { job: 'held', sentence: uncheckedSentence(latest.intent.destination.branch) };
    }
    if (latest?.outcome === 'held') {
      return {
        job: 'held',
        sentence: latest.sentence ?? heldSentence(latest.intent.destination.branch),
      };
    }
    return undefined;
  }

  /**
   * The shutdown barrier: no merge is admitted from now on, one before its point of no return stops
   * at its next step changing nothing, and this resolves once every merge past it has settled (its
   * install is never killed to quit).
   */
  async close(): Promise<void> {
    this.#closing = true;
    await Promise.allSettled([...this.#installing]);
  }

  /** Resolves once every merge, and the restart's reconciliation, has settled or stopped. */
  async drained(): Promise<void> {
    await Promise.allSettled([
      ...[...this.#jobs.values()].map((job) => job.done),
      this.#reconciling ?? Promise.resolve(),
    ]);
  }

  async #merge(request: MergeRequest): Promise<MergeResult> {
    checkRequest(request);
    // A merge a crash left going on is reconciled first: never another into its repository before.
    await this.#reconciling?.catch(() => undefined);
    if (this.#closing) throw new OpFailure('unavailable', CLOSING);
    const { journal, workspaces, queue } = this.#deps;
    const { canvas, agent } = request;
    const name = this.#deps.nameOf(canvas, agent) ?? agent;
    const args = argsDigest({
      canvas,
      agent,
      source: request.source,
      into: request.into,
      uncommitted: request.uncommitted ?? null,
    });
    // A repeated request: answered from the journal, never run again.
    const kept = journal.byRequest(request.caller.key, request.request);
    if (kept !== undefined) return answered(kept, args, name);

    // Admission: the agent's workspace, as the store keeps it; no member of its tree writing.
    const binding = workspaces.binding(canvas, agent);
    const workspace = binding === undefined ? undefined : workspaces.worktree(binding.workspace);
    const repository =
      workspace === undefined ? undefined : workspaces.repository(workspace.repository);
    if (
      binding === undefined ||
      workspace === undefined ||
      repository === undefined ||
      !ACTIVE_STATES.includes(workspace.state)
    ) {
      throw new OpFailure(
        'unavailable',
        `${name} has no worktree of its own, so there is no branch to merge.`,
      );
    }
    ready(binding, workspace, name);
    await this.#noWriters(canvas, workspace.id, name);
    const admitted: Admitted = {
      workspace: workspace.id,
      generation: binding.generation,
      project: workspaces.canvasRepository(canvas)?.generation,
    };
    const job: Job = { id: randomUUID(), request, name, admitted, args };
    let done: Promise<MergeResult>;
    try {
      done = queue.run(repository.commonDir, () => this.#lane(job));
    } catch (error) {
      if (error instanceof QueueFull) throw busy();
      throw error;
    }
    this.#jobs.set(job.id, { workspace: workspace.id, done });
    // Its agents' cards say it merges from now (waiting its turn too) until it answers.
    this.#changed(canvas);
    try {
      const result = await done;
      await this.#observed(canvas, workspace.id);
      return result;
    } catch (error) {
      if (error instanceof QueueFull) throw busy();
      // A refusal in the lane read your checkout: what the cards say of it, read again too.
      await this.#observed(canvas, workspace.id);
      throw error;
    } finally {
      this.#jobs.delete(job.id);
      this.#changed(canvas);
    }
  }

  /**
   * The canvas's merge state read again at once (B9b C12) after a merge ran in its lane, outside
   * it: what the answer's receipt carries. Bounded, never failing the merge; none while closing.
   */
  async #observed(canvas: CanvasId, workspace: string): Promise<void> {
    const { observe } = this.#deps;
    if (observe === undefined || this.#closing) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const refreshed = await Promise.race([
        observe(canvas, workspace).then(
          () => true,
          (error: unknown) => {
            console.error('Could not read a merge’s cards again:', error);
            return true;
          },
        ),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => {
            resolve(false);
          }, this.#deps.observeWithinMs ?? OBSERVED_WITHIN_MS);
        }),
      ]);
      if (!refreshed) this.#deps.observationTimedOut?.(workspace);
    } catch (error) {
      console.error('Could not read a merge’s cards again:', error);
    } finally {
      clearTimeout(timer);
    }
  }

  /** In the repository's lane: the drain for a checkpoint, then the merge. */
  async #lane(job: Job): Promise<MergeResult> {
    const { canvas } = job.request;
    this.#stopping(job);
    // Another copy may have queued before the first one recorded its intent. The repository's
    // lane has now finished that call: answer it before reading the pins the first merge moved.
    const kept = this.#deps.journal.byRequest(job.request.caller.key, job.request.request);
    if (kept !== undefined) return answered(kept, job.args, job.name);
    // One a restart couldn't reconcile is tried again before any other merge into its repository.
    const repository = this.#deps.workspaces.worktree(job.admitted.workspace)?.repository;
    const open = repository === undefined ? undefined : this.#deps.journal.openIn(repository);
    if (open !== undefined) {
      this.#finishing.add(open.id);
      try {
        await this.#reconcileJob(open).catch(() => undefined);
      } finally {
        this.#finishing.delete(open.id);
        this.#changed(open.canvas);
      }
      if (repository !== undefined && this.#deps.journal.openIn(repository) !== undefined) {
        throw new OpFailure(
          'unavailable',
          'A merge into this repository was interrupted and corrallm couldn’t check your checkout yet: try again.',
        );
      }
    }
    const tree: TreeKey = `workspace:${job.admitted.workspace}`;
    if (job.request.uncommitted?.choice === 'commit') {
      const words: DrainWords = {
        refused: (writing) =>
          `Committing ${job.name}’s work on its branch needs its worktree still, and ${writing}: try again once idle.`,
        waits: `${job.name}’s work is being committed and merged: new work waits until it is done.`,
      };
      return this.#deps.gate.drain(canvas, [tree], () => this.#steps(job), words);
    }
    await this.#noWriters(canvas, job.admitted.workspace, job.name);
    return this.#steps(job);
  }

  /** §9.3's steps 2 to 10, in the lane. */
  async #steps(job: Job): Promise<MergeResult> {
    const { git, workspaces, journal } = this.#deps;
    const { request, name, id } = job;
    const { canvas, agent } = request;
    await this.#point('admitted', id);
    this.#stopping(job);

    // Step 2: the source, the destination, the clean check, the agent's uncommitted work.
    const selected = await selectSource({ git, workspaces }, { canvas, agent, name });
    if (!selected.ok) throw failure(selected.refusal);
    const source = selected.value;
    refusing(checkMergeable(source));
    refusing(checkSource(source, request.source));
    this.#revalidate(job, source);
    const picked = this.#deps.projectRoot(canvas);
    if (picked === undefined) {
      throw new OpFailure(
        'unavailable',
        'This canvas’s project folder isn’t open in corrallm now, so there is no branch to merge into.',
      );
    }
    const found = await findDestination(git, { picked, repository: source.repository });
    if (!found.ok) throw failure(found.refusal);
    const destination = found.value;
    refusing(checkInto(destination, request.into));
    for (const folder of new Set([picked, destination.root])) {
      if (await this.#deps.gate.occupied(`folder:${folder}`)) {
        throw new OpFailure(
          'unavailable',
          'An agent works in your checkout itself (the project folder), not a worktree of its own: merge once it no longer does.',
        );
      }
    }
    refusing(await checkClean(git, destination));
    const digest = await this.#uncommitted(job, source);
    const before = destination.oid;

    // Step 3: already merged.
    if (digest === null && (await this.#ancestor(destination, source.tip, before))) {
      return {
        outcome: 'already-merged',
        source: source.tip,
        into: { ref: destination.branch, before, after: before },
      };
    }

    // Step 4: prepared, writing only objects; everything read checked again first.
    this.#revalidate(job, source);
    this.#stopping(job);
    const checkpoint =
      digest === null ? null : await this.#checkpoint(job, source, destination.commonDir, digest);
    const merged = checkpoint ?? source.tip;
    const tree = await this.#mergeTree(job, source, destination, merged);
    const you = await identity(git, destination);
    const commit = await objects(destination.commonDir, () =>
      git.commitTree({
        cwd: destination.root,
        tree,
        parents: [before, merged],
        message: mergeMessage(source.ref, destination.branch, request.caller.requester),
        author: you.author,
        committer: you.committer,
        drivers: destination.drivers,
        merge: { drivers: destination.mergeDrivers },
      }),
    );
    refusing(
      await checkIncoming(git, destination, { from: before, to: commit, branch: source.ref }),
    );
    await this.#point('prepared', id);
    this.#stopping(job);

    // Step 5: ORIG_HEAD as it is, then the journal's row, on disk.
    const orig = await readOrigHead(git, destination).catch((error: unknown) => {
      throw failure(gitRefusal(error, 'read your checkout'));
    });
    if (orig.kind !== 'none' && orig.kind !== 'oid') {
      refusing(await checkOrigHead(git, destination));
      throw new OpFailure('unavailable', 'Git can’t read your checkout’s ORIG_HEAD as a ref.');
    }
    const intent: MergeIntent = {
      version: 1,
      args: job.args,
      requester: request.caller.requester,
      destination: {
        root: destination.root,
        gitDir: destination.gitDir,
        commonDir: destination.commonDir,
        identity: destination.identity,
        branch: destination.branch,
        oid: before,
      },
      merge: { tree, commit },
      source: {
        ref: source.ref,
        tip: source.tip,
        gitDir: source.gitDir,
        checkpoint,
        digest,
      },
      origHead: orig.kind === 'oid' ? orig.oid : null,
    };
    let recorded: MergeJob;
    try {
      recorded = await journal.write((j) =>
        j.record({
          id,
          canvas,
          agent,
          workspace: source.workspace.id,
          repository: source.repository.id,
          callerKey: request.caller.key,
          requestId: request.request,
          intent,
        }),
      );
    } catch (error) {
      if (error instanceof MergeJournalError && error.code === 'refused') {
        throw new OpFailure('conflict', 'That request recorded a merge already: send a new one.');
      }
      throw new OpFailure(
        'unavailable',
        'corrallm couldn’t record the merge before installing it, so nothing changed: try again.',
      );
    }
    this.#changed(canvas);
    await this.#point('recorded', id);

    // Step 6: the last check. A refusal from here settles the row: nothing changed.
    try {
      await this.#lastCheck(job, source, destination, intent);
      // Closing or the caller gone, asked with nothing awaited before the install begins below.
      this.#revalidate(job, source);
      this.#stopping(job);
    } catch (error) {
      const refused =
        error instanceof OpFailure
          ? error
          : new OpFailure(
              'unavailable',
              'corrallm couldn’t check your checkout before installing the merge, so nothing changed: try again.',
            );
      // What may pass (closing, a lock, Git failing) interrupted it; anything else refused it. A
      // repeat of its request after a restart is answered so, with this sentence.
      await this.#settle(recorded, {
        outcome: refused.code === 'unavailable' ? 'interrupted' : 'refused',
        sentence: refused.message,
      }).catch(() => undefined);
      throw refused;
    }

    // Step 7 on: past the point of no return. Quitting waits for it; it is never cancelled.
    const installing = this.#install(job, recorded, destination);
    this.#installing.add(installing);
    try {
      return await installing;
    } finally {
      this.#installing.delete(installing);
    }
  }

  /**
   * The agent's uncommitted work (§9 C2, C6): a choice required when it has some; `commit` only
   * the very work the caller reviewed (its digest). The digest to commit, or null for none.
   */
  async #uncommitted(job: Job, source: MergeSource): Promise<string | null> {
    const choice = job.request.uncommitted;
    if (choice?.choice === 'leave') return null;
    const read = await inventoryUncommitted(this.#deps.git, {
      cwd: source.cwd,
      tip: source.tip,
      drivers: source.drivers,
      copied: this.#deps.copied(source.workspace.id) ?? null,
    });
    if (!read.ok) throw failure(read.refusal);
    const count = read.value.changed + read.value.untracked;
    if (choice === undefined) {
      if (count === 0) return null;
      throw new OpFailure(
        'refused',
        `${job.name}’s worktree has ${String(count)} uncommitted file${count === 1 ? '' : 's'}: choose to commit ${count === 1 ? 'it' : 'them'} on its branch first, or to merge its commits without ${count === 1 ? 'it' : 'them'}.`,
      );
    }
    if (count === 0) {
      throw new OpFailure(
        'conflict',
        `${job.name} has no uncommitted work now: review its changes again.`,
      );
    }
    if (read.value.digest === null) {
      throw new OpFailure(
        'conflict',
        `corrallm can’t commit ${job.name}’s uncommitted work as Review changes shows it: commit it yourself, or merge its commits without it.`,
      );
    }
    if (read.value.digest !== choice.digest) {
      throw new OpFailure(
        'conflict',
        `${job.name}’s uncommitted work changed since you looked: review it again.`,
      );
    }
    return read.value.digest;
  }

  /**
   * The checkpoint (§9 C6): the agent's work committed by corrallm on its tip, in a temporary index
   * of the core's (its own index untouched), bound to the digest the caller reviewed. Unpublished:
   * only objects are written.
   */
  async #checkpoint(
    job: Job,
    source: MergeSource,
    commonDir: string,
    digest: string,
  ): Promise<string> {
    const { git, indexes } = this.#deps;
    const index = makeTemporaryIndex(indexes, job.id);
    try {
      const call = (args: string[]): Promise<{ stdout: string }> =>
        objects(commonDir, () =>
          git.run({
            cwd: source.cwd,
            drivers: source.drivers,
            merge: { drivers: source.mergeDrivers },
            index,
            // Never a shared index of a split one written beside the agent's Git directory.
            config: ['core.splitIndex=false'],
            args,
          }),
        );
      await call(['read-tree', source.tip]);
      await call(['add', '-A']);
      const tree = (await call(['write-tree'])).stdout.trim();
      if (!OID.test(tree))
        throw new OpFailure('unavailable', 'Git couldn’t write its work’s tree.');
      const committed = await treeDigest(
        git,
        { cwd: source.cwd, drivers: source.drivers },
        { tip: source.tip, tree },
      );
      if (committed !== digest) {
        throw new OpFailure(
          'conflict',
          `${job.name}’s uncommitted work changed since you looked: review it again.`,
        );
      }
      return await objects(commonDir, () =>
        git.commitTree({
          cwd: source.cwd,
          tree,
          parents: [source.tip],
          message: checkpointMessage(job.request.caller.requester),
          author: CORRALLM,
          committer: CORRALLM,
          drivers: source.drivers,
          merge: { drivers: source.mergeDrivers },
        }),
      );
    } catch (error) {
      if (error instanceof OpFailure) throw error;
      throw failure(gitRefusal(error, `commit ${job.name}’s work`));
    } finally {
      removeTemporaryIndex(indexes, job.id);
    }
  }

  /** `merge-tree` of your branch's commit and `merged`, in your checkout (§9 C7): its tree. */
  async #mergeTree(
    job: Job,
    source: MergeSource,
    destination: MergeDestination,
    merged: string,
  ): Promise<string> {
    const { git } = this.#deps;
    const branch = job.request.source.ref;
    try {
      const base = await git.run({
        ...reading(destination),
        args: ['merge-base', destination.oid, merged],
        answers: [1],
      });
      if (base.code === 1) {
        throw new OpFailure(
          'refused',
          `${job.name}’s branch and ${shown(destination.branch)} share no history, so corrallm doesn’t merge them.`,
        );
      }
      this.#revalidate(job, source);
      this.#stopping(job);
      const result = await objects(destination.commonDir, () =>
        git.run({
          cwd: destination.root,
          drivers: destination.drivers,
          merge: { drivers: destination.mergeDrivers },
          maxBytes: LISTING_BYTES,
          args: [
            'merge-tree',
            '--write-tree',
            '--name-only',
            '-z',
            '--no-messages',
            destination.oid,
            merged,
          ],
          answers: [1],
        }),
      );
      const [tree = '', ...rest] = result.stdout.split('\0');
      if (result.code === 1) {
        const conflicted = [...new Set(rest.filter((one) => one !== ''))];
        throw new OpFailure(
          'conflict',
          `${branchPathSentence(
            `${job.name}’s branch and ${shown(destination.branch)} conflict`,
            conflicted.slice(0, 5),
            conflicted.length,
          )} Nothing was merged: resolve it in ${job.name}’s worktree, or merge it yourself (git merge --no-ff ${shown(branch)}).`,
        );
      }
      if (!OID.test(tree)) throw new GitError('failed', 'git merge-tree answered no tree.');
      return tree;
    } catch (error) {
      if (error instanceof OpFailure) throw error;
      if (error instanceof GitError && error.fault === 'failed') {
        throw new OpFailure(
          'refused',
          `Git couldn’t merge ${job.name}’s branch without a program corrallm doesn’t run (a custom merge driver) or an object your repository lacks. Nothing was merged: merge it yourself in your checkout (git merge --no-ff ${shown(branch)}).`,
        );
      }
      throw failure(gitRefusal(error, 'compute the merge'));
    }
  }

  /** Step 6, the last check before the install: your checkout and the agent's branch as pinned. */
  async #lastCheck(
    job: Job,
    source: MergeSource,
    destination: MergeDestination,
    intent: MergeIntent,
  ): Promise<void> {
    const { git } = this.#deps;
    this.#stopping(job);
    this.#revalidate(job, source);
    const picked = this.#deps.projectRoot(job.request.canvas);
    if (picked === undefined) {
      throw new OpFailure(
        'unavailable',
        'This canvas’s project folder isn’t open in corrallm now.',
      );
    }
    const again = await findDestination(git, { picked, repository: source.repository });
    if (!again.ok) throw failure(again.refusal);
    const now = again.value;
    if (
      now.root !== destination.root ||
      now.gitDir !== destination.gitDir ||
      now.commonDir !== destination.commonDir ||
      now.identity !== destination.identity
    ) {
      throw new OpFailure(
        'conflict',
        'Your project folder is another checkout now: review the changes again.',
      );
    }
    refusing(checkInto(now, { ref: destination.branch, oid: destination.oid }));
    refusing(await checkClean(git, now));
    const orig = await readOrigHead(git, now);
    const recorded = intent.origHead;
    if (
      !(orig.kind === 'none' && recorded === null) &&
      !(orig.kind === 'oid' && orig.oid === recorded)
    ) {
      throw new OpFailure(
        'unavailable',
        'Your checkout’s ORIG_HEAD changed as the merge was prepared: merge again.',
      );
    }
    refusing(await checkOrigHead(git, now));
    if (intent.source.checkpoint !== null) {
      const at = await branchTip(git, source.cwd, source.drivers, source.ref);
      if (at !== source.tip) {
        throw new OpFailure(
          'conflict',
          `${job.name}’s work changed since you looked: review it again.`,
        );
      }
    }
    // The metadata the install writes through, checked as it will be after.
    try {
      verifyMergeWrites(destination.commonDir, writesOf(destination));
    } catch (error) {
      throw metadataRefusal(error);
    }
    this.#stopping(job);
  }

  /**
   * Steps 7 to 10, past the point of no return: never cancelled, never "nothing changed" but where
   * Git refused before writing. Anything unexpected is held, or, once your checkout was checked to
   * be the merge, said to be in your checkout though unrecorded.
   */
  async #install(
    job: Job,
    recorded: MergeJob,
    destination: MergeDestination,
  ): Promise<MergeResult> {
    const checked = { verified: false };
    try {
      return await this.#pastNoReturn(job, recorded, destination, checked);
    } catch (error) {
      if (error instanceof OpFailure) throw error;
      console.error('A merge failed past its point of no return:', error);
      if (checked.verified) throw this.#unrecorded(job, destination.branch);
      return this.#held(recorded);
    }
  }

  async #pastNoReturn(
    job: Job,
    recorded: MergeJob,
    destination: MergeDestination,
    checked: { verified: boolean },
  ): Promise<MergeResult> {
    const { git } = this.#deps;
    const { intent } = recorded;
    const m = intent.merge.commit;
    const before = intent.destination.oid;
    await this.#point('installing', job.id);
    let failed: unknown;
    try {
      await git.install({
        cwd: destination.root,
        commit: m,
        drivers: destination.drivers,
        merge: { drivers: destination.mergeDrivers },
      });
    } catch (error) {
      failed = error;
    }
    // Its metadata checked after it, a failed one too.
    let linked = false;
    try {
      verifyMergeWrites(destination.commonDir, writesOf(destination));
    } catch {
      linked = true;
    }
    if (failed !== undefined) {
      // Git refusing before writing anything but ORIG_HEAD: put back, nothing changed. Git ended by
      // its bound, or anything that can't be shown untouched: held.
      if (
        !linked &&
        failed instanceof GitError &&
        failed.fault !== 'timeout' &&
        failed.fault !== 'output'
      ) {
        const named = new Set(inTheWay(failed.stderr));
        const seen = await this.#observe(destination, intent, named).catch(() => undefined);
        if (seen?.kind === 'untouched') {
          const restored = await this.#restoreOrigHead(destination, intent, seen.orig).catch(
            () => false,
          );
          if (restored) {
            const sentence = gitRefused(failed.stderr);
            await this.#settle(recorded, { outcome: 'refused', sentence }).catch(() => undefined);
            throw new OpFailure('refused', sentence);
          }
        }
      }
      return this.#held(recorded);
    }
    if (linked) return this.#held(recorded);
    await this.#point('installed', job.id);

    // Step 8: your checkout is the merge, as Git wrote it.
    const seen = await this.#observe(destination, intent).catch(() => undefined);
    if (seen?.kind !== 'installed' || seen.orig.kind !== 'oid' || seen.orig.oid !== before) {
      return this.#held(recorded);
    }
    checked.verified = true;
    let installed: MergeJob;
    try {
      installed = await this.#deps.journal.write((j) =>
        j.advance(recorded.id, { from: 'installing', to: 'installed' }),
      );
    } catch {
      throw this.#unrecorded(job, destination.branch);
    }
    await this.#point('verified', job.id);

    // Step 9: the checkpoint on the agent's branch, its index reset. One that failed part way is
    // what the agent's branch shows now, its index left for the next start.
    const published = await this.#publish(installed).catch(async (error: unknown) => {
      console.error('Could not finish publishing a merge’s checkpoint:', error);
      const now = await this.#branchNow(installed).catch(() => null);
      return { job: installed, recorded: now === intent.source.checkpoint, reset: false };
    });
    await this.#point('reset', job.id);

    // Step 10: settled on disk, then answered.
    const notRecorded =
      intent.source.checkpoint !== null && !published.recorded
        ? `${job.name}’s uncommitted work was merged, but its branch had moved, so it wasn’t recorded on it: its files keep it, uncommitted.`
        : null;
    try {
      await this.#deps.journal.write((j) =>
        j.settle(recorded.id, {
          outcome: 'merged',
          phase: published.recorded && !published.reset ? 'published' : 'done',
          sentence: notRecorded,
        }),
      );
    } catch {
      throw this.#unrecorded(job, destination.branch);
    }
    this.#changed(job.request.canvas);
    return resultOf(intent, notRecorded === null);
  }

  /**
   * Publishes a merged job's checkpoint on the agent's branch, and resets its index to it (§9.3
   * step 9; a restart's finishing): only while the branch is still at its tip (or at the checkpoint
   * already), a ref of its own in the verified checkout; its index only while that checkout is on
   * the branch. Never writes a file of the agent's.
   */
  async #publish(job: MergeJob): Promise<{ job: MergeJob; recorded: boolean; reset: boolean }> {
    const { git, workspaces, journal } = this.#deps;
    const { checkpoint, tip, ref, gitDir } = job.intent.source;
    if (checkpoint === null) return { job, recorded: true, reset: true };
    const workspace = workspaces.worktree(job.workspace);
    const repository = workspaces.repository(job.repository);
    if (workspace === undefined || repository === undefined) {
      return { job, recorded: false, reset: false };
    }
    const verified = await verifiedCheckout(git, repository, workspace);
    if (!verified.ok || verified.checkout.gitDir !== gitDir) {
      return { job, recorded: false, reset: false };
    }
    const cwd = verified.cwd;
    const inspected = await git.inspect(cwd);
    if (inspected.refusals.length > 0) return { job, recorded: false, reset: false };
    const drivers = inspected.drivers;
    const symbolic = await git.run({
      cwd,
      drivers,
      args: ['symbolic-ref', '--quiet', '--no-recurse', ref],
      answers: [1],
    });
    if (symbolic.code === 0) return { job, recorded: false, reset: false };
    let at = await branchTip(git, cwd, drivers, ref);
    let linked = false;
    // Published already (a restart finishing its index): never moved again.
    if (job.phase !== 'published' && at === tip) {
      const writes: MergeWrites = { branch: ref, checkout: gitDir };
      verifyMergeWrites(repository.commonDir, writes);
      try {
        await git.run({
          cwd,
          drivers,
          args: [
            'update-ref',
            '--no-deref',
            '-m',
            'corrallm: commit uncommitted work before merging',
            ref,
            checkpoint,
            tip,
          ],
        });
      } catch (error) {
        // Refused: it moved meanwhile. What it is now says which.
        if (!(error instanceof GitError) || error.fault !== 'failed') throw error;
      }
      try {
        verifyMergeWrites(repository.commonDir, writes);
      } catch {
        linked = true;
      }
      at = await branchTip(git, cwd, drivers, ref);
    }
    if (at !== checkpoint) {
      // Moved on: by its own commits (never recorded), or past the checkpoint once published.
      return { job, recorded: job.phase === 'published', reset: true };
    }
    let published = job;
    if (job.outcome === null && job.phase !== 'published') {
      published = await journal.write((j) =>
        j.advance(job.id, { from: job.phase, to: 'published' }),
      );
    }
    // Its metadata not all its own after the write: recorded, its index left for the next start's
    // checks.
    if (linked) return { job: published, recorded: true, reset: false };
    await this.#point('published', job.id);
    const head = await git.run({
      cwd,
      drivers,
      args: ['symbolic-ref', '--quiet', '--no-recurse', 'HEAD'],
      answers: [1],
    });
    // Off its branch (it switched since): its index is another branch's, never reset.
    if (head.code !== 0 || head.stdout.trim() !== ref) {
      return { job: published, recorded: true, reset: true };
    }
    for (let attempt = 1; attempt <= RESET_ATTEMPTS; attempt++) {
      const writes: MergeWrites = { checkout: gitDir };
      try {
        verifyMergeWrites(repository.commonDir, writes);
        await git.run({
          cwd,
          drivers,
          config: ['core.splitIndex=false'],
          args: ['read-tree', '--reset', checkpoint],
        });
        verifyMergeWrites(repository.commonDir, writes);
        return { job: published, recorded: true, reset: true };
      } catch {
        // The agent's own Git holding its index, say: tried again a moment later, else at restart.
        if (attempt < RESET_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, RESET_PAUSE_MS));
        }
      }
    }
    return { job: published, recorded: true, reset: false };
  }

  /** The agent's branch's tip now, in its verified checkout: null if it can't be read so. */
  async #branchNow(job: MergeJob): Promise<string | null> {
    const { git, workspaces } = this.#deps;
    const workspace = workspaces.worktree(job.workspace);
    const repository = workspaces.repository(job.repository);
    if (workspace === undefined || repository === undefined) return null;
    const verified = await verifiedCheckout(git, repository, workspace);
    if (!verified.ok) return null;
    const { drivers } = await git.inspect(verified.cwd);
    return branchTip(git, verified.cwd, drivers, job.intent.source.ref);
  }

  /** Settles a job held: your checkout may be partly merged. Answers unavailable, saying so. */
  async #held(job: MergeJob): Promise<never> {
    const sentence = heldSentence(job.intent.destination.branch);
    // One the journal can't settle stays going on: the next start finds it by your checkout.
    await this.#settle(job, { outcome: 'held', sentence }).catch(() => undefined);
    throw new OpFailure('unavailable', sentence);
  }

  /** A merge installed that the journal couldn't record: true, and finished at the next start. */
  #unrecorded(job: Job, branch: string): OpFailure {
    return new OpFailure(
      'unavailable',
      `${job.name}’s branch was merged into ${shown(branch)}, and the merge is in your checkout, but corrallm couldn’t record it: it will as it next starts.`,
    );
  }

  async #settle(
    job: MergeJob,
    settled: {
      outcome: 'merged' | 'refused' | 'interrupted' | 'held';
      phase?: MergePhase;
      sentence?: string | null;
    },
  ): Promise<MergeJob> {
    const done = await this.#deps.journal.write((j) => j.settle(job.id, settled));
    this.#changed(job.canvas);
    return done;
  }

  /** A canvas's merges changed: its worktrees published again. Never fails the merge itself. */
  #changed(canvas: CanvasId): void {
    try {
      this.#deps.changed?.(canvas);
    } catch (error) {
      console.error('Could not publish a merge’s change:', error);
    }
  }

  /** An untouched checkout needs either its recorded ORIG_HEAD already, or a successful restore. */
  async #restoreOrigHead(
    destination: MergeDestination,
    intent: MergeIntent,
    orig: OrigHead,
  ): Promise<boolean> {
    if (
      (orig.kind === 'none' && intent.origHead === null) ||
      (orig.kind === 'oid' && orig.oid === intent.origHead)
    ) {
      return true;
    }
    return (
      (await restoreOrigHead(this.#deps.git, destination, {
        recorded: intent.origHead,
        wrote: intent.destination.oid,
      })) === 'restored'
    );
  }

  /**
   * What your checkout shows of a merge (a restart's reconciliation, a refused install, the
   * postconditions), read writing nothing and taking no lock. `named`: untracked files Git named
   * in its way as it refused, there before it ran, which don't stop it reading as untouched.
   */
  async #observe(
    destination: MergeDestination,
    intent: MergeIntent,
    named: ReadonlySet<string> = new Set(),
  ): Promise<Seen> {
    const { git } = this.#deps;
    const before = intent.destination.oid;
    const m = intent.merge.commit;
    if (anotherGit(destination) !== undefined) return { kind: 'other' };
    const read = (args: string[]) => git.run({ ...reading(destination), args, answers: [1] });
    const head = await read(['symbolic-ref', '--quiet', '--no-recurse', 'HEAD']);
    if (head.code !== 0 || head.stdout.trim() !== destination.branch) return { kind: 'other' };
    if ((await read(['symbolic-ref', '--quiet', '--no-recurse', destination.branch])).code === 0) {
      return { kind: 'other' };
    }
    const at = await branchTip(git, destination.root, destination.drivers, destination.branch);
    const orig = await readOrigHead(git, destination);
    if (orig.kind === 'symbolic' || orig.kind === 'unreadable') return { kind: 'other' };
    const index = await git.run({
      ...reading(destination),
      maxBytes: LISTING_BYTES,
      args: ['ls-files', '-v', '-z'],
    });
    if (hiddenEntries(index.stdout).length > 0) return { kind: 'other' };
    const status = await git.run({
      ...reading(destination),
      maxBytes: LISTING_BYTES,
      args: [
        '--no-optional-locks',
        'status',
        '--porcelain=v2',
        '-z',
        '--untracked-files=all',
        '--ignore-submodules=dirty',
      ],
    });
    if (status.stderr.trim() !== '') return { kind: 'other' };
    const entries = statusEntries(status.stdout);
    const indexIs = async (oid: string) =>
      (
        await read([
          '--no-optional-locks',
          'diff-index',
          '--cached',
          '--quiet',
          '--ignore-submodules=none',
          oid,
        ])
      ).code === 0;
    if (entries.length === 0 && at === m && (await indexIs(m))) return { kind: 'installed', orig };
    if (
      at === before &&
      entries.every((entry) => entry.kind === '?' && named.has(entry.path)) &&
      (await indexIs(before))
    ) {
      return { kind: 'untouched', orig };
    }
    if (
      at === before &&
      entries.every((entry) => (entry.kind === '1' || entry.kind === '2') && entry.xy[1] === '.') &&
      (await indexIs(m))
    ) {
      return { kind: 'index-ahead' };
    }
    return { kind: 'other' };
  }

  /** Whether `tip` is in the history of `oid` (`merge-base --is-ancestor`). */
  async #ancestor(destination: MergeDestination, tip: string, oid: string): Promise<boolean> {
    try {
      const asked = await this.#deps.git.run({
        ...reading(destination),
        args: ['merge-base', '--is-ancestor', tip, oid],
        answers: [1],
      });
      return asked.code === 0;
    } catch (error) {
      throw failure(gitRefusal(error, 'read your branch’s history'));
    }
  }

  /** Everything the admission read, as it is now: or the operation's failure. */
  #revalidate(job: Job, source: MergeSource): void {
    const { workspaces } = this.#deps;
    const { canvas, agent, authorized } = job.request;
    if (!this.#deps.running(canvas)) {
      throw new OpFailure(
        'unavailable',
        'This canvas isn’t open in corrallm now: open it, then merge again.',
      );
    }
    if (!this.#deps.member(canvas, agent) || (authorized !== undefined && !authorized())) {
      throw new OpFailure('not-found', `There is no agent ${agent}.`);
    }
    const binding = workspaces.binding(canvas, agent);
    const workspace = binding === undefined ? undefined : workspaces.worktree(binding.workspace);
    if (
      binding === undefined ||
      workspace === undefined ||
      binding.workspace !== job.admitted.workspace ||
      binding.generation !== job.admitted.generation ||
      source.workspace.id !== job.admitted.workspace
    ) {
      throw new OpFailure(
        'conflict',
        `${job.name}’s worktree changed since you looked: review its changes again.`,
      );
    }
    ready(binding, workspace, job.name);
    if (workspaces.canvasRepository(canvas)?.generation !== job.admitted.project) {
      throw new OpFailure(
        'conflict',
        'This canvas’s project folder changed since you looked: review the changes again.',
      );
    }
  }

  /** Refused while any member of the agent's tree may be writing there, holding nothing. */
  async #noWriters(canvas: CanvasId, workspace: string, name: string): Promise<void> {
    const found = await this.#deps.gate.writers(canvas, [`workspace:${workspace}`]);
    if (found.busy) {
      throw new OpFailure(
        'unavailable',
        `${name}’s worktree is being changed just now: try again once that is done.`,
      );
    }
    if (found.writing.length > 0) {
      throw new OpFailure(
        'unavailable',
        `Merging takes ${name}’s branch as it is, and ${andList(found.writing)}: try again once ${found.writing.length === 1 ? 'it is' : 'they are'} idle.`,
      );
    }
  }

  /** Before the point of no return: refused, changing nothing, once closing or the caller left. */
  #stopping(job: Job): void {
    if (this.#closing) throw new OpFailure('unavailable', CLOSING);
    if (job.request.signal?.aborted === true) throw new OpFailure('unavailable', CANCELLED);
  }

  async #point(at: MergePoint, job: string): Promise<void> {
    await this.#deps.fault?.(at, job);
  }

  async #reconcile(): Promise<void> {
    const { journal, gate, queue, workspaces } = this.#deps;
    this.#removeLeftovers();
    const jobs = [...journal.open(), ...journal.resetsPending()];
    // Held at once, before anyone could start work in the agent's tree; each card says it is being
    // finished until it is.
    const releases = jobs.map((job) => gate.hold([`workspace:${job.workspace}`], RECONCILING));
    for (const job of jobs) this.#finishing.add(job.id);
    await Promise.all(
      jobs.map(async (job, at) => {
        try {
          const lane =
            workspaces.repository(job.repository)?.commonDir ?? job.intent.destination.commonDir;
          await queue.run(lane, () => this.#reconcileJob(job));
        } catch (error) {
          console.error('Could not finish a merge a crash interrupted:', error);
        } finally {
          releases[at]?.();
          this.#finishing.delete(job.id);
          // Settled, or left going on (held until checked): its card says which.
          this.#changed(job.canvas);
        }
      }),
    );
  }

  /**
   * A merge left going on, or a merged checkpoint whose agent's index wasn't reset, as a restart
   * finds it (§9 C8's table). Left going on, to be tried again, only where your checkout couldn't
   * be read at all.
   */
  async #reconcileJob(kept: MergeJob): Promise<void> {
    const { journal, git } = this.#deps;
    const job = journal.job(kept.id);
    if (job === undefined) return;
    if (job.outcome === 'merged' && job.phase === 'published') {
      const done = await this.#publish(job);
      if (done.reset || !done.recorded) {
        await journal.write((j) => j.finishReset(job.id));
      }
      return;
    }
    if (job.outcome !== null) return;
    const { intent } = job;
    const picked = await this.#deps.pickedRoot(job.canvas);
    if (picked === undefined) return;
    const found = await discoverRepository(git, picked);
    // Git or the folder unavailable just now (a disk not mounted, say): tried again later.
    if (
      found.kind === 'refused' &&
      ['git-missing', 'git-failed', 'missing', 'inaccessible'].includes(found.reason)
    ) {
      return;
    }
    if (
      found.kind !== 'repository' ||
      found.repository.realRoot !== intent.destination.root ||
      found.repository.gitDir !== intent.destination.gitDir ||
      found.repository.commonDir !== intent.destination.commonDir ||
      found.repository.identity !== intent.destination.identity
    ) {
      await this.#settle(job, {
        outcome: 'held',
        sentence: heldSentence(intent.destination.branch),
      });
      return;
    }
    const inspected = await git.inspect(found.repository.realRoot);
    const destination: MergeDestination = {
      repository: job.repository,
      identity: found.repository.identity,
      root: found.repository.realRoot,
      gitDir: found.repository.gitDir,
      commonDir: found.repository.commonDir,
      branch: intent.destination.branch,
      oid: intent.destination.oid,
      drivers: inspected.drivers,
      mergeDrivers: inspected.mergeDrivers,
      ignoreCase: false,
    };
    const seen =
      inspected.refusals.length > 0
        ? ({ kind: 'other' } as const)
        : await this.#observe(destination, intent);
    if (seen.kind === 'untouched') {
      if (!(await this.#restoreOrigHead(destination, intent, seen.orig))) {
        await this.#settle(job, {
          outcome: 'held',
          sentence: heldSentence(intent.destination.branch),
        });
        return;
      }
      const name = this.#deps.nameOf(job.canvas, job.agent) ?? job.agent;
      await this.#settle(job, {
        outcome: 'interrupted',
        sentence: `The merge of ${name}’s branch into ${shown(intent.destination.branch)} was interrupted before it changed anything: nothing changed. Merge again.`,
      });
      return;
    }
    if (seen.kind === 'other') {
      await this.#settle(job, {
        outcome: 'held',
        sentence: heldSentence(intent.destination.branch),
      });
      return;
    }
    if (seen.kind === 'index-ahead') {
      // Git stopped between your index and your branch: the branch moved to M, as Git would have.
      const writes = writesOf(destination);
      verifyMergeWrites(destination.commonDir, writes);
      try {
        await git.run({
          cwd: destination.root,
          drivers: destination.drivers,
          args: [
            'update-ref',
            '--no-deref',
            '-m',
            'corrallm: finish an interrupted merge',
            destination.branch,
            intent.merge.commit,
            intent.destination.oid,
          ],
        });
      } finally {
        verifyMergeWrites(destination.commonDir, writes);
      }
      if ((await this.#observe(destination, intent)).kind !== 'installed') {
        await this.#settle(job, {
          outcome: 'held',
          sentence: heldSentence(intent.destination.branch),
        });
        return;
      }
    }
    const installed =
      job.phase === 'installing'
        ? await journal.write((j) => j.advance(job.id, { from: 'installing', to: 'installed' }))
        : job;
    const published = await this.#publish(installed).catch(() => ({
      job: installed,
      recorded: false,
      reset: false,
    }));
    const name = this.#deps.nameOf(job.canvas, job.agent) ?? job.agent;
    await this.#settle(published.job, {
      outcome: 'merged',
      phase: published.recorded && !published.reset ? 'published' : 'done',
      sentence:
        intent.source.checkpoint !== null && !published.recorded
          ? `${name}’s uncommitted work was merged, but its branch had moved, so it wasn’t recorded on it: its files keep it, uncommitted.`
          : null,
    });
  }

  /** Temporary indexes a crash left behind: no job uses one as the core starts. */
  #removeLeftovers(): void {
    const { indexes } = this.#deps;
    let names: string[];
    try {
      if (!lstatSync(indexes).isDirectory()) return;
      names = readdirSync(indexes);
    } catch {
      return;
    }
    for (const name of names) {
      try {
        removeTemporaryIndex(indexes, name);
      } catch (error) {
        console.error(
          `Could not remove a merge’s temporary index (${path.join(indexes, name)}):`,
          error,
        );
      }
    }
  }
}

/** A repeated request, answered from the journal as its first call settled. */
function answered(job: MergeJob, args: string, name: string): MergeResult {
  if (job.intent.args !== args) {
    throw new OpFailure('conflict', 'That request id was used for another merge: send a new one.');
  }
  switch (job.outcome) {
    case 'merged':
      return resultOf(job.intent, job.sentence === null);
    case null:
      throw new OpFailure(
        'unavailable',
        `That merge of ${name}’s branch is still being finished: ask again in a moment.`,
      );
    case 'refused':
      throw new OpFailure('refused', job.sentence ?? 'That merge was refused: nothing changed.');
    case 'interrupted':
    case 'held':
    case 'superseded':
      throw new OpFailure(
        'unavailable',
        job.sentence ?? heldSentence(job.intent.destination.branch),
      );
  }
}

/** A merged job's answer. */
function resultOf(intent: MergeIntent, recorded: boolean): MergeResult {
  const { checkpoint, tip } = intent.source;
  return {
    outcome: 'merged',
    source: checkpoint ?? tip,
    into: {
      ref: intent.destination.branch,
      before: intent.destination.oid,
      after: intent.merge.commit,
    },
    mergeCommit: intent.merge.commit,
    ...(checkpoint === null ? {} : { checkpoint }),
    ...(checkpoint !== null && !recorded ? { recorded: false as const } : {}),
  };
}

/** The request's shape, as the service takes it (X2's schema checks it whole first). */
function checkRequest(request: MergeRequest): void {
  const { source, into, uncommitted, caller } = request;
  if (
    !UUID.test(request.request) ||
    typeof request.agent !== 'string' ||
    request.agent === '' ||
    !OID.test(source.oid) ||
    !OID.test(into.oid) ||
    source.oid.length !== into.oid.length ||
    typeof source.ref !== 'string' ||
    typeof into.ref !== 'string' ||
    (uncommitted?.choice === 'commit' && !/^[0-9a-f]{64}$/.test(uncommitted.digest)) ||
    !CALLER_KEY.test(caller.key) ||
    !REQUESTER.test(caller.requester)
  ) {
    throw new OpFailure('invalid', 'That isn’t a merge request corrallm can take.');
  }
}

/** Refused unless the agent's workspace is ready with no change waiting (as `checkMergeable`). */
function ready(binding: AgentBinding, workspace: WorktreeRecord, name: string): void {
  if (binding.desired !== null) {
    throw new OpFailure(
      'unavailable',
      `${name}’s move to another worktree waits for your Switch: merge once it’s switched or cancelled.`,
    );
  }
  if (workspace.state !== 'ready') {
    const why =
      workspace.state === 'creating'
        ? 'is still being made'
        : workspace.state === 'setup'
          ? 'is being set up: merge once it’s ready'
          : workspace.state === 'missing'
            ? 'is missing'
            : 'failed: retry it first';
    throw new OpFailure('unavailable', `${name}’s worktree ${why}.`);
  }
}

function busy(): OpFailure {
  return new OpFailure(
    'unavailable',
    'Too many worktree jobs are waiting just now: merge again in a moment.',
  );
}

/** A read in your checkout: its filter drivers blanked, replace refs ignored, the merge's bound. */
function reading(
  destination: MergeDestination,
): Pick<GitCall, 'cwd' | 'drivers' | 'noReplaceObjects' | 'timeoutMs' | 'config'> {
  return {
    cwd: destination.root,
    drivers: destination.drivers,
    noReplaceObjects: true,
    timeoutMs: MERGE_TIMEOUT_MS,
    // Full stat checks and no order file, whatever the repository says (as C3's reads).
    config: WORKTREE_READ_CONFIG,
  };
}

/** What the install (and a restart's finishing) writes through in your checkout's Git directories. */
function writesOf(destination: MergeDestination): MergeWrites {
  return { checkout: destination.gitDir, branch: destination.branch };
}

/**
 * Runs `write` (which writes objects only, before the point of no return) with the object store
 * checked before it and after it, a failed one too.
 */
async function objects<T>(commonDir: string, write: () => Promise<T>): Promise<T> {
  const check = () => {
    try {
      verifyMergeWrites(commonDir, { objects: true });
    } catch (error) {
      throw metadataRefusal(error);
    }
  };
  check();
  let written: T;
  try {
    written = await write();
  } catch (error) {
    check();
    throw error;
  }
  check();
  return written;
}

/**
 * A Git directory a merge's write would go through that isn't the user's own (a link, another
 * user's): refused, its kind said, never its path.
 */
function metadataRefusal(error: unknown): OpFailure {
  if (error instanceof OpFailure) return error;
  if (!(error instanceof GitMetadataError)) throw error;
  return new OpFailure(
    'refused',
    `Your repository’s Git directory isn’t all its own where a merge writes (${error.code}), so corrallm doesn’t merge there.`,
  );
}

/** A branch's tip as a ref of its own, or null if it is gone or isn't a commit. */
async function branchTip(
  git: GitRunner,
  cwd: string,
  drivers: readonly string[],
  ref: string,
): Promise<string | null> {
  const { code, stdout } = await git.run({
    cwd,
    drivers,
    noReplaceObjects: true,
    args: ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`],
    answers: [1],
  });
  const oid = stdout.trim();
  return code === 0 && OID.test(oid) ? oid : null;
}

/**
 * Your Git identity as Git resolves it in your checkout (`git var` with `user.useConfigOnly`, so
 * none is invented): the merge commit's author and committer (§8, question 2).
 */
async function identity(
  git: GitRunner,
  destination: MergeDestination,
): Promise<{ author: GitIdentity; committer: GitIdentity }> {
  const one = async (which: string): Promise<GitIdentity> => {
    try {
      const { stdout } = await git.run({
        cwd: destination.root,
        drivers: destination.drivers,
        config: ['user.useConfigOnly=true'],
        args: ['var', which],
      });
      const found = /^(.+) <([^<>\n]*)> \d+ [+-]\d{4}\n?$/.exec(stdout);
      if (found?.[1] === undefined || found[2] === undefined || found[2] === '') {
        throw new GitError('failed', 'No identity.');
      }
      return { name: found[1], email: found[2] };
    } catch (error) {
      if (error instanceof GitError && error.fault === 'failed') {
        throw new OpFailure(
          'refused',
          'Set your Git name and email for this repository (git config user.name and user.email), then merge again.',
        );
      }
      throw failure(gitRefusal(error, 'read your Git identity'));
    }
  };
  return { author: await one('GIT_AUTHOR_IDENT'), committer: await one('GIT_COMMITTER_IDENT') };
}

/**
 * The files of yours Git named in its way as it refused the fast-forward (under `LC_ALL=C`): found
 * before it wrote anything, so they were there before it ran.
 */
function inTheWay(stderr: string): string[] {
  const lines = stderr.split('\n');
  const names: string[] = [];
  let listing = false;
  for (const line of lines) {
    if (/would be (?:overwritten|removed) by merge/.test(line)) listing = true;
    else if (listing && line.startsWith('\t')) names.push(line.slice(1));
    else listing = false;
  }
  return names;
}

/** Git refusing the fast-forward, saying which files of yours are in its way if it named them. */
function gitRefused(stderr: string): string {
  const names = inTheWay(stderr);
  const reason = 'Git refused to install the merge: a file of yours is in its way';
  return `${names.length > 0 ? branchPathSentence(reason, names.slice(0, 5), names.length) : `${reason}.`} Move it aside, then merge again. Nothing changed.`;
}
