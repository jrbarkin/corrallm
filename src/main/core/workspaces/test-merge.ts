import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { mintTrustedPath } from '../host';
import type { TrustedPath } from '../host';
import { WorkspaceGate } from './gate';
import type { TreeKey } from './gate';
import type { GitRunner } from './git';
import { MergeService } from './merge';
import type { MergePoint, MergeRequest, MergeServiceDeps } from './merge';
import { temporaryIndexes } from './merge-index';
import { MergeJournal } from './merge-journal';
import { ProvisioningQueue } from './queue';
import type { RepositoryRecord, WorktreeRecord } from './store';
import { commit, git } from './test-git';
import { CANVAS, testWorkspaces } from './test-workspace';
import type { TestWorkspaces } from './test-workspace';

/*
 * For the merge service's tests (B9b Design §9.3): a throwaway profile and repository (your
 * picked checkout, on main, with your Git identity configured), an agent of the canvas bound to a
 * ready workspace of its own, and the service over them, with a gate whose writers a test sets.
 * A restart is a new service over the same profile: its queue and gate anew, as a new core's are.
 */

export interface MergeWorld extends TestWorkspaces {
  /** Your picked checkout: the repository's main checkout, or a linked one. */
  picked: string;
  /** The agent's workspace (ready), its checkout and the repository's record. */
  tree: WorktreeRecord;
  cwd: TrustedPath;
  record: RepositoryRecord;
  /** Who may be writing in the agent's tree now, by agent: what the gate's writers say. */
  writing: Map<string, string>;
  /** Agents (beside the builder) and the trees each works in. */
  trees: Map<string, TreeKey[]>;
  gate: WorkspaceGate;
  queue: ProvisioningQueue;
  journal: MergeJournal;
  /** The service as the core composes it (a fresh one is a restart). */
  service: MergeService;
  /** A new service over the same profile, as a restarted core makes it: a new queue and gate. */
  restart(changes?: Partial<MergeServiceDeps>): MergeService;
  /** Git, as a test runs it. */
  g(cwd: string, ...args: string[]): string;
  /** Writes `files` in `at` (null deletes one) and commits them all: the new HEAD. */
  work(at: string, files: Record<string, string | null>, message?: string): string;
  /** A request with the pins read now (what the caller saw), changed as given. */
  request(changes?: Partial<MergeRequest>): MergeRequest;
}

/** Your Git identity, as the picked checkout's configuration has it. */
export const YOU = { name: 'You Person', email: 'you@example.invalid' };

export async function mergeWorld({
  files = { 'README.md': 'hello\n', '.gitignore': '*.log\nbuild/\n' },
  init = [],
  identity = true,
  deps = {},
  git: runner,
  linked,
}: {
  files?: Record<string, string>;
  init?: readonly string[];
  identity?: boolean;
  deps?: Partial<MergeServiceDeps>;
  /** The runner the service uses, if not the world's. */
  git?: (made: TestWorkspaces) => GitRunner;
  /** Your picked checkout a linked worktree of the repository, on a branch of this name. */
  linked?: string;
} = {}): Promise<MergeWorld> {
  const made = await testWorkspaces(files, {}, init);
  const g = (cwd: string, ...args: string[]) => git(cwd, made.env, ...args).trim();
  if (identity) {
    g(made.app, 'config', 'user.name', YOU.name);
    g(made.app, 'config', 'user.email', YOU.email);
  }
  const picked = linked === undefined ? made.app : path.join(made.root, 'linked');
  if (linked !== undefined) g(made.app, 'worktree', 'add', '-q', '-b', linked, picked);
  const found = await made.provisioner.repository(picked);
  if (found.kind !== 'repository') throw new Error(JSON.stringify(found));
  const record = found.record;
  const provisioned = await made.provisioner.provision({
    canvas: CANVAS,
    repository: record,
    owner: 'agent/builder',
  });
  const checkout = await made.provisioner.checkout(provisioned.id);
  if (checkout.state !== 'setup') throw new Error(`Not made: ${JSON.stringify(checkout)}`);
  const { worktree: made1, cwd } = checkout;
  await made.workspaces.write((w) => {
    w.bindCanvas(CANVAS, record.id);
    w.bind(CANVAS, 'builder', made1.id);
    w.transition(made1.id, { from: 'setup', to: 'ready' });
  });
  const tree = made.workspaces.worktree(made1.id);
  if (tree === undefined) throw new Error('No workspace.');
  const writing = new Map<string, string>();
  const trees = new Map<string, TreeKey[]>([['builder', [`workspace:${tree.id}`]]]);
  const gateOf = () =>
    new WorkspaceGate({
      canvases: () => [CANVAS],
      agents: () => [...trees.keys()],
      session: () => undefined,
      trees: (_canvas, agent) => Promise.resolve(trees.get(agent) ?? []),
      writing: (_canvas, agent) => writing.get(agent),
      nameOf: (_canvas, agent) => (agent === 'builder' ? 'Builder' : agent),
    });
  const serviceOf = (
    gate: WorkspaceGate,
    queue: ProvisioningQueue,
    changes: Partial<MergeServiceDeps> = {},
  ) =>
    new MergeService({
      git: runner?.(made) ?? made.git,
      workspaces: made.workspaces,
      journal: new MergeJournal({ store: made.store }),
      queue,
      gate,
      projectRoot: () => mintTrustedPath(picked),
      pickedRoot: () => Promise.resolve(mintTrustedPath(picked)),
      copied: () => [],
      running: () => true,
      member: () => true,
      nameOf: (_canvas, agent) => (agent === 'builder' ? 'Builder' : agent),
      indexes: temporaryIndexes(made.profile),
      ...changes,
    });
  const gate = gateOf();
  const queue = new ProvisioningQueue();
  const world: MergeWorld = {
    ...made,
    picked,
    tree,
    cwd,
    record,
    writing,
    trees,
    gate,
    queue,
    journal: new MergeJournal({ store: made.store }),
    service: serviceOf(gate, queue, deps),
    restart: (changes = {}) => {
      world.gate = gateOf();
      world.queue = new ProvisioningQueue();
      world.service = serviceOf(world.gate, world.queue, changes);
      return world.service;
    },
    g,
    work: (at, changes, message = 'work') => {
      for (const [file, text] of Object.entries(changes)) {
        const full = path.join(at, file);
        if (text === null) rmSync(full, { recursive: true, force: true });
        else {
          mkdirSync(path.dirname(full), { recursive: true });
          writeFileSync(full, text);
        }
      }
      g(at, 'add', '-A');
      commit(at, made.env, message);
      return g(at, 'rev-parse', 'HEAD');
    },
    request: (changes = {}) => ({
      canvas: CANVAS,
      agent: 'builder',
      source: { ref: tree.branchRef, oid: g(made.app, 'rev-parse', tree.branchRef) },
      into: {
        ref: g(picked, 'symbolic-ref', 'HEAD'),
        oid: g(picked, 'rev-parse', 'HEAD'),
      },
      request: randomUUID(),
      caller: { key: 'you', requester: 'you' },
      ...changes,
    }),
  };
  return world;
}

/** A fault hook that stops at `point` once (a crash there: it never resumes), else passes. */
export function crashAt(point: MergePoint): {
  fault: (at: MergePoint) => Promise<void>;
  reached: Promise<void>;
} {
  const reached = Promise.withResolvers<undefined>();
  return {
    fault: (at) => {
      if (at !== point) return Promise.resolve();
      reached.resolve(undefined);
      return new Promise<void>(() => undefined);
    },
    reached: reached.promise.then(() => undefined),
  };
}

/** A fault hook that pauses at `point` until `resume` is called. */
export function pauseAt(point: MergePoint): {
  fault: (at: MergePoint) => Promise<void>;
  reached: Promise<void>;
  resume: () => void;
} {
  const reached = Promise.withResolvers<undefined>();
  const resumed = Promise.withResolvers<undefined>();
  return {
    fault: async (at) => {
      if (at !== point) return;
      reached.resolve(undefined);
      await resumed.promise;
    },
    reached: reached.promise.then(() => undefined),
    resume: () => {
      resumed.resolve(undefined);
    },
  };
}

/** Writes `text` to `file` under `at`, making its folders. */
export function put(at: string, file: string, text: string): void {
  mkdirSync(path.dirname(path.join(at, file)), { recursive: true });
  writeFileSync(path.join(at, file), text);
}
