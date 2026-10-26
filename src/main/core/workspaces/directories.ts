import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { AgentId, NeedId } from '../../../shared/api/ids';
import type { CanvasId } from '../../../shared/canvas';
import type { CanvasDocument } from '../../../shared/model/canvas';
import { workspaceOwner } from '../../../shared/model/workspaces';
import type { WorkspaceOwnerKey } from '../../../shared/model/workspaces';
import type { ProjectFolders } from '../../project';
import type { TrustedPath } from '../host';
import { forkSource } from './planner';
import type { Provisioner, RepositoryFound } from './provision';
import type { Provisioning } from './list';
import type { DirectoryResolver, WorkingDirectory } from './resolver';
import type { SetupService } from './setup';
import { setupNeedId } from './setup';
import type { WorkspaceStore, WorktreeRecord } from './store';

export interface WorkspaceDirectoriesDeps {
  projects: Pick<ProjectFolders, 'of' | 'onAvailability'>;
  workspaces: WorkspaceStore;
  provisioner: Pick<
    Provisioner,
    'repository' | 'provision' | 'checkout' | 'reconcile' | 'run' | 'startRetry'
  >;
  setups: Pick<SetupService, 'prepare' | 'reconcile'>;
  document: (canvas: CanvasId) => Promise<CanvasDocument>;
  changed?: (canvas: CanvasId) => void;
  documentNow: (canvas: CanvasId) => CanvasDocument | undefined;
}

/** Resolves only paths verified by Provisioner; a pending plan never replaces its active binding. */
export class WorkspaceDirectories implements DirectoryResolver {
  readonly #deps: WorkspaceDirectoriesDeps;
  readonly #repositories = new Map<
    CanvasId,
    { root: TrustedPath; found: Promise<RepositoryFound> }
  >();
  readonly #listeners = new Map<CanvasId, Set<() => void>>();
  readonly #watching = new Map<CanvasId, () => void>();
  readonly #making = new Map<string, Promise<WorktreeRecord>>();
  readonly #errors = new Map<string, string>();
  /** What discovery last found of each canvas's picked folder, once it settled (worktree.list's). */
  readonly #found = new Map<CanvasId, NonNullable<Provisioning['project']>>();
  /** Resumed commit-intent jobs are shared by Provisioner, but must settle before the DB closes. */
  readonly #running = new Set<Promise<WorktreeRecord>>();
  #closed = false;
  #recovering: Promise<void> | undefined;

  #isClosed(): boolean {
    return this.#closed;
  }

  constructor(deps: WorkspaceDirectoriesDeps) {
    this.#deps = deps;
  }

  projectRoot(canvas: CanvasId): TrustedPath | undefined {
    return this.#deps.projects.of(canvas);
  }

  onAvailability(canvas: CanvasId, listener: () => void): () => void {
    this.#watch(canvas);
    const listeners = this.#listeners.get(canvas) ?? new Set<() => void>();
    this.#listeners.set(canvas, listeners);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.#listeners.delete(canvas);
    };
  }

  /** Committed membership, provisioning, setup or a Switch may have changed readiness. */
  changed(canvas: CanvasId): void {
    this.#deps.changed?.(canvas);
    for (const listener of this.#listeners.get(canvas) ?? []) listener();
  }

  invalidate(canvas: CanvasId): void {
    this.#repositories.delete(canvas);
    this.#found.delete(canvas);
    this.#errors.clear();
    this.changed(canvas);
  }

  /**
   * What the resolver knows, in memory, of an owner with no tree yet and of the canvas's picked
   * folder, without doing anything (worktree.list's: a list never allocates): its provisioning
   * going on, why it failed, and what discovery found.
   */
  provisioning(canvas: CanvasId, owner: WorkspaceOwnerKey): Provisioning {
    const key = `${canvas}\0${owner}`;
    const error = this.#errors.get(key);
    const project = this.#found.get(canvas);
    return {
      making: this.#making.has(key),
      ...(error === undefined ? {} : { error }),
      ...(project === undefined ? {} : { project }),
    };
  }

  /**
   * Tries an agent's worktree again (worktree.retry, yours alone): its bound tree's recorded
   * creation or recovery (Provisioner's `startRetry`: never forced, never over a checkout or branch
   * it didn't make, never deleting one), then, ready for setup, its setup offered (its card: what
   * runs is still yours to allow, unless you allowed it always); a tree being set up is offered its
   * card again if it has none, never run. An agent with no tree yet has what kept it from being made
   * forgotten (a refused discovery, a failed provisioning) and its project found again, then is
   * made one as its next start would be. A change waiting for your Switch is never switched; its
   * old tree may be recovered. Resolves once that is recorded or started; making a checkout goes
   * on after, and its end says the canvas changed.
   */
  async retry(canvas: CanvasId, agent: AgentId): Promise<void> {
    if (this.#closed) throw new Error('corrallm is closing: nothing is retried.');
    const root = this.projectRoot(canvas);
    if (root === undefined) return;
    const binding = this.#deps.workspaces.binding(canvas, agent);
    if (binding !== undefined) {
      const tree = this.#deps.workspaces.worktree(binding.workspace);
      if (tree?.state === 'setup') {
        await this.#deps.setups.prepare?.(tree.id);
        return;
      }
      if (tree?.state !== 'creating' && tree?.state !== 'error' && tree?.state !== 'missing')
        return;
      const { done } = await this.#deps.provisioner.startRetry(tree.id);
      const prepared = done.then(async (now) => {
        if (now.state === 'setup' && !this.#closed) await this.#deps.setups.prepare?.(now.id);
        return now;
      });
      this.#running.add(prepared);
      const settled = () => {
        this.#running.delete(prepared);
      };
      void prepared.then(settled, (error: unknown) => {
        settled();
        console.warn('A worktree couldn’t be made again:', error);
      });
      return;
    }
    const owner = workspaceOwner(await this.#deps.document(canvas), agent).key;
    this.#errors.delete(`${canvas}\0${owner}`);
    if (!this.#making.has(`${canvas}\0${owner}`)) {
      this.#repositories.delete(canvas);
      this.#found.delete(canvas);
    }
    const found = await this.#repository(canvas, root);
    if (found.kind !== 'repository' || this.projectRoot(canvas) !== root || this.#isClosed()) {
      this.#deps.changed?.(canvas);
      return;
    }
    void this.provision(canvas, owner).catch(() => undefined);
  }

  #watch(canvas: CanvasId): void {
    if (!this.#watching.has(canvas) && !this.#closed)
      this.#watching.set(
        canvas,
        this.#deps.projects.onAvailability(canvas, () => {
          this.invalidate(canvas);
        }),
      );
  }

  async #repository(canvas: CanvasId, root: TrustedPath): Promise<RepositoryFound> {
    const kept = this.#repositories.get(canvas);
    if (kept?.root === root) return kept.found;
    const found = this.#deps.provisioner
      .repository(root)
      .then(async (result): Promise<RepositoryFound> => {
        if (this.projectRoot(canvas) !== root || this.#isClosed())
          return {
            kind: 'refused',
            reason: 'missing',
            sentence: 'The project folder changed while it was being read: try again.',
          };
        if (result.kind === 'refused') return result;
        const link = this.#deps.workspaces.canvasRepository(canvas);
        const repository = result.kind === 'repository' ? result.record.id : null;
        if (link?.repository != null && link.repository !== repository)
          return {
            kind: 'refused',
            reason: 'redirected',
            sentence: 'The project folder is another repository now: choose it again.',
          };
        if (link?.repository !== repository)
          await this.#deps.workspaces.write((w) => {
            if (this.projectRoot(canvas) === root && !this.#isClosed())
              w.bindCanvas(canvas, repository);
          });
        return result;
      })
      .then((result) => {
        // What it found, for the list (once it is still the canvas's discovery): it changed.
        if (this.#repositories.get(canvas)?.found === found && this.projectRoot(canvas) === root) {
          this.#found.set(
            canvas,
            result.kind === 'refused'
              ? { kind: 'refused', sentence: result.sentence }
              : { kind: result.kind },
          );
          this.#deps.changed?.(canvas);
        }
        return result;
      });
    this.#repositories.set(canvas, { root, found });
    return found;
  }

  async workingDirectory(canvas: CanvasId, agent: AgentId): Promise<WorkingDirectory> {
    this.#watch(canvas);
    const root = this.projectRoot(canvas);
    if (root === undefined)
      return held(
        'no-project',
        'Choose a project folder for this canvas first (in the bar at the top left): its agents work in it.',
      );
    if (this.#closed) return held('error', 'corrallm is closing: no new work starts.');
    const document = await this.#deps.document(canvas);
    const owner = workspaceOwner(document, agent);
    const found = await this.#repository(canvas, root);
    if (this.projectRoot(canvas) !== root)
      return held('creating', 'The project folder changed: its workspace is being checked.');
    if (found.kind === 'refused')
      return held(found.reason === 'missing' ? 'missing' : 'error', found.sentence);
    if (found.kind === 'not-git')
      return { state: 'ready', cwd: root, workspace: null, generation: 0, branch: null };
    const binding = this.#deps.workspaces.binding(canvas, agent);
    if (binding?.desired !== null && binding?.desired !== undefined) {
      const generation = Math.max(
        ...this.#deps.workspaces
          .bindingsOf(canvas)
          .flatMap((one) =>
            one.desired !== null && one.desired.owner === binding.desired?.owner
              ? [one.desired.generation]
              : [],
          ),
      );
      return {
        ...held(
          'pending-change',
          'This agent still works in its previous worktree. Switch its pending workspace change in Needs you before sending new work.',
        ),
        need: `rebind/${encodeURIComponent(binding.desired.owner)}/${String(generation)}` as NeedId,
      };
    }
    if (binding === undefined) {
      const key = `${canvas}\0${owner.key}`;
      const error = this.#errors.get(key);
      if (error !== undefined) return held('error', error);
      void this.provision(canvas, owner.key).catch(() => undefined);
      return held('creating', 'Its worktree is being made. New work waits until it is ready.');
    }
    const checked = await this.#deps.provisioner.checkout(binding.workspace);
    if (this.#isClosed()) return held('error', 'corrallm is closing: no new work starts.');
    // No result from an old project/plan/async verification may admit a new start.
    const now = this.#deps.workspaces.binding(canvas, agent);
    if (
      this.projectRoot(canvas) !== root ||
      now?.generation !== binding.generation ||
      now.desired !== null
    )
      return held(
        'pending-change',
        'Its workspace binding changed while it was being checked: try again.',
      );
    // Bound to a tree still being made (a commit's fork, recorded with its members' bindings): its
    // open job is run, or joined, here too, should nothing run it yet (the queue was full). Its
    // end says the canvas changed; a refusal says nothing, so no listener loops on it.
    if (checked.state === 'held' && checked.reason === 'creating') {
      const job = this.#deps.workspaces.openJob(checked.worktree.id, 'create');
      if (job !== undefined) {
        const running = this.#deps.provisioner.run(job.id);
        this.#running.add(running);
        const done = () => {
          this.#running.delete(running);
        };
        // In particular a busy refusal sends no changed() notification.
        void running.then(done, done);
      }
    }
    if (checked.state === 'held')
      return held(
        checked.reason === 'missing'
          ? 'missing'
          : checked.reason === 'creating'
            ? 'creating'
            : 'error',
        `Its worktree is ${checked.reason}${checked.worktree.errorCode ? ` (${checked.worktree.errorCode})` : ''}. New work waits until it is ready.`,
      );
    if (checked.state === 'setup') {
      await this.#deps.setups.prepare?.(checked.worktree.id);
      const setup = this.#deps.workspaces.setup(checked.worktree.id);
      return {
        ...held(
          'setup',
          'Its worktree needs setup. Choose Run or Skip in Needs you before starting it.',
        ),
        ...(setup === undefined
          ? {}
          : { need: setupNeedId(checked.worktree.id, setup.generation) as NeedId }),
      };
    }
    return {
      state: 'ready',
      cwd: checked.cwd,
      workspace: binding.workspace,
      generation: binding.generation,
      branch: checked.branch,
    };
  }

  /** The base root contains other profiles' trees too: only this canvas's verified trees are revealable. */
  async allowsReveal(canvas: CanvasId, file: string): Promise<boolean> {
    const root = this.projectRoot(canvas);
    if (root === undefined) return false;
    const base = await realpath(root).catch(() => undefined);
    if (base === undefined) return false;
    const owned = path.join(base, '.corral', 'worktrees');
    if (!inside(owned, file)) return true; // FileRevealer already checked base containment.
    for (const tree of this.#deps.workspaces.worktreesOf(canvas)) {
      if (!inside(tree.path, file)) continue;
      const checked = await this.#deps.provisioner.checkout(tree.id);
      if (checked.state !== 'held' && inside(checked.cwd, file)) return true;
    }
    return false;
  }

  /** Discover the picked root without allocating an agent workspace. */
  async discover(canvas: CanvasId): Promise<void> {
    const root = this.projectRoot(canvas);
    if (root !== undefined) await this.#repository(canvas, root);
  }

  /** Shared by starts and the C7 Switch; the C services own all Git, verification and setup policy. */
  provision(canvas: CanvasId, owner: WorkspaceOwnerKey): Promise<WorktreeRecord> {
    const key = `${canvas}\0${owner}`;
    const going = this.#making.get(key);
    if (going) return going;
    const root = this.projectRoot(canvas);
    const made = (async () => {
      if (root === undefined || this.#isClosed()) throw new Error('Choose a project folder first.');
      const found = await this.#repository(canvas, root);
      if (found.kind !== 'repository')
        throw new Error(
          found.kind === 'refused' ? found.sentence : 'The project folder is not a repository.',
        );
      // A new tree forks what its plan says (B9a Design §3): where a member moving to it works
      // now (a split, at your Switch), else the project's HEAD (an independent add).
      const from = forkSource(
        this.#deps.workspaces,
        canvas,
        await this.#deps.document(canvas),
        owner,
      );
      const tree = await this.#deps.provisioner.provision({
        canvas,
        repository: found.record,
        owner,
        ...(from === undefined ? {} : { from }),
        within: (w, tree) => {
          if (this.projectRoot(canvas) !== root || this.#isClosed())
            throw new Error('The project changed before its workspace intent was recorded.');
          const document = this.#deps.documentNow(canvas);
          if (document === undefined) throw new Error('Its canvas is no longer loaded.');
          for (const node of document.nodes)
            if (
              node.type === 'agent' &&
              workspaceOwner(document, node.id).key === tree.owner &&
              w.binding(canvas, node.id) === undefined
            )
              w.bind(canvas, node.id, tree.id);
        },
      });
      if (this.projectRoot(canvas) !== root || this.#isClosed()) return tree;
      await this.#deps.document(canvas);
      // Re-read membership in the write lane: a queued write cannot bind a deleted member.
      await this.#deps.workspaces.write((w) => {
        if (this.projectRoot(canvas) !== root) return;
        const document = this.#deps.documentNow(canvas);
        if (document === undefined) return;
        const members = document.nodes.filter(
          (node) => node.type === 'agent' && workspaceOwner(document, node.id).key === tree.owner,
        );
        if (members.length === 0) {
          w.retain(tree.id);
          return;
        }
        for (const member of members)
          if (w.binding(canvas, member.id) === undefined) w.bind(canvas, member.id, tree.id);
      });
      if (tree.state === 'setup') await this.#deps.setups.prepare?.(tree.id);
      return tree;
    })()
      .catch((error: unknown) => {
        this.#errors.set(
          key,
          error instanceof Error ? error.message : 'Its workspace could not be made.',
        );
        throw error;
      })
      .finally(() => {
        this.#making.delete(key);
        this.changed(canvas);
      });
    this.#making.set(key, made);
    // Its tree is being made (worktree.list says so); its end says the canvas changed again.
    this.#deps.changed?.(canvas);
    return made;
  }

  reconcile(): Promise<void> {
    this.#recovering ??= (async () => {
      await this.#deps.provisioner.reconcile();
      if (!this.#closed) await this.#deps.setups.reconcile?.();
    })();
    return this.#recovering;
  }

  stop(): void {
    this.#closed = true;
    for (const stop of this.#watching.values()) stop();
    this.#watching.clear();
    this.#listeners.clear();
  }

  async close(): Promise<void> {
    this.stop();
    await Promise.allSettled([...this.#making.values(), ...this.#running, this.#recovering]);
  }
}

function held(
  reason: Extract<WorkingDirectory, { state: 'held' }>['reason'],
  sentence: string,
): Extract<WorkingDirectory, { state: 'held' }> {
  return { state: 'held', reason, sentence };
}

function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}
