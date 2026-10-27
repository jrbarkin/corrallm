import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { lstatSync, readdirSync } from 'node:fs';
import type { Stats } from 'node:fs';
import path from 'node:path';

import type { CanvasId } from '../../../shared/canvas';
import type { WorkspaceOwnerKey } from '../../../shared/model/workspaces';
import type { TrustedPath } from '../host';
import { checkCheckout, verifiedCheckout } from './checkout';
import type { CheckoutFault } from './checkout';
import { discoverRepository, realOrNone, recordRepository, registrations } from './discovery';
import type { Discovery, DiscoveryRefusal, FoundRepository, Registration } from './discovery';
import { GitError } from './git';
import type { GitCall, GitRunner } from './git';
import { GitMetadataError, verifyGitMetadata } from './metadata';
import { OwnedRootError, PROFILE_ID, ensureOwnedRoot, excludeOwnedRoot } from './owned';
import { ProvisioningQueue, QueueFull } from './queue';
import { WorkspaceStoreError } from './store';
import type { JobRecord, Json, RepositoryRecord, WorkspaceStore, WorktreeRecord } from './store';

/*
 * Provisioning (B9a Design §3, Provisioning protocol): making a workspace's checkout, reusing it
 * for every start of its owner, and finishing on restart what a crash cut short.
 *
 * 1. The intent comes first, within a write (`intend`, a participant a document commit's write can
 *    call too): the workspace `creating`, its generated checkout path and branch, its base (the
 *    picked checkout's HEAD, or the committed HEAD of the workspace it forks, read by `base`
 *    before the write), and a `create` job whose immutable intent hash makes a retry of it the
 *    same job. No Git, no file is touched in that write.
 * 2. Then, outside SQL, in the repository's lane of the bounded queue (`run`), the job's phases,
 *    each marked on disk once done: `branch` (its ref made at the base commit, only if it didn't
 *    exist: never forced over one), `registered` (a worktree added without a checkout), and
 *    `populated` (its files read from the base commit's tree, into a checkout holding nothing but
 *    its `.git`, by a merge Git won't write over a file with). Before each, what Git and the file
 *    system actually have is read again, so a phase done but not recorded is adopted, never done
 *    twice, and nothing is made over a folder or branch the core didn't make. A population done but
 *    not recorded may have been changed while the core was stopped: it is adopted only if it is
 *    exactly what Git wrote (`#untouched`), else held for you (`interrupted-population`).
 * 3. Verified as every later use verifies it (checkout.ts), the workspace moves to `setup`: copying
 *    local files and running its setup are setup's (C9, C10), and its agents wait until then.
 *
 * A failure the job can name ends it `failed` and the workspace in `error`, saying why; one it
 * can't (the core closing, its store failing) leaves the job open for the next start. On restart
 * (`reconcile`, after child recovery), every open job is run again from what is on disk, and every
 * checkout in use is checked: one gone is `missing`, one changed `error`. Nothing here ever
 * populates a checkout again over what is there, nor resets, removes or prunes a checkout or
 * branch: that is cleanup's (C7).
 */

/** A create job's phases, in order, each marked once it is done. */
export const CREATE_PHASES = ['recorded', 'branch', 'registered', 'populated'] as const;
export type CreatePhase = (typeof CREATE_PHASES)[number];

/** How long adding a worktree may take, and populating one. */
const ADD_TIMEOUT_MS = 60_000;
const POPULATE_TIMEOUT_MS = 10 * 60_000;
/** How much of a checkout's index is read when proving a population untouched. */
const MAX_INDEX_BYTES = 64 * 1024 * 1024;

/** Why a workspace wasn't provisioned, before anything was recorded or run for it. */
export type ProvisionErrorCode =
  'busy' | 'not-found' | 'not-git' | 'repository-changed' | 'fork' | DiscoveryRefusal;

export class ProvisionError extends Error {
  readonly code: ProvisionErrorCode;
  constructor(code: ProvisionErrorCode, message: string) {
    super(message);
    this.name = 'ProvisionError';
    this.code = code;
  }
}

/** The commit a workspace starts from, and the checkout and branch it was captured from. */
export interface Base {
  checkout: string;
  ref: string | null;
  oid: string;
}

/** A workspace to be made: for `owner` of the canvas, of its repository, from `base`. */
export interface Intent {
  canvas: CanvasId;
  repository: RepositoryRecord;
  owner: WorkspaceOwnerKey;
  base: Base;
  forkedFrom?: string | null;
}

export interface Intended {
  worktree: WorktreeRecord;
  /** Its create job going on, if one does. */
  job: JobRecord | undefined;
  /** Whether this intent made it, rather than finding the owner's. */
  created: boolean;
}

/** A workspace's checkout for its agents: its verified path, or why there is none now. */
export type Checkout =
  | { state: 'setup' | 'ready'; cwd: TrustedPath; worktree: WorktreeRecord; branch: string | null }
  | {
      state: 'held';
      reason: 'creating' | 'missing' | 'error' | 'retained' | 'removing';
      worktree: WorktreeRecord;
      fault?: CheckoutFault;
    };

export type RepositoryFound =
  | { kind: 'repository'; record: RepositoryRecord; found: FoundRepository }
  | Exclude<Discovery, { kind: 'repository' }>;

export interface ProvisionerDeps {
  workspaces: WorkspaceStore;
  git: GitRunner;
  /** This profile's id (profile.ts): in new workspaces' branches and their owned root. */
  profile: string;
  queue?: ProvisioningQueue;
  ids?: () => string;
  /** Hears whenever a workspace of the canvas may have changed state. */
  changed?: (canvas: CanvasId) => void;
}

/** A failure the job records: its workspace in error, saying why. */
class Failed extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export class Provisioner {
  readonly #workspaces: WorkspaceStore;
  readonly #git: GitRunner;
  readonly #profile: string;
  readonly #queue: ProvisioningQueue;
  readonly #ids: () => string;
  readonly #changed: (canvas: CanvasId) => void;
  /** What is in flight, so that concurrent asks share it: by owner, job and workspace. */
  readonly #provisions = new Map<string, Promise<WorktreeRecord>>();
  readonly #runs = new Map<string, Promise<WorktreeRecord>>();
  readonly #retries = new Map<
    string,
    Promise<{ tree: WorktreeRecord; done: Promise<WorktreeRecord> }>
  >();

  constructor(deps: ProvisionerDeps) {
    if (!PROFILE_ID.test(deps.profile)) throw new TypeError('That isn’t a profile’s id.');
    this.#workspaces = deps.workspaces;
    this.#git = deps.git;
    this.#profile = deps.profile;
    this.#queue = deps.queue ?? new ProvisioningQueue();
    this.#ids = deps.ids ?? randomUUID;
    this.#changed = deps.changed ?? (() => undefined);
  }

  /** Discovers the repository a picked folder is, and keeps it (none: why not). */
  async repository(picked: string): Promise<RepositoryFound> {
    const discovery = await discoverRepository(this.#git, picked);
    if (discovery.kind !== 'repository') return discovery;
    const found = discovery.repository;
    const record = await this.#workspaces.write((w) =>
      recordRepository(w, found, { profile: this.#profile, id: this.#ids() }),
    );
    return { kind: 'repository', record, found };
  }

  /**
   * Within a write: records the intent to make a workspace for the owner, unless it has one in use
   * already, which it returns. Synchronous, touching no repository: `run` its job after the write.
   */
  intend(workspaces: WorkspaceStore, intent: Intent): Intended {
    const repository = workspaces.repository(intent.repository.id);
    if (repository === undefined) {
      throw new ProvisionError('not-found', `There is no repository ${intent.repository.id}.`);
    }
    const active = workspaces.activeWorktree(intent.canvas, repository.id, intent.owner);
    if (active !== undefined) {
      return { worktree: active, job: workspaces.openJob(active.id, 'create'), created: false };
    }
    const id = this.#ids();
    const worktree = workspaces.createWorktree({
      id,
      canvas: intent.canvas,
      repository: repository.id,
      owner: intent.owner,
      path: path.join(repository.ownedRoot, id),
      branchRef: `refs/heads/corrallm/${this.#profile}/${id}`,
      baseCheckout: intent.base.checkout,
      baseRef: intent.base.ref,
      baseOid: intent.base.oid,
      forkedFrom: intent.forkedFrom ?? null,
    });
    const job = workspaces.recordJob(createJob(worktree, repository, 1));
    return { worktree, job, created: true };
  }

  /**
   * The owner's workspace: the one it has, or one made now from the picked checkout's HEAD (or
   * `base`, or forked `from` a workspace: its committed HEAD, as `base` reads it), once its job is
   * done. Concurrent asks for one owner share one; the result may be in `error`, saying why.
   * Refused before anything is recorded when the queue is full, the repository isn't the one
   * recorded any more, or the base can't be read.
   */
  provision(request: {
    canvas: CanvasId;
    repository: RepositoryRecord;
    owner: WorkspaceOwnerKey;
    base?: Base;
    /** The workspace a new one forks (the plan's source: planner.ts' `forkSource`). */
    from?: WorktreeRecord | undefined;
    forkedFrom?: string | null;
    /** Composition records the owner's initial bindings in the intent's write, before Git. */
    within?: (workspaces: WorkspaceStore, tree: WorktreeRecord) => void;
  }): Promise<WorktreeRecord> {
    const key = `${request.canvas}\0${request.repository.id}\0${request.owner}`;
    const going = this.#provisions.get(key);
    if (going !== undefined) return going;
    const made = this.#provision(request).finally(() => this.#provisions.delete(key));
    this.#provisions.set(key, made);
    return made;
  }

  async #provision(request: Parameters<Provisioner['provision']>[0]): Promise<WorktreeRecord> {
    const active = this.#workspaces.activeWorktree(
      request.canvas,
      request.repository.id,
      request.owner,
    );
    if (active !== undefined) {
      if (request.within !== undefined)
        await this.#workspaces.write((w) => {
          request.within?.(w, active);
        });
      return this.#resume(active);
    }
    if (this.#queue.full) throw busy();
    const base = request.base ?? (await this.base(request.repository, request.from));
    const { worktree, job, created } = await this.#workspaces.write((w) => {
      const intended = this.intend(w, {
        canvas: request.canvas,
        repository: request.repository,
        owner: request.owner,
        base,
        forkedFrom: request.forkedFrom ?? request.from?.id ?? null,
      });
      request.within?.(w, intended.worktree);
      return intended;
    });
    if (created) this.#changed(worktree.canvas);
    return job === undefined ? worktree : this.run(job.id);
  }

  #resume(tree: WorktreeRecord): Promise<WorktreeRecord> {
    if (tree.state !== 'creating') return Promise.resolve(tree);
    const job = this.#workspaces.openJob(tree.id, 'create');
    return job === undefined ? Promise.resolve(tree) : this.run(job.id);
  }

  /**
   * Outside any write: the commit a new workspace is to start from, as Git says now (B9a Design
   * §3). The picked checkout's HEAD; or, forked `from` a workspace, that workspace's committed
   * HEAD: the commit its verified checkout is at, and the branch checked out there, never its
   * uncommitted files. One never made (still `creating`, or its creation failed) is at the base it
   * was to be made from: nothing ran there. Rejects (ProvisionError), recording nothing, if that
   * can't be read: an unknown HEAD is never taken for the project's.
   */
  async base(repository: RepositoryRecord, from?: WorktreeRecord): Promise<Base> {
    if (from === undefined) return this.#base(repository);
    if (from.repository !== repository.id) {
      throw new ProvisionError('repository-changed', 'The worktree it forks is another project’s.');
    }
    const made = this.#workspaces
      .jobsOf(from.id)
      .some((job) => job.kind === 'create' && job.outcome === 'done');
    if (from.state === 'creating' || !made) {
      return { checkout: from.baseCheckout, ref: from.baseRef, oid: from.baseOid };
    }
    const checked = await checkCheckout(this.#git, repository, from);
    if (!checked.ok || checked.checkout.head === null) {
      throw new ProvisionError(
        'fork',
        `The worktree a new one would fork can’t be read now (${checked.ok ? 'no commit' : checked.fault}): try again once it is back.`,
      );
    }
    const { path: checkout, branch: ref, head: oid } = checked.checkout;
    return { checkout, ref, oid };
  }

  /** The picked checkout's HEAD now, if it is still the repository recorded. */
  async #base(repository: RepositoryRecord): Promise<Base> {
    const discovery = await discoverRepository(this.#git, repository.pickedRoot);
    if (discovery.kind === 'not-git') {
      throw new ProvisionError('not-git', 'The project folder isn’t a Git repository any more.');
    }
    if (discovery.kind === 'refused') {
      throw new ProvisionError(discovery.reason, discovery.sentence);
    }
    const found = discovery.repository;
    if (!sameRepository(found, repository, repository.identity)) {
      throw new ProvisionError(
        'repository-changed',
        'The project folder is another repository now: choose it again.',
      );
    }
    return { checkout: found.realRoot, ref: found.head.ref, oid: found.head.oid };
  }

  /** Runs a create job, in its repository's lane; the workspace as it ends. Shared while it runs. */
  run(jobId: string): Promise<WorktreeRecord> {
    const going = this.#runs.get(jobId);
    if (going !== undefined) return going;
    const job = this.#workspaces.job(jobId);
    const tree = job === undefined ? undefined : this.#workspaces.worktree(job.workspace);
    const repository =
      tree === undefined ? undefined : this.#workspaces.repository(tree.repository);
    if (job === undefined || tree === undefined || repository === undefined) {
      return Promise.reject(new ProvisionError('not-found', `There is no job ${jobId}.`));
    }
    if (job.outcome !== null) return Promise.resolve(tree);
    const running = this.#queue
      .run(repository.commonDir, () => this.#create(jobId))
      .catch((error: unknown) => {
        throw error instanceof QueueFull ? busy() : error;
      })
      .finally(() => this.#runs.delete(jobId));
    this.#runs.set(jobId, running);
    return running;
  }

  async #create(jobId: string): Promise<WorktreeRecord> {
    const job = this.#workspaces.job(jobId);
    const tree = job === undefined ? undefined : this.#workspaces.worktree(job.workspace);
    const repository =
      tree === undefined ? undefined : this.#workspaces.repository(tree.repository);
    if (job === undefined || tree === undefined || repository === undefined) {
      throw new ProvisionError('not-found', `There is no job ${jobId}.`);
    }
    if (job.outcome !== null) return tree;
    if (tree.state !== 'creating') {
      // Kept or being removed meanwhile: it is no longer to be made.
      await this.#workspaces.write((w) => w.finishJob(jobId, 'superseded'));
      return tree;
    }
    let ended: WorktreeRecord;
    try {
      if (!sameIntent(job.payload, tree)) {
        throw new Failed('intent-mismatch', 'The job isn’t the workspace’s as it was recorded.');
      }
      await this.#make(job, tree, repository);
      ended = await this.#workspaces.write((w) => {
        w.finishJob(jobId, 'done');
        return w.transition(tree.id, { from: 'creating', to: 'setup' });
      });
    } catch (error) {
      const code = failureCode(metadataCause(error, repository, tree));
      // The core stopping, or its store failing: the job stays open, finished at the next start.
      if (code === undefined) throw error;
      ended = await this.#workspaces.write((w) => {
        w.finishJob(jobId, 'failed');
        return w.transition(tree.id, { from: 'creating', to: 'error', errorCode: code });
      });
    }
    this.#changed(ended.canvas);
    return ended;
  }

  /** The job's phases from where it is, each read again from Git first and marked once done. */
  async #make(
    recorded: JobRecord,
    tree: WorktreeRecord,
    repository: RepositoryRecord,
  ): Promise<void> {
    let job = recorded;
    const git = this.#git;
    // The repository is still the one recorded, as Git and the file system say now.
    const discovery = await discoverRepository(git, repository.pickedRoot);
    if (discovery.kind !== 'repository') {
      throw new Failed(
        discovery.kind === 'not-git' ? 'repository-changed' : `repository-${discovery.reason}`,
        discovery.kind === 'not-git' ? 'It isn’t a repository any more.' : discovery.sentence,
      );
    }
    const found = discovery.repository;
    if (!sameRepository(found, repository, job.expectedIdentity ?? repository.identity)) {
      throw new Failed('repository-changed', 'The project folder is another repository now.');
    }
    if (path.dirname(tree.path) !== repository.ownedRoot || path.basename(tree.path) !== tree.id) {
      throw new Failed('checkout-changed', 'Its path isn’t its folder of the owned root.');
    }
    // Git's metadata its branch and registration are written through (metadata.ts): checked
    // before anything at all is written, then again at each of Git's writes, before and after it.
    const metadata = (registration?: string) => {
      verifyGitMetadata(repository.commonDir, {
        branch: tree.branchRef,
        ...(registration === undefined ? {} : { registration }),
      });
    };
    metadata();
    // Its owned root made or verified, and kept out of the checkout, before anything is written.
    ensureOwnedRoot(repository);
    excludeOwnedRoot(repository.commonDir);
    const oid = tree.baseOid;

    if (phase(job) < phase('registered')) {
      const registration = await this.#registration(repository, tree.path, found.drivers);
      if (registration === undefined) {
        const folder = folderAt(tree.path);
        if (folder === 'other')
          throw new Failed('checkout-changed', `${tree.path} isn’t a folder.`);
        if (folder === 'full') {
          throw new Failed('unregistered-checkout', `${tree.path} has files the core didn’t make.`);
        }
        const at = await this.#branchAt(repository, tree.branchRef, found.drivers);
        if (at === undefined) {
          // Made only if it doesn't exist (the empty old value): never forced over another.
          metadata();
          await git.run({
            cwd: repository.realRoot,
            drivers: found.drivers,
            args: [
              'update-ref',
              '--no-deref',
              '-m',
              `corrallm: workspace ${tree.id}`,
              '--end-of-options',
              tree.branchRef,
              oid,
              '',
            ],
          });
          metadata();
        } else if (at !== oid) {
          throw new Failed('branch-moved', `${tree.branchRef} is at another commit already.`);
        }
        job = await this.#reach(job, 'branch');
        ensureOwnedRoot(repository);
        metadata();
        await git.run({
          cwd: repository.realRoot,
          drivers: found.drivers,
          timeoutMs: ADD_TIMEOUT_MS,
          args: [
            'worktree',
            'add',
            '--quiet',
            '--no-checkout',
            '--end-of-options',
            tree.path,
            tree.branchRef.slice('refs/heads/'.length),
          ],
        });
        metadata();
      } else if (registration.branch !== tree.branchRef) {
        throw new Failed('checkout-changed', 'Its registration is on another branch.');
      } else if (registration.locked !== null) {
        // Git stopped part way through adding it: what it left is for review, not adoption.
        throw new Failed('interrupted-registration', 'Git didn’t finish registering it.');
      }
      job = await this.#reach(job, 'registered');
    }

    // Before its files are written: Git's configuration as it reads it there (conditional
    // includes on its branch and folder included) neutralized, and the checkout the one registered.
    metadata();
    const local = await git.inspect(tree.path);
    if (local.refusals.length > 0) throw new Failed('config', local.refusals.join(' '));
    const before = await checkCheckout(git, repository, tree);
    if (!before.ok) throw new Failed(before.fault, before.detail);
    if (before.checkout.branch !== tree.branchRef) {
      throw new Failed('checkout-changed', 'It is on another branch.');
    }
    if (phase(job) < phase('populated')) {
      if (before.checkout.head !== oid) {
        throw new Failed('branch-moved', `${tree.branchRef} moved before it was checked out.`);
      }
      const drivers = [...new Set([...found.drivers, ...local.drivers])];
      if (onlyGitIn(tree.path)) {
        // Nothing written there yet: its files read from the base commit's tree. A merge, not a
        // reset, so Git refuses to write over any file it finds there (one put there meanwhile).
        metadata(path.basename(before.checkout.gitDir));
        await git.run({
          cwd: tree.path,
          drivers,
          timeoutMs: POPULATE_TIMEOUT_MS,
          args: ['read-tree', '-m', '-u', '--no-recurse-submodules', oid],
        });
      } else if (!(await this.#untouched(tree.path, before.checkout.gitDir, oid, drivers))) {
        // A population ran, but the core stopped before marking it: anyone may have worked there
        // since. Never populated again over it; held, its files as they are, for you.
        throw new Failed(
          'interrupted-population',
          'Its files were being written when corrallm stopped, and may have changed since: they are kept as they are.',
        );
      }
      await this.#reach(job, 'populated');
    }
    const after = await checkCheckout(git, repository, tree);
    if (!after.ok) throw new Failed(after.fault, after.detail);
    metadata(path.basename(after.checkout.gitDir));
  }

  /**
   * Whether a checkout a population wrote (its mark lost to a crash) is exactly what it wrote, as
   * Git and the file system say now, writing nothing: Git's index whole (no lock beside it) and the
   * base commit's tree, no entry of it marked to be skipped or assumed unchanged, every file as the
   * index has it (compared by content wherever its stat differs, whatever the repository says of
   * ctime and stat), nothing else there (ignored files included), and each submodule's folder
   * empty, as population leaves it. What can't be read proves nothing.
   */
  async #untouched(
    at: string,
    gitDir: string,
    oid: string,
    drivers: readonly string[],
  ): Promise<boolean> {
    if (lstatOrNone(path.join(gitDir, 'index.lock')) !== undefined) return false;
    if (lstatOrNone(path.join(gitDir, 'index'))?.isFile() !== true) return false;
    const git = this.#git;
    const read = (args: readonly string[], more: Partial<GitCall> = {}) =>
      git.run({ cwd: at, drivers, timeoutMs: POPULATE_TIMEOUT_MS, answers: [1], ...more, args });
    try {
      const cached = await read([
        'diff-index',
        '--cached',
        '--quiet',
        '--ignore-submodules=none',
        '--end-of-options',
        oid,
      ]);
      if (cached.code !== 0) return false;
      const listed = await read(['ls-files', '-z', '--stage', '-v'], { maxBytes: MAX_INDEX_BYTES });
      if (listed.code !== 0) return false;
      const gitlinks: string[] = [];
      for (const field of listed.stdout.split('\0')) {
        if (field === '') continue;
        const entry = /^(\S) (\d{6}) [0-9a-f]+ \d\t(.+)$/s.exec(field);
        if (entry?.[1] !== 'H') return false;
        if (entry[2] === '160000' && entry[3] !== undefined) gitlinks.push(entry[3]);
      }
      const files = await read(['diff-files', '--quiet', '--ignore-submodules=all'], {
        config: ['core.checkStat=default', 'core.trustctime=true', 'core.ignoreStat=false'],
      });
      if (files.code !== 0) return false;
      const others = await read(['ls-files', '-z', '--others', '--directory']);
      if (others.code !== 0 || others.stdout !== '') return false;
      return gitlinks.every((name) => emptyFolderAt(at, name));
    } catch (error) {
      if (error instanceof GitError && (error.fault === 'failed' || error.fault === 'output')) {
        return false;
      }
      throw error;
    }
  }

  async #registration(
    repository: RepositoryRecord,
    at: string,
    drivers: readonly string[],
  ): Promise<Registration | undefined> {
    const { stdout } = await this.#git.run({
      cwd: repository.realRoot,
      drivers,
      args: ['worktree', 'list', '--porcelain', '-z'],
    });
    return registrations(stdout).find(
      (entry) => !entry.bare && (entry.path === at || realOrNone(entry.path) === at),
    );
  }

  /** The commit a branch is at; none if it doesn't exist. Matched exactly, by its full name. */
  async #branchAt(
    repository: RepositoryRecord,
    ref: string,
    drivers: readonly string[],
  ): Promise<string | undefined> {
    const { stdout } = await this.#git.run({
      cwd: repository.realRoot,
      drivers,
      args: ['for-each-ref', '--format=%(refname)%00%(objectname)', '--end-of-options', ref],
    });
    for (const line of stdout.split('\n')) {
      const [name, oid] = line.split('\0');
      if (name === ref) return oid;
    }
    return undefined;
  }

  async #reach(job: JobRecord, to: CreatePhase): Promise<JobRecord> {
    if (phase(job) >= phase(to)) return job;
    return this.#workspaces.write((w) => w.advanceJob(job.id, { from: job.phase, to }));
  }

  /**
   * As the core starts, after its children's recovery: runs every open create job again from what
   * is on disk, then checks every checkout in use, so a lost one is `missing` before it is asked
   * for. A job it can't run now (the queue full, the store failing) is left open.
   */
  async reconcile(): Promise<void> {
    const jobs = this.#workspaces.openJobs().filter((job) => job.kind === 'create');
    const results = await Promise.allSettled(jobs.map((job) => this.run(job.id)));
    for (const result of results) {
      if (result.status === 'rejected') {
        console.warn('A workspace couldn’t be made yet:', result.reason);
      }
    }
    for (const tree of this.#workspaces.worktreesIn(['setup', 'ready'])) await this.#check(tree);
  }

  /** The workspace's verified checkout for its agents, or why there is none. */
  async checkout(workspace: string): Promise<Checkout> {
    const tree = this.#workspaces.worktree(workspace);
    if (tree === undefined)
      throw new ProvisionError('not-found', `There is no workspace ${workspace}.`);
    if (tree.state === 'setup' || tree.state === 'ready') return this.#check(tree);
    return { state: 'held', reason: tree.state, worktree: tree };
  }

  async #check(tree: WorktreeRecord): Promise<Checkout> {
    const repository = this.#workspaces.repository(tree.repository);
    if (repository === undefined) {
      throw new ProvisionError('not-found', `There is no repository ${tree.repository}.`);
    }
    const verified = await verifiedCheckout(this.#git, repository, tree);
    if (verified.ok && (tree.state === 'setup' || tree.state === 'ready')) {
      return {
        state: tree.state,
        cwd: verified.cwd,
        worktree: tree,
        branch: verified.checkout.branch,
      };
    }
    if (verified.ok) return { state: 'held', reason: 'error', worktree: tree };
    // Git couldn't say: unknown, so not handed out, but nothing recorded of it.
    if (verified.fault === 'git-failed') {
      return { state: 'held', reason: 'error', worktree: tree, fault: verified.fault };
    }
    const to =
      verified.fault === 'checkout-missing' || verified.fault === 'repository-missing'
        ? 'missing'
        : 'error';
    let now: WorktreeRecord;
    try {
      now = await this.#workspaces.write((w) =>
        w.transition(tree.id, { from: ['setup', 'ready'], to, errorCode: verified.fault }),
      );
      this.#changed(tree.canvas);
    } catch (error) {
      if (!(error instanceof WorkspaceStoreError && error.code === 'stale')) throw error;
      now = this.#workspaces.worktree(tree.id) ?? tree;
    }
    return { state: 'held', reason: to, worktree: now, fault: verified.fault };
  }

  /**
   * Tries a workspace in `error` or `missing` again: a creation that failed runs again, a new
   * attempt of the same intent, from what Git has; one made, then lost or changed, is back where it
   * was (at a new generation: what ran in it before is stale) once its checkout is found again as
   * it was made. Never makes a checkout over one that is gone for good: that stays missing.
   */
  retry(workspace: string): Promise<WorktreeRecord> {
    return this.startRetry(workspace).then(({ done }) => done);
  }

  /**
   * Starts `retry` (worktree.retry's, which answers without waiting for a checkout to be made):
   * resolves once the retry is recorded (a new attempt of a creation on disk, `creating`; one lost
   * and found again back where it was), with the workspace then (`tree`) and what the retry ends
   * with (`done`, which runs on: making a checkout again takes its repository's turn in the queue).
   * Asked again while it goes on, it is the same retry. Rejects as `retry` would before anything is
   * recorded (busy, not-found).
   */
  startRetry(workspace: string): Promise<{ tree: WorktreeRecord; done: Promise<WorktreeRecord> }> {
    const going = this.#retries.get(workspace);
    if (going !== undefined) return going;
    const started = this.#retry(workspace);
    this.#retries.set(workspace, started);
    const forget = () => {
      if (this.#retries.get(workspace) === started) this.#retries.delete(workspace);
    };
    // Forgotten as it ends, before anyone it was handed to hears so: asked again then, it is anew.
    started.then(({ done }) => {
      done.then(forget, forget);
    }, forget);
    return started;
  }

  async #retry(
    workspace: string,
  ): Promise<{ tree: WorktreeRecord; done: Promise<WorktreeRecord> }> {
    const tree = this.#workspaces.worktree(workspace);
    const repository =
      tree === undefined ? undefined : this.#workspaces.repository(tree.repository);
    if (tree === undefined || repository === undefined) {
      throw new ProvisionError('not-found', `There is no workspace ${workspace}.`);
    }
    const as = (now: WorktreeRecord) => ({ tree: now, done: Promise.resolve(now) });
    if (tree.state === 'creating') return { tree, done: this.#resume(tree) };
    if (tree.state !== 'error' && tree.state !== 'missing') return as(tree);
    const creates = this.#workspaces.jobsOf(workspace).filter((job) => job.kind === 'create');
    if (!creates.some((job) => job.outcome === 'done')) {
      if (this.#queue.full) throw busy();
      const job = await this.#workspaces.write((w) => {
        const now = w.worktree(workspace) ?? tree;
        if (now.state === 'creating') return w.openJob(workspace, 'create');
        w.transition(workspace, { from: ['error', 'missing'], to: 'creating' });
        return w.recordJob(createJob(now, repository, creates.length + 1));
      });
      this.#changed(tree.canvas);
      const now = this.#workspaces.worktree(workspace) ?? tree;
      return job === undefined ? as(now) : { tree: now, done: this.run(job.id) };
    }
    const checked = await checkCheckout(this.#git, repository, tree);
    if (!checked.ok) return as(tree);
    const setup = this.#workspaces.setup(workspace);
    const to = setup?.state === 'done' || setup?.state === 'skipped' ? 'ready' : 'setup';
    const back = await this.#workspaces.write((w) => {
      w.transition(workspace, { from: tree.state, to });
      return w.advance(workspace);
    });
    this.#changed(tree.canvas);
    return as(back);
  }
}

function busy(): ProvisionError {
  return new ProvisionError('busy', 'Too many workspaces are being made at once: try again soon.');
}

/** A create job: its id made from the workspace and attempt, so the same retry is the same job. */
function createJob(tree: WorktreeRecord, repository: RepositoryRecord, attempt: number) {
  const hash = createHash('sha256')
    .update(`corrallm create ${tree.id} ${String(attempt)}`)
    .digest('hex');
  return {
    id: [
      hash.slice(0, 8),
      hash.slice(8, 12),
      hash.slice(12, 16),
      hash.slice(16, 20),
      hash.slice(20, 32),
    ].join('-'),
    workspace: tree.id,
    kind: 'create' as const,
    phase: 'recorded',
    generation: tree.generation,
    expectedIdentity: repository.identity,
    payload: intentOf(tree, attempt),
  };
}

/** What a create job is to make: never its progress, which its phase says. */
function intentOf(tree: WorktreeRecord, attempt: number): Json {
  return {
    canvas: tree.canvas,
    repository: tree.repository,
    path: tree.path,
    branch: tree.branchRef,
    base: { checkout: tree.baseCheckout, ref: tree.baseRef, oid: tree.baseOid },
    forkedFrom: tree.forkedFrom,
    attempt,
  };
}

function sameIntent(payload: Json, tree: WorktreeRecord): boolean {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const attempt = (payload as Readonly<Record<string, Json>>).attempt;
  return (
    typeof attempt === 'number' &&
    JSON.stringify(canonical(payload)) === JSON.stringify(canonical(intentOf(tree, attempt)))
  );
}

function canonical(value: Json): Json {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

function sameRepository(
  found: FoundRepository,
  repository: RepositoryRecord,
  identity: string,
): boolean {
  return (
    found.realRoot === repository.realRoot &&
    found.commonDir === repository.commonDir &&
    found.identity === identity
  );
}

function phase(job: JobRecord | CreatePhase): number {
  const at = typeof job === 'string' ? job : job.phase;
  const index = (CREATE_PHASES as readonly string[]).indexOf(at);
  if (index < 0) throw new Failed('intent-mismatch', `${at} isn’t a create job’s phase.`);
  return index;
}

function lstatOrNone(at: string): Stats | undefined {
  try {
    return lstatSync(at);
  } catch {
    return undefined;
  }
}

/** Whether a registered checkout holds nothing but its `.git`: nothing populated there yet. */
function onlyGitIn(at: string): boolean {
  try {
    const names = readdirSync(at);
    return names.length === 1 && names[0] === '.git';
  } catch {
    return false;
  }
}

/**
 * Whether `name` (a path Git gave, below `at`) is an empty real folder, every folder above it real
 * too: never followed through a link.
 */
function emptyFolderAt(at: string, name: string): boolean {
  let folder = at;
  for (const part of name.split('/')) {
    if (part === '' || part === '.' || part === '..') return false;
    folder = path.join(folder, part);
    const found = lstatOrNone(folder);
    if (found === undefined || found.isSymbolicLink() || !found.isDirectory()) return false;
  }
  try {
    return readdirSync(folder).length === 0;
  } catch {
    return false;
  }
}

/** What is at a workspace's checkout path before it is registered. */
function folderAt(at: string): 'none' | 'empty' | 'full' | 'other' {
  let found;
  try {
    found = lstatSync(at);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'none';
    return 'other';
  }
  if (found.isSymbolicLink() || !found.isDirectory()) return 'other';
  return readdirSync(at).length === 0 ? 'empty' : 'full';
}

/**
 * A failed Git write, named for its cause when Git's metadata is unsafe now: Git can fail on a
 * link before the core's check after the write runs, and the link is the cause, not Git.
 */
function metadataCause(
  error: unknown,
  repository: RepositoryRecord,
  tree: WorktreeRecord,
): unknown {
  if (!(error instanceof GitError)) return error;
  try {
    verifyGitMetadata(repository.commonDir, { branch: tree.branchRef });
  } catch (found) {
    if (found instanceof GitMetadataError) return found;
  }
  return error;
}

/** The code a failure is recorded with; none for one the job can't name. */
function failureCode(error: unknown): string | undefined {
  if (error instanceof Failed) return error.code;
  if (error instanceof OwnedRootError) return `owned-root-${error.code}`;
  if (error instanceof GitMetadataError) return `git-metadata-${error.code}`;
  if (error instanceof GitError) {
    switch (error.fault) {
      case 'refused':
      case 'hooks':
        return undefined;
      case 'git-missing':
      case 'git-unsupported':
      case 'config':
        return error.fault;
      default:
        return `git-${error.fault}`;
    }
  }
  return undefined;
}
