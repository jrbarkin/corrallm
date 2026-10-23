import path from 'node:path';
import { createHash } from 'node:crypto';

import { isCanvasId } from '../../../shared/canvas';
import type { CanvasId } from '../../../shared/canvas';
import { MAX_NODE_ID } from '../../../shared/model/canvas';
import { PARTY_PATTERN } from '../../../shared/model/messages';
import type { PartyId } from '../../../shared/model/messages';
import type { WorkspaceOwnerKey } from '../../../shared/model/workspaces';
import type { Database } from '../store/store';

/*
 * The workspaces the core keeps of each canvas, in the profile's database (schema 3: store/
 * migrations.ts): the repositories its project folders are, the one each canvas's is, each
 * workspace (a checkout of its own of the repository, for an outermost group or a lone agent) and
 * its state, each agent's binding to one (its active generation, and a change of it waiting), the
 * jobs recorded before their work is done, so that a restart finishes them, each workspace's setup,
 * and each repository's setup command and what is allowed to run always.
 *
 * Every write is synchronous and runs within a write: one of its own (`write`), or another store's
 * (a document's commit, the run journal's), so that what it records commits with what it goes with,
 * or neither does. It reads the database itself, keeping nothing in memory, so a write that fails
 * leaves nothing of it to undo. It checks what it is given (ids, absolute paths, refs, hashes and
 * codes of the shapes the core makes) and reads back only what it can read as it wrote it: a record
 * it can't fails its read, saying which, rather than being taken for something safe. It does
 * nothing to a repository or a file and mints no path: a path it reads back is a record, to check
 * again before it is used.
 */

/** Where a repository's workspaces' checkouts are made: inside the picked checkout, or the profile. */
export type RootKind = 'project' | 'profile';
/** A workspace's state: being made, set up, ready, lost, failed, kept, or being removed. */
export type WorktreeState =
  'creating' | 'setup' | 'ready' | 'missing' | 'error' | 'retained' | 'removing';
/** What a job does to a workspace. */
export type JobKind = 'create' | 'rebind' | 'remove' | 'repair';
/** How a job ended. */
export type JobOutcome = 'done' | 'failed' | 'superseded' | 'cancelled';
/** Where a setup's command came from: you, the fixed table of lockfiles, or nowhere. */
export type SetupSource = 'configured' | 'detected' | 'none';
export type SetupState = 'pending' | 'running' | 'done' | 'skipped' | 'failed' | 'interrupted';
/** How a command you set runs: a POSIX shell's, or Windows'. */
export type ShellKind = 'posix' | 'windows';
/** A job's payload: what JSON holds. */
export type Json =
  null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

const ROOT_KINDS: readonly RootKind[] = ['project', 'profile'];
const STATES: readonly WorktreeState[] = [
  'creating',
  'setup',
  'ready',
  'missing',
  'error',
  'retained',
  'removing',
];
/** The states of a workspace in use: its owner's destination. Kept ones, and those going, aren't. */
export const ACTIVE_STATES: readonly WorktreeState[] = [
  'creating',
  'setup',
  'ready',
  'missing',
  'error',
];
const JOB_KINDS: readonly JobKind[] = ['create', 'rebind', 'remove', 'repair'];
const OUTCOMES: readonly JobOutcome[] = ['done', 'failed', 'superseded', 'cancelled'];
const SOURCES: readonly SetupSource[] = ['configured', 'detected', 'none'];
const SETUP_STATES: readonly SetupState[] = [
  'pending',
  'running',
  'done',
  'skipped',
  'failed',
  'interrupted',
];
const SHELL_KINDS: readonly ShellKind[] = ['posix', 'windows'];
/** The setup states from which it may be allowed to run, or skipped. */
const DECIDABLE: readonly SetupState[] = ['pending', 'failed', 'interrupted'];

/**
 * Where a workspace may go from each state. A checkout made is never made again over itself; one
 * kept is only ever removed; one being removed is kept after all if its cleanup can't be finished
 * safely, or stays being removed, saying why its cleanup failed, to be tried again.
 */
const MOVES: Readonly<Record<WorktreeState, readonly WorktreeState[]>> = {
  creating: ['setup', 'error', 'missing', 'retained', 'removing'],
  setup: ['ready', 'error', 'missing', 'retained', 'removing'],
  ready: ['setup', 'error', 'missing', 'retained', 'removing'],
  missing: ['creating', 'setup', 'ready', 'error', 'retained', 'removing'],
  error: ['creating', 'setup', 'ready', 'missing', 'retained', 'removing'],
  retained: ['removing'],
  removing: ['removing', 'retained'],
};
/** The states that say why (an error code); the others but `removing` clear it. */
const SAYS_WHY: readonly WorktreeState[] = ['error', 'missing'];

/** The longest path, identity, command and payload it keeps. */
const MAX_PATH = 4096;
const MAX_IDENTITY = 1024;
const MAX_COMMAND_BYTES = 4096;
const MAX_PAYLOAD_BYTES = 64 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const HASH = /^[0-9a-f]{64}$/;
/** An error code, a job's phase: a short word of the core's. */
const CODE = /^[a-z][a-z0-9-]{0,63}$/;
const LOG_KEY = /^[A-Za-z0-9._-]{1,128}$/;
/** A ref's name: no part begins with a dot or a dash, none is empty, none holds `..` or `.lock`. */
const REF_PART = /^(?![.-])[A-Za-z0-9._-]+(?<!\.lock)(?<!\.)$/;
const MAX_REF = 1024;
const OWNER = /^(?:agent|group)\/.+$/s;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Why the store refused: a record it doesn't keep, one not where the caller thought, or a rule. */
export type WorkspaceStoreErrorCode = 'invalid' | 'not-found' | 'stale' | 'refused';

export class WorkspaceStoreError extends Error {
  readonly code: WorkspaceStoreErrorCode;
  constructor(code: WorkspaceStoreErrorCode, message: string) {
    super(message);
    this.name = 'WorkspaceStoreError';
    this.code = code;
  }
}

/** A repository a canvas's project folder is, on this profile. */
export interface RepositoryRecord {
  id: string;
  /** The checkout picked, as picked, and its real path (its top level). */
  pickedRoot: string;
  realRoot: string;
  /** Its common Git directory, which its workspaces share. */
  commonDir: string;
  /** What identifies it, as the core found it: checked again before its work is touched. */
  identity: string;
  rootKind: RootKind;
  /** The folder its workspaces' checkouts are made in. */
  ownedRoot: string;
  /** Moves on whenever what is known of it changes. */
  generation: number;
}
export type NewRepository = Omit<RepositoryRecord, 'generation'>;
/** What may change of a repository as it is found again. */
export type Rediscovered = Partial<Omit<NewRepository, 'id'>>;

/** The repository a canvas's project folder is (none: a folder that isn't one), and its generation. */
export interface CanvasRepository {
  canvas: CanvasId;
  repository: string | null;
  /** The canvas's project generation: moves on with every change of its project folder. */
  generation: number;
}

/** A canvas's workspace. */
export interface WorktreeRecord {
  id: string;
  canvas: CanvasId;
  repository: string;
  /** The outermost group or lone agent it is for. */
  owner: WorkspaceOwnerKey;
  /** Its checkout, and the branch made for it. */
  path: string;
  branchRef: string;
  /** The checkout it was made from, the branch that one was on (none: detached), its commit. */
  baseCheckout: string;
  baseRef: string | null;
  baseOid: string;
  /** The workspace it was forked from, if one was, and is still kept. */
  forkedFrom: string | null;
  state: WorktreeState;
  /** Moves on whenever its effective checkout or setup changes. */
  generation: number;
  createdAt: number;
  /** Why it is lost, failed, or its cleanup did. */
  errorCode: string | null;
}
export type NewWorktree = Omit<WorktreeRecord, 'state' | 'generation' | 'createdAt' | 'errorCode'>;

/** A move of a workspace from where the caller thinks it is. */
export interface Move {
  from: WorktreeState | readonly WorktreeState[];
  to: WorktreeState;
  /** Why: required going to `error` or `missing`; set going to `removing` (none: no failure yet); cleared otherwise. */
  errorCode?: string | null;
}

/** An agent's binding to a workspace of its canvas. */
export interface AgentBinding {
  canvas: CanvasId;
  agent: string;
  workspace: string;
  /** The active binding's generation: what a session started in it was started at. */
  generation: number;
  /** A change waiting: the owner it is to move to, and the generation it would be installed at. */
  desired: { generation: number; owner: WorkspaceOwnerKey } | null;
}

/** What is to be done to a workspace, recorded before any of it is. */
export interface JobRecord {
  id: string;
  workspace: string;
  kind: JobKind;
  /** The phase it reached: each marked once it is done. */
  phase: string;
  /** The generation it is for. */
  generation: number;
  /** The repository's identity it expects: none if it expects none. */
  expectedIdentity: string | null;
  payload: Json;
  /** How it ended: none while it goes on. */
  outcome: JobOutcome | null;
  createdAt: number;
  updatedAt: number;
}
export interface NewJob {
  id: string;
  workspace: string;
  kind: JobKind;
  phase: string;
  generation: number;
  expectedIdentity?: string | null;
  payload: Json;
}

/** A workspace's setup, at a generation. */
export interface SetupRecord {
  workspace: string;
  generation: number;
  /** The command as it was offered (none if there is none). */
  command: string | null;
  source: SetupSource;
  /** The hashes of exactly what runs and how, and of the local files copied in. */
  specHash: string;
  copyManifestHash: string;
  state: SetupState;
  /** Who allowed it to run, and when (none: no one has). */
  approvedBy: PartyId | null;
  approvedAt: number | null;
  /** Where its output is kept, and how it exited. */
  logKey: string | null;
  exitCode: number | null;
}
export type SetupOffer = Pick<SetupRecord, 'command' | 'source' | 'specHash' | 'copyManifestHash'>;

/** How a repository's workspaces are set up on this profile. */
export interface ProjectSetup {
  repository: string;
  /** The command you set, and how it runs (none: the one detected, if any). */
  command: string | null;
  shellKind: ShellKind | null;
  /** The hash of exactly what you allowed to run always (none: each workspace asks). */
  alwaysSpecHash: string | null;
  changedAt: number;
}

export interface WorkspaceStoreDeps {
  /** The profile's database. */
  store: Database;
  /** The time, in epoch ms: what binding generations are numbered on from. */
  now?: () => number;
}

type Row = Record<string, unknown>;

export class WorkspaceStore {
  readonly #store: Database;
  readonly #now: () => number;

  constructor({ store, now = () => Date.now() }: WorkspaceStoreDeps) {
    this.#store = store;
    this.#now = now;
  }

  /**
   * Runs `run` in a write of its own: on disk once it resolves, with what it returned; rejects,
   * keeping nothing of it, if it threw or couldn't be written.
   */
  write<T>(run: (workspaces: this) => T): Promise<T> {
    return this.#store.write(() => run(this));
  }

  // Repositories.

  repository(id: string): RepositoryRecord | undefined {
    const row = this.#store.prepare('SELECT * FROM repository WHERE id = ?').get(id);
    return row === undefined ? undefined : repositoryOf(row);
  }

  /** The repository found at `realRoot` with `identity`, if it is kept. */
  repositoryAt(realRoot: string, identity: string): RepositoryRecord | undefined {
    const row = this.#store
      .prepare('SELECT * FROM repository WHERE real_root = ? AND identity = ?')
      .get(realRoot, identity);
    return row === undefined ? undefined : repositoryOf(row);
  }

  /** Within a write: keeps a repository found, at generation 0. */
  addRepository(repository: NewRepository): RepositoryRecord {
    const kept = { ...checkRepository(repository), generation: 0 };
    this.#store
      .prepare(
        `INSERT INTO repository
           (id, picked_root, real_root, common_dir, identity, root_kind, owned_root, generation)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        kept.id,
        kept.pickedRoot,
        kept.realRoot,
        kept.commonDir,
        kept.identity,
        kept.rootKind,
        kept.ownedRoot,
        kept.generation,
      );
    return kept;
  }

  /**
   * Within a write: what is known of a repository found again; its generation moves on if any of
   * it changed.
   */
  rediscovered(id: string, changes: Rediscovered): RepositoryRecord {
    const kept = this.repository(id);
    if (kept === undefined) throw notFound('repository', id);
    const next = checkRepository({ ...kept, ...changes });
    const same = (Object.keys(next) as (keyof NewRepository)[]).every(
      (key) => next[key] === kept[key],
    );
    if (same) return kept;
    const found = { ...next, generation: kept.generation + 1 };
    this.#store
      .prepare(
        `UPDATE repository SET picked_root = ?, real_root = ?, common_dir = ?, identity = ?,
           root_kind = ?, owned_root = ?, generation = ?
         WHERE id = ?`,
      )
      .run(
        found.pickedRoot,
        found.realRoot,
        found.commonDir,
        found.identity,
        found.rootKind,
        found.ownedRoot,
        found.generation,
        id,
      );
    return found;
  }

  // Canvases' repositories.

  canvasRepository(canvas: CanvasId): CanvasRepository | undefined {
    const row = this.#store
      .prepare('SELECT * FROM canvas_repository WHERE canvas_id = ?')
      .get(canvas);
    return row === undefined ? undefined : canvasRepositoryOf(row);
  }

  /**
   * Within a write: the canvas's project folder is now `repository` (none: a folder that isn't
   * one); its project generation moves on.
   */
  bindCanvas(canvas: CanvasId, repository: string | null): CanvasRepository {
    checkCanvas(canvas);
    if (repository !== null) checkUuid(repository, 'repository');
    const generation = (this.canvasRepository(canvas)?.generation ?? 0) + 1;
    this.#store
      .prepare(
        `INSERT INTO canvas_repository (canvas_id, repository_id, generation) VALUES (?, ?, ?)
         ON CONFLICT (canvas_id) DO UPDATE SET
           repository_id = excluded.repository_id, generation = excluded.generation`,
      )
      .run(canvas, repository, generation);
    return { canvas, repository, generation };
  }

  // Workspaces.

  worktree(id: string): WorktreeRecord | undefined {
    const row = this.#store.prepare('SELECT * FROM worktree WHERE id = ?').get(id);
    return row === undefined ? undefined : worktreeOf(row);
  }

  /** Every workspace of the canvas, in any state, as they were made. */
  worktreesOf(canvas: CanvasId): WorktreeRecord[] {
    return this.#store
      .prepare('SELECT * FROM worktree WHERE canvas_id = ? ORDER BY created_at, id')
      .all(canvas)
      .map(worktreeOf);
  }

  /** The workspace in use for `owner` of the canvas's repository, if there is one. */
  activeWorktree(
    canvas: CanvasId,
    repository: string,
    owner: WorkspaceOwnerKey,
  ): WorktreeRecord | undefined {
    const row = this.#store
      .prepare(
        `SELECT * FROM worktree
         WHERE canvas_id = ? AND repository_id = ? AND owner_key = ?
           AND state NOT IN ('retained', 'removing')`,
      )
      .get(canvas, repository, owner);
    return row === undefined ? undefined : worktreeOf(row);
  }

  /**
   * Within a write: a workspace being made (`creating`), at generation 1. Refused (SQLite's
   * constraint) if its owner has one in use already, or its branch or checkout is another's.
   */
  createWorktree(worktree: NewWorktree): WorktreeRecord {
    const made: WorktreeRecord = {
      ...checkWorktree(worktree),
      state: 'creating',
      generation: 1,
      createdAt: this.#now(),
      errorCode: null,
    };
    this.#store
      .prepare(
        `INSERT INTO worktree (id, canvas_id, repository_id, owner_key, path, branch_ref,
           base_checkout, base_ref, base_oid, forked_from, state, generation, created_at,
           error_code)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        made.id,
        made.canvas,
        made.repository,
        made.owner,
        made.path,
        made.branchRef,
        made.baseCheckout,
        made.baseRef,
        made.baseOid,
        made.forkedFrom,
        made.state,
        made.generation,
        made.createdAt,
        made.errorCode,
      );
    return made;
  }

  /**
   * Within a write: moves a workspace from where the caller thinks it is (`from`; stale if it isn't
   * there) to `to`, if a workspace may go there from it (refused otherwise).
   */
  transition(id: string, { from, to, errorCode }: Move): WorktreeRecord {
    if (!STATES.includes(to)) throw invalid(`${to} isn’t a workspace’s state.`);
    if (errorCode !== undefined && errorCode !== null) checkCode(errorCode, 'error code');
    if (SAYS_WHY.includes(to) && (errorCode === undefined || errorCode === null)) {
      throw invalid(`A workspace goes to ${to} only saying why.`);
    }
    const kept = this.worktree(id);
    if (kept === undefined) throw notFound('workspace', id);
    const expected: readonly WorktreeState[] = typeof from === 'string' ? [from] : from;
    if (!expected.includes(kept.state)) {
      throw new WorkspaceStoreError(
        'stale',
        `The workspace ${id} is ${kept.state}, not ${expected.join(' or ')}.`,
      );
    }
    if (!MOVES[kept.state].includes(to)) {
      throw new WorkspaceStoreError('refused', `A workspace ${kept.state} can’t become ${to}.`);
    }
    const why = SAYS_WHY.includes(to) || to === 'removing' ? (errorCode ?? null) : null;
    this.#store
      .prepare('UPDATE worktree SET state = ?, error_code = ? WHERE id = ?')
      .run(to, why, id);
    return { ...kept, state: to, errorCode: why };
  }

  /** Within a write: a workspace in use kept, its work no one's destination any more. */
  retain(id: string): WorktreeRecord {
    return this.transition(id, { from: ACTIVE_STATES, to: 'retained' });
  }

  /** Within a write: a workspace, in use or kept, to be removed once its cleanup is safe. */
  markRemoving(id: string): WorktreeRecord {
    return this.transition(id, { from: [...ACTIVE_STATES, 'retained'], to: 'removing' });
  }

  /**
   * Within a write: a workspace in use is for `owner` now (a lone agent's that gained its first
   * member keeps its checkout as the group's, and back).
   */
  setOwner(id: string, owner: WorkspaceOwnerKey): WorktreeRecord {
    checkOwner(owner);
    const kept = this.worktree(id);
    if (kept === undefined) throw notFound('workspace', id);
    if (!ACTIVE_STATES.includes(kept.state)) {
      throw new WorkspaceStoreError('refused', `A workspace ${kept.state} is no one’s any more.`);
    }
    this.#store.prepare('UPDATE worktree SET owner_key = ? WHERE id = ?').run(owner, id);
    return { ...kept, owner };
  }

  /**
   * Within a write: the workspace's checkout or setup changed, so its generation moves on, and so
   * does every binding to it: a session started at the old one is no longer its agent's.
   */
  advance(id: string): WorktreeRecord {
    const kept = this.worktree(id);
    if (kept === undefined) throw notFound('workspace', id);
    const generation = kept.generation + 1;
    this.#store.prepare('UPDATE worktree SET generation = ? WHERE id = ?').run(generation, id);
    const move = this.#store.prepare(
      'UPDATE agent_worktree SET generation = ? WHERE canvas_id = ? AND agent_id = ?',
    );
    for (const binding of this.bindingsTo(kept.canvas, id)) {
      // A change waiting moves past it too: it is no longer the plan as it was reviewed.
      const next = this.#next(Math.max(binding.generation, binding.desired?.generation ?? 0));
      if (binding.desired !== null) {
        const desired = this.#next(next);
        this.#store
          .prepare(
            'UPDATE agent_worktree SET desired_generation = ? WHERE canvas_id = ? AND agent_id = ?',
          )
          .run(desired, binding.canvas, binding.agent);
      }
      move.run(next, binding.canvas, binding.agent);
    }
    return { ...kept, generation };
  }

  /**
   * Within a write: forgets a workspace removed (`removing`), once nothing is bound to it and no
   * job of it goes on; its jobs and setup go with it. Its agents' conversations in it are canvas
   * memory's to forget.
   */
  forget(id: string): void {
    const kept = this.worktree(id);
    if (kept === undefined) throw notFound('workspace', id);
    if (kept.state !== 'removing') {
      throw new WorkspaceStoreError(
        'refused',
        `The workspace ${id} is ${kept.state}, not removed.`,
      );
    }
    if (this.bindingsTo(kept.canvas, id).length > 0) {
      throw new WorkspaceStoreError('refused', `Agents are still bound to the workspace ${id}.`);
    }
    if (this.jobsOf(id).some((job) => job.outcome === null)) {
      throw new WorkspaceStoreError('refused', `A job of the workspace ${id} still goes on.`);
    }
    this.#store.prepare('DELETE FROM worktree WHERE id = ?').run(id);
  }

  // Agents' bindings.

  binding(canvas: CanvasId, agent: string): AgentBinding | undefined {
    const row = this.#store
      .prepare('SELECT * FROM agent_worktree WHERE canvas_id = ? AND agent_id = ?')
      .get(canvas, agent);
    return row === undefined ? undefined : bindingOf(row);
  }

  /** Every agent's binding on the canvas, by agent. */
  bindingsOf(canvas: CanvasId): AgentBinding[] {
    return this.#store
      .prepare('SELECT * FROM agent_worktree WHERE canvas_id = ? ORDER BY agent_id')
      .all(canvas)
      .map(bindingOf);
  }

  /** The bindings to a workspace of the canvas, by agent. */
  bindingsTo(canvas: CanvasId, workspace: string): AgentBinding[] {
    return this.#store
      .prepare(
        'SELECT * FROM agent_worktree WHERE canvas_id = ? AND workspace_id = ? ORDER BY agent_id',
      )
      .all(canvas, workspace)
      .map(bindingOf);
  }

  /**
   * Within a write: installs the agent's binding to a workspace in use of its canvas, at a
   * generation past every one it had: a change waiting's own, if one waits, which it installs.
   */
  bind(canvas: CanvasId, agent: string, workspace: string): AgentBinding {
    checkCanvas(canvas);
    checkAgent(agent);
    const tree = this.worktree(workspace);
    if (tree?.canvas !== canvas) throw notFound('workspace', workspace);
    if (!ACTIVE_STATES.includes(tree.state)) {
      throw new WorkspaceStoreError('refused', `The workspace ${workspace} is ${tree.state}.`);
    }
    const kept = this.binding(canvas, agent);
    const generation = kept?.desired?.generation ?? this.#next(kept?.generation ?? 0);
    this.#store
      .prepare(
        `INSERT INTO agent_worktree (canvas_id, agent_id, workspace_id, generation)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (canvas_id, agent_id) DO UPDATE SET workspace_id = excluded.workspace_id,
           generation = excluded.generation, desired_generation = NULL, desired_owner_key = NULL`,
      )
      .run(canvas, agent, workspace, generation);
    return { canvas, agent, workspace, generation, desired: null };
  }

  /**
   * Within a write: a change of the agent's binding waits (for its owner to be `owner`), at a
   * generation past the active one: new starts and sends wait for it, and the active binding stays
   * its agent's until it is installed (`bind`) or cleared.
   */
  plan(canvas: CanvasId, agent: string, owner: WorkspaceOwnerKey): AgentBinding {
    checkOwner(owner);
    const kept = this.binding(canvas, agent);
    if (kept === undefined) throw notFound('binding', `${canvas}/${agent}`);
    const desired = {
      generation: this.#next(Math.max(kept.generation, kept.desired?.generation ?? 0)),
      owner,
    };
    this.#store
      .prepare(
        `UPDATE agent_worktree SET desired_generation = ?, desired_owner_key = ?
         WHERE canvas_id = ? AND agent_id = ?`,
      )
      .run(desired.generation, desired.owner, canvas, agent);
    return { ...kept, desired };
  }

  /** Within a write: the change of the agent's binding waiting no longer does. */
  clearPlan(canvas: CanvasId, agent: string): AgentBinding {
    const kept = this.binding(canvas, agent);
    if (kept === undefined) throw notFound('binding', `${canvas}/${agent}`);
    this.#store
      .prepare(
        `UPDATE agent_worktree SET desired_generation = NULL, desired_owner_key = NULL
         WHERE canvas_id = ? AND agent_id = ?`,
      )
      .run(canvas, agent);
    return { ...kept, desired: null };
  }

  /** Within a write: the agent is bound to no workspace any more (none if it was bound to none). */
  unbind(canvas: CanvasId, agent: string): void {
    this.#store
      .prepare('DELETE FROM agent_worktree WHERE canvas_id = ? AND agent_id = ?')
      .run(canvas, agent);
  }

  /**
   * A generation past `after` that no binding was given before: numbered on from the clock, as the
   * store's sequences are, so that a binding made again (an agent deleted, another of its id added)
   * never takes one an older session of it was started at.
   */
  #next(after: number): number {
    const last = this.#store
      .prepare('SELECT workspace_generation FROM meta WHERE id = 1')
      .get()?.workspace_generation;
    checkGeneration(last);
    const next = Math.max(Math.trunc(this.#now()), after + 1, last + 1);
    checkGeneration(next);
    this.#store.prepare('UPDATE meta SET workspace_generation = ? WHERE id = 1').run(next);
    return next;
  }

  // Jobs.

  job(id: string): JobRecord | undefined {
    const row = this.#store.prepare('SELECT * FROM worktree_job WHERE id = ?').get(id);
    return row === undefined ? undefined : jobOf(row);
  }

  /** The job of `kind` going on for the workspace, if one does. */
  openJob(workspace: string, kind: JobKind): JobRecord | undefined {
    const row = this.#store
      .prepare('SELECT * FROM worktree_job WHERE workspace_id = ? AND kind = ? AND outcome IS NULL')
      .get(workspace, kind);
    return row === undefined ? undefined : jobOf(row);
  }

  /** Every job going on, of every canvas, oldest first: what a restart finishes. */
  openJobs(): JobRecord[] {
    return this.#store
      .prepare('SELECT * FROM worktree_job WHERE outcome IS NULL ORDER BY created_at, id')
      .all()
      .map(jobOf);
  }

  /** Every job of the workspace, oldest first. */
  jobsOf(workspace: string): JobRecord[] {
    return this.#store
      .prepare('SELECT * FROM worktree_job WHERE workspace_id = ? ORDER BY created_at, id')
      .all(workspace)
      .map(jobOf);
  }

  /**
   * Within a write: records what is to be done, before any of it is. Recorded again (a retry of
   * the same intent), it is the job recorded; refused if that id is another job's, or a job of its
   * kind goes on for the workspace already.
   */
  recordJob(job: NewJob): JobRecord {
    const asked = checkJob(job);
    const kept = this.job(asked.id);
    if (kept !== undefined) {
      const same =
        kept.workspace === asked.workspace &&
        kept.kind === asked.kind &&
        kept.generation === asked.generation &&
        kept.expectedIdentity === asked.expectedIdentity &&
        this.#store.prepare('SELECT intent_hash FROM worktree_job WHERE id = ?').get(asked.id)
          ?.intent_hash === intentHash(asked.payload);
      if (same) return kept;
      throw new WorkspaceStoreError('refused', `The job ${asked.id} was recorded as another.`);
    }
    if (this.openJob(asked.workspace, asked.kind) !== undefined) {
      throw new WorkspaceStoreError(
        'refused',
        `A ${asked.kind} job goes on for the workspace ${asked.workspace} already.`,
      );
    }
    const at = this.#now();
    const recorded: JobRecord = { ...asked, outcome: null, createdAt: at, updatedAt: at };
    this.#store
      .prepare(
        `INSERT INTO worktree_job (id, workspace_id, kind, phase, generation, expected_identity,
           payload, intent_hash, outcome, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        recorded.id,
        recorded.workspace,
        recorded.kind,
        recorded.phase,
        recorded.generation,
        recorded.expectedIdentity,
        JSON.stringify(recorded.payload),
        intentHash(recorded.payload),
        at,
        at,
      );
    return recorded;
  }

  /**
   * Within a write: marks the phase a job going on reached, from the one the caller thinks it is in
   * (stale if it isn't, or the job ended), with what it needs from then on, if that changed.
   */
  advanceJob(
    id: string,
    { from, to, payload }: { from: string; to: string; payload?: Json },
  ): JobRecord {
    checkCode(to, 'phase');
    const kept = this.#openJob(id);
    if (kept.phase !== from) {
      throw new WorkspaceStoreError('stale', `The job ${id} is at ${kept.phase}, not ${from}.`);
    }
    const next: JobRecord = {
      ...kept,
      phase: to,
      ...(payload === undefined ? {} : { payload: checkPayload(payload) }),
      updatedAt: this.#now(),
    };
    this.#store
      .prepare('UPDATE worktree_job SET phase = ?, payload = ?, updated_at = ? WHERE id = ?')
      .run(next.phase, JSON.stringify(next.payload), next.updatedAt, id);
    return next;
  }

  /** Within a write: a job going on ended (stale if it ended already). */
  finishJob(id: string, outcome: JobOutcome): JobRecord {
    if (!OUTCOMES.includes(outcome)) throw invalid(`${outcome} isn’t how a job ends.`);
    const kept = this.#openJob(id);
    const next: JobRecord = { ...kept, outcome, updatedAt: this.#now() };
    this.#store
      .prepare('UPDATE worktree_job SET outcome = ?, updated_at = ? WHERE id = ?')
      .run(outcome, next.updatedAt, id);
    return next;
  }

  #openJob(id: string): JobRecord {
    const kept = this.job(id);
    if (kept === undefined) throw notFound('job', id);
    if (kept.outcome !== null) {
      throw new WorkspaceStoreError('stale', `The job ${id} ended (${kept.outcome}).`);
    }
    return kept;
  }

  // Setups.

  setup(workspace: string): SetupRecord | undefined {
    const row = this.#store
      .prepare('SELECT * FROM worktree_setup WHERE workspace_id = ?')
      .get(workspace);
    return row === undefined ? undefined : setupOf(row);
  }

  /**
   * Within a write: offers the workspace's setup anew, at its next generation, waiting to be
   * allowed or skipped (no one has allowed it yet). Refused while one runs.
   */
  offerSetup(workspace: string, offer: SetupOffer): SetupRecord {
    const checked = checkOffer(offer);
    const kept = this.setup(workspace);
    if (kept?.state === 'running') {
      throw new WorkspaceStoreError('refused', `The workspace ${workspace}’s setup is running.`);
    }
    const offered: SetupRecord = {
      workspace,
      generation: (kept?.generation ?? 0) + 1,
      ...checked,
      state: 'pending',
      approvedBy: null,
      approvedAt: null,
      logKey: null,
      exitCode: null,
    };
    this.#store
      .prepare(
        `INSERT INTO worktree_setup (workspace_id, generation, command_snapshot, source, spec_hash,
           copy_manifest_hash, state, approved_by, approved_at, log_key, exit_code)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, NULL)
         ON CONFLICT (workspace_id) DO UPDATE SET generation = excluded.generation,
           command_snapshot = excluded.command_snapshot, source = excluded.source,
           spec_hash = excluded.spec_hash, copy_manifest_hash = excluded.copy_manifest_hash,
           state = 'pending', approved_by = NULL, approved_at = NULL, log_key = NULL,
           exit_code = NULL`,
      )
      .run(
        workspace,
        offered.generation,
        offered.command,
        offered.source,
        offered.specHash,
        offered.copyManifestHash,
      );
    return offered;
  }

  /**
   * Within a write: `by` allowed the workspace's setup at `generation` to run (stale if it was
   * offered anew since, or isn't waiting for it), and it runs, its output kept under `logKey`: on
   * disk before anything runs. Refused for a setup with nothing to run.
   */
  startSetup(
    workspace: string,
    { generation, by, logKey }: { generation: number; by: PartyId; logKey: string },
  ): SetupRecord {
    checkParty(by);
    if (!LOG_KEY.test(logKey)) throw invalid('That isn’t a log’s key.');
    const kept = this.#decidable(workspace, generation);
    if (kept.command === null) {
      throw new WorkspaceStoreError('refused', `The workspace ${workspace} has no setup to run.`);
    }
    const next: SetupRecord = {
      ...kept,
      state: 'running',
      approvedBy: by,
      approvedAt: this.#now(),
      logKey,
      exitCode: null,
    };
    this.#store
      .prepare(
        `UPDATE worktree_setup SET state = 'running', approved_by = ?, approved_at = ?, log_key = ?,
           exit_code = NULL
         WHERE workspace_id = ?`,
      )
      .run(by, next.approvedAt, logKey, workspace);
    return next;
  }

  /** Within a write: the workspace's setup at `generation` is skipped (stale as for startSetup). */
  skipSetup(workspace: string, generation: number): SetupRecord {
    const kept = this.#decidable(workspace, generation);
    this.#store
      .prepare("UPDATE worktree_setup SET state = 'skipped' WHERE workspace_id = ?")
      .run(workspace);
    return { ...kept, state: 'skipped' };
  }

  /**
   * Within a write: the workspace's setup at `generation` that ran exited (`exitCode`; none if it
   * was stopped, or couldn't start): done if it exited 0, failed otherwise.
   */
  finishSetup(workspace: string, generation: number, exitCode: number | null): SetupRecord {
    if (exitCode !== null && !Number.isSafeInteger(exitCode))
      throw invalid('That isn’t an exit code.');
    const kept = this.setup(workspace);
    if (kept === undefined) throw notFound('setup', workspace);
    if (kept.generation !== generation || kept.state !== 'running') {
      throw new WorkspaceStoreError(
        'stale',
        `The workspace ${workspace}’s setup at ${String(generation)} isn’t running.`,
      );
    }
    const state: SetupState = exitCode === 0 ? 'done' : 'failed';
    this.#store
      .prepare('UPDATE worktree_setup SET state = ?, exit_code = ? WHERE workspace_id = ?')
      .run(state, exitCode, workspace);
    return { ...kept, state, exitCode };
  }

  /**
   * Within a write, as the core starts: every setup that was running is interrupted, since whether
   * it did what it does is unknown, and so is never run again by itself. Returns their workspaces.
   */
  interruptSetups(): string[] {
    return this.#store
      .prepare(
        "UPDATE worktree_setup SET state = 'interrupted' WHERE state = 'running' RETURNING workspace_id",
      )
      .all()
      .map(({ workspace_id: workspace }) => String(workspace))
      .sort();
  }

  #decidable(workspace: string, generation: number): SetupRecord {
    const kept = this.setup(workspace);
    if (kept === undefined) throw notFound('setup', workspace);
    if (kept.generation !== generation || !DECIDABLE.includes(kept.state)) {
      throw new WorkspaceStoreError(
        'stale',
        `The workspace ${workspace}’s setup at ${String(generation)} isn’t waiting to be decided.`,
      );
    }
    return kept;
  }

  // Repositories' setup.

  projectSetup(repository: string): ProjectSetup | undefined {
    const row = this.#store
      .prepare('SELECT * FROM project_setup WHERE repository_id = ?')
      .get(repository);
    return row === undefined ? undefined : projectSetupOf(row);
  }

  /**
   * Within a write: the command you set for the repository's workspaces, and how it runs (none:
   * the one detected, if any). Always no longer holds once either changes.
   */
  setProjectCommand(
    repository: string,
    command: string | null,
    shellKind: ShellKind | null,
  ): ProjectSetup {
    if ((command === null) !== (shellKind === null)) {
      throw invalid('A command you set says how it runs, and only one does.');
    }
    if (command !== null) checkCommand(command);
    if (shellKind !== null && !SHELL_KINDS.includes(shellKind)) {
      throw invalid(`${shellKind} isn’t how a command runs.`);
    }
    const kept = this.projectSetup(repository);
    const same = kept?.command === command && kept.shellKind === shellKind;
    return this.#keepProjectSetup({
      repository,
      command,
      shellKind,
      alwaysSpecHash: same ? kept.alwaysSpecHash : null,
      changedAt: this.#now(),
    });
  }

  /** Within a write: exactly what you allowed to run always (none: each workspace asks). */
  setAlways(repository: string, specHash: string | null): ProjectSetup {
    if (specHash !== null) checkHash(specHash, 'spec hash');
    const kept = this.projectSetup(repository);
    return this.#keepProjectSetup({
      repository,
      command: kept?.command ?? null,
      shellKind: kept?.shellKind ?? null,
      alwaysSpecHash: specHash,
      changedAt: this.#now(),
    });
  }

  #keepProjectSetup(setup: ProjectSetup): ProjectSetup {
    this.#store
      .prepare(
        `INSERT INTO project_setup (repository_id, command, shell_kind, always_spec_hash,
           changed_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (repository_id) DO UPDATE SET command = excluded.command,
           shell_kind = excluded.shell_kind, always_spec_hash = excluded.always_spec_hash,
           changed_at = excluded.changed_at`,
      )
      .run(setup.repository, setup.command, setup.shellKind, setup.alwaysSpecHash, setup.changedAt);
    return setup;
  }
}

// What it is given, checked.

function invalid(message: string): WorkspaceStoreError {
  return new WorkspaceStoreError('invalid', message);
}

function notFound(kind: string, id: string): WorkspaceStoreError {
  return new WorkspaceStoreError('not-found', `There is no ${kind} ${id}.`);
}

function checkUuid(value: unknown, what: string): asserts value is string {
  if (typeof value !== 'string' || !UUID.test(value)) throw invalid(`That isn’t a ${what}’s id.`);
}

function checkCanvas(value: unknown): asserts value is CanvasId {
  if (!isCanvasId(value)) throw invalid('That isn’t a canvas’s id.');
}

function checkAgent(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_NODE_ID) {
    throw invalid('That isn’t an agent’s id.');
  }
}

function checkPath(value: unknown, what: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length > MAX_PATH ||
    value.includes('\0') ||
    !path.isAbsolute(value)
  ) {
    throw invalid(`The ${what} isn’t an absolute path.`);
  }
}

function checkText(value: unknown, what: string, most: number): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > most ||
    CONTROL.test(value)
  ) {
    throw invalid(`That isn’t a ${what}.`);
  }
}

function checkCode(value: unknown, what: string): asserts value is string {
  if (typeof value !== 'string' || !CODE.test(value)) throw invalid(`That isn’t a ${what}.`);
}

function checkHash(value: unknown, what: string): asserts value is string {
  if (typeof value !== 'string' || !HASH.test(value)) throw invalid(`That isn’t a ${what}.`);
}

function checkGeneration(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw invalid('That isn’t a generation.');
  }
}

function checkOwner(value: unknown): asserts value is WorkspaceOwnerKey {
  if (typeof value !== 'string' || value.length > MAX_PATH || !OWNER.test(value)) {
    throw invalid('That isn’t a workspace’s owner.');
  }
}

function checkParty(value: unknown): asserts value is PartyId {
  if (typeof value !== 'string' || !PARTY_PATTERN.test(value)) throw invalid('That isn’t a party.');
}

/** A ref of the core's shapes: under refs/, every part a plain name (`branch`: a branch). */
function isRef(value: unknown, branch: boolean): value is string {
  if (typeof value !== 'string' || value.length > MAX_REF) return false;
  const parts = value.split('/');
  if (parts[0] !== 'refs' || (branch && parts[1] !== 'heads') || parts.length < (branch ? 3 : 2))
    return false;
  if (branch) return parts.slice(1).every((part) => REF_PART.test(part) && !part.includes('..'));
  // A captured native ref is not a generated name: Git permits Unicode and punctuation here.
  // Full refs always start with refs/, so even a dash within a component cannot become a flag.
  if (
    CONTROL.test(value) ||
    [' ', '~', '^', ':', '?', '*', '[', '\\'].some((part) => value.includes(part)) ||
    value.includes('..') ||
    value.includes('@{')
  )
    return false;
  return (
    parts
      .slice(1)
      .every((part) => part !== '' && !part.startsWith('.') && !part.endsWith('.lock')) &&
    !value.endsWith('.')
  );
}

/** Compare the immutable intent, not a job's mutable progress; object-key order is immaterial. */
function intentHash(payload: Json): string {
  const canonical = (value: Json): Json =>
    Array.isArray(value)
      ? value.map(canonical)
      : value !== null && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([key, item]) => [key, canonical(item)]),
          )
        : value;
  return createHash('sha256')
    .update(JSON.stringify(canonical(payload)))
    .digest('hex');
}

/** A setup command you set: one line of at most MAX_COMMAND_BYTES, no control character. */
function checkCommand(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    Buffer.byteLength(value, 'utf8') > MAX_COMMAND_BYTES ||
    CONTROL.test(value)
  ) {
    throw invalid(
      'A setup command is one line of text, with no control characters, at most 4 KiB.',
    );
  }
}

function checkPayload(value: Json): Json {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    text = undefined;
  }
  if (text === undefined || Buffer.byteLength(text, 'utf8') > MAX_PAYLOAD_BYTES) {
    throw invalid('That isn’t a job’s payload.');
  }
  return JSON.parse(text) as Json;
}

function checkRepository(repository: NewRepository): NewRepository {
  const { id, pickedRoot, realRoot, commonDir, identity, rootKind, ownedRoot } = repository;
  checkUuid(id, 'repository');
  checkPath(pickedRoot, 'picked checkout');
  checkPath(realRoot, 'checkout’s real path');
  checkPath(commonDir, 'common Git directory');
  checkText(identity, 'repository’s identity', MAX_IDENTITY);
  if (!ROOT_KINDS.includes(rootKind)) throw invalid('That isn’t where workspaces are made.');
  checkPath(ownedRoot, 'workspaces’ folder');
  return { id, pickedRoot, realRoot, commonDir, identity, rootKind, ownedRoot };
}

function checkWorktree(worktree: NewWorktree): NewWorktree {
  const { id, canvas, repository, owner, path: at, branchRef, baseCheckout } = worktree;
  const { baseRef, baseOid, forkedFrom } = worktree;
  checkUuid(id, 'workspace');
  checkCanvas(canvas);
  checkUuid(repository, 'repository');
  checkOwner(owner);
  checkPath(at, 'workspace’s checkout');
  if (!isRef(branchRef, true)) throw invalid('That isn’t a branch of the core’s.');
  checkPath(baseCheckout, 'base checkout');
  if (baseRef !== null && !isRef(baseRef, false)) throw invalid('That isn’t a ref.');
  if (typeof baseOid !== 'string' || !OID.test(baseOid)) throw invalid('That isn’t a commit.');
  if (forkedFrom !== null) checkUuid(forkedFrom, 'workspace');
  return {
    id,
    canvas,
    repository,
    owner,
    path: at,
    branchRef,
    baseCheckout,
    baseRef,
    baseOid,
    forkedFrom,
  };
}

function checkJob(job: NewJob): Omit<JobRecord, 'outcome' | 'createdAt' | 'updatedAt'> {
  const { id, workspace, kind, phase, generation } = job;
  checkUuid(id, 'job');
  checkUuid(workspace, 'workspace');
  if (!JOB_KINDS.includes(kind)) throw invalid(`${kind} isn’t a job’s kind.`);
  checkCode(phase, 'phase');
  checkGeneration(generation);
  const expectedIdentity = job.expectedIdentity ?? null;
  if (expectedIdentity !== null) checkText(expectedIdentity, 'repository’s identity', MAX_IDENTITY);
  return {
    id,
    workspace,
    kind,
    phase,
    generation,
    expectedIdentity,
    payload: checkPayload(job.payload),
  };
}

function checkOffer({ command, source, specHash, copyManifestHash }: SetupOffer): SetupOffer {
  if (!SOURCES.includes(source)) throw invalid(`${source} isn’t where setup comes from.`);
  if ((source === 'none') !== (command === null)) {
    throw invalid('A setup has a command unless it has none to run.');
  }
  if (command !== null) checkCommand(command);
  checkHash(specHash, 'spec hash');
  checkHash(copyManifestHash, 'copy manifest’s hash');
  return { command, source, specHash, copyManifestHash };
}

// What it reads back, as it wrote it: anything else fails the read.

function unreadable(table: string, row: Row): Error {
  const id = [row.id, row.workspace_id, row.repository_id, row.canvas_id].find(
    (key): key is string => typeof key === 'string',
  );
  return new Error(
    `A ${table} record (${id ?? '?'}) can’t be read: no corrallm of this schema wrote it.`,
  );
}

/** Reads a row with `read`, which throws on anything it doesn't expect: fails as unreadable. */
function readRow<T>(table: string, row: Row, read: () => T): T {
  try {
    return read();
  } catch {
    throw unreadable(table, row);
  }
}

function text(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('Not text');
  return value;
}
function textOrNull(value: unknown): string | null {
  return value === null ? null : text(value);
}
function int(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    throw new TypeError('Not an integer');
  return value;
}
function intOrNull(value: unknown): number | null {
  return value === null ? null : int(value);
}
function oneOf<T extends string>(value: unknown, values: readonly T[]): T {
  if (!values.includes(value as T)) throw new TypeError('Not one of them');
  return value as T;
}
function owner(value: unknown): WorkspaceOwnerKey {
  const key = text(value);
  checkOwner(key);
  return key;
}

function generation(value: unknown): number {
  const found = int(value);
  checkGeneration(found);
  return found;
}

function repositoryOf(row: Row): RepositoryRecord {
  return readRow('repository', row, () => ({
    ...checkRepository({
      id: text(row.id),
      pickedRoot: text(row.picked_root),
      realRoot: text(row.real_root),
      commonDir: text(row.common_dir),
      identity: text(row.identity),
      rootKind: oneOf(row.root_kind, ROOT_KINDS),
      ownedRoot: text(row.owned_root),
    }),
    generation: generation(row.generation),
  }));
}

function canvasRepositoryOf(row: Row): CanvasRepository {
  return readRow('canvas_repository', row, () => {
    const canvas = text(row.canvas_id);
    checkCanvas(canvas);
    const repository = textOrNull(row.repository_id);
    if (repository !== null) checkUuid(repository, 'repository');
    return { canvas, repository, generation: generation(row.generation) };
  });
}

function worktreeOf(row: Row): WorktreeRecord {
  return readRow('worktree', row, () => {
    const canvas = text(row.canvas_id);
    checkCanvas(canvas);
    const checked = checkWorktree({
      id: text(row.id),
      canvas,
      repository: text(row.repository_id),
      owner: owner(row.owner_key),
      path: text(row.path),
      branchRef: text(row.branch_ref),
      baseCheckout: text(row.base_checkout),
      baseRef: textOrNull(row.base_ref),
      baseOid: text(row.base_oid),
      forkedFrom: textOrNull(row.forked_from),
    });
    const state = oneOf(row.state, STATES);
    const errorCode = textOrNull(row.error_code);
    if (errorCode !== null) checkCode(errorCode, 'error code');
    if (SAYS_WHY.includes(state) && errorCode === null) throw new TypeError('Missing error code');
    return {
      ...checked,
      state,
      generation: generation(row.generation),
      createdAt: int(row.created_at),
      errorCode,
    };
  });
}

function bindingOf(row: Row): AgentBinding {
  return readRow('agent_worktree', row, () => {
    const canvas = text(row.canvas_id);
    checkCanvas(canvas);
    const agent = text(row.agent_id);
    checkAgent(agent);
    const workspace = text(row.workspace_id);
    checkUuid(workspace, 'workspace');
    const active = generation(row.generation);
    const planned = intOrNull(row.desired_generation);
    const desired =
      planned === null ? null : { generation: planned, owner: owner(row.desired_owner_key) };
    if (desired !== null && desired.generation <= active) throw new TypeError('Not a later plan');
    return { canvas, agent, workspace, generation: active, desired };
  });
}

function jobOf(row: Row): JobRecord {
  return readRow('worktree_job', row, () => {
    checkHash(row.intent_hash, 'intent hash');
    return {
      ...checkJob({
        id: text(row.id),
        workspace: text(row.workspace_id),
        kind: oneOf(row.kind, JOB_KINDS),
        phase: text(row.phase),
        generation: generation(row.generation),
        expectedIdentity: textOrNull(row.expected_identity),
        payload: JSON.parse(text(row.payload)) as Json,
      }),
      outcome: row.outcome === null ? null : oneOf(row.outcome, OUTCOMES),
      createdAt: int(row.created_at),
      updatedAt: int(row.updated_at),
    };
  });
}

function setupOf(row: Row): SetupRecord {
  return readRow('worktree_setup', row, () => {
    const workspace = text(row.workspace_id);
    checkUuid(workspace, 'workspace');
    const approvedBy = textOrNull(row.approved_by);
    if (approvedBy !== null) checkParty(approvedBy);
    const logKey = textOrNull(row.log_key);
    if (logKey !== null && !LOG_KEY.test(logKey)) throw new TypeError('Not a log key');
    return {
      workspace,
      generation: generation(row.generation),
      ...checkOffer({
        command: textOrNull(row.command_snapshot),
        source: oneOf(row.source, SOURCES),
        specHash: text(row.spec_hash),
        copyManifestHash: text(row.copy_manifest_hash),
      }),
      state: oneOf(row.state, SETUP_STATES),
      approvedBy,
      approvedAt: intOrNull(row.approved_at),
      logKey,
      exitCode: intOrNull(row.exit_code),
    };
  });
}

function projectSetupOf(row: Row): ProjectSetup {
  return readRow('project_setup', row, () => {
    const repository = text(row.repository_id);
    checkUuid(repository, 'repository');
    const command = textOrNull(row.command);
    const shellKind = row.shell_kind === null ? null : oneOf(row.shell_kind, SHELL_KINDS);
    if ((command === null) !== (shellKind === null))
      throw new TypeError('Missing command or shell');
    if (command !== null) checkCommand(command);
    const alwaysSpecHash = textOrNull(row.always_spec_hash);
    if (alwaysSpecHash !== null) checkHash(alwaysSpecHash, 'spec hash');
    return { repository, command, shellKind, alwaysSpecHash, changedAt: int(row.changed_at) };
  });
}
