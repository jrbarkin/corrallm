import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';

import { createCore } from './core';
import type { Core, CoreConfig } from './core';
import * as ops from './ops';
import type { WorktreeServices } from './ops/worktree';
import { FakeConnector } from '../sessions/fake';
import * as connectors from '../sessions/connectors';
import type { Conversations } from '../sessions/adapter';
import { keepCanvases, readOnDisk, writeOnDisk } from './store/test-store';
import { CALLERS, CANVAS, NO_DESKTOP } from './test-registry';
import { MergeService } from './workspaces/merge';
import { WorkspaceGit } from './workspaces/runtime-git';
import { commit, git, gitEnvironment, makeRepository, scratch } from './workspaces/test-git';

/*
 * B9b's merge service as createCore composes it (Design §9 C5, C8): over the core's one runner,
 * provisioning queue, mutation gate and journal, for `branch.merge` (X2) to register over the
 * worktree services' `merge`; a merge a crash left going on reconciled as the core starts; and
 * quitting waiting for a merge past its point of no return before the workspaces' Git stops.
 */

let root: string;
let remove: () => void;
let core: Core | undefined;
let fake: FakeConnector;
let project: string;
let profile: string;
let config: CoreConfig;
let env: Record<string, string>;
let services: MockInstance<typeof ops.implementations>;

beforeEach(async () => {
  ({ root, remove } = scratch('corrallm-merge-composed-'));
  project = path.join(root, 'project');
  env = gitEnvironment(path.join(root, 'home'));
  makeRepository(project, env, { 'base.txt': 'base\n' });
  git(project, env, 'config', 'user.name', 'You Person');
  git(project, env, 'config', 'user.email', 'you@example.invalid');
  profile = path.join(root, 'profile');
  mkdirSync(profile);
  const file = path.join(root, 'canvas.corral');
  writeFileSync(
    file,
    JSON.stringify({
      format: 'corrallm',
      version: 2,
      id: CANVAS,
      nodes: [
        {
          id: 'a',
          kind: 'agent',
          label: 'a',
          position: { x: 0, y: 0 },
          adapter: 'codex',
          connection: 'codex.app-server',
        },
      ],
      links: [],
    }),
  );
  await keepCanvases(profile, { [CANVAS]: { file, project } });
  fake = new FakeConnector({ adapter: 'codex' });
  config = {
    profile,
    app: { name: 'corrallm', version: '1' },
    distribution: 'local',
    check: true,
    watchFolder: () => ({ close: () => undefined }),
    children: {
      platform: 'darwin',
      inspect: (pid) => ({ started: 1, group: pid }),
      alive: () => false,
      signal: () => undefined,
      wait: () => Promise.resolve(),
      pause: () => undefined,
      now: Date.now,
    },
    sessions: { connectors: { 'codex.app-server': fake }, environment: () => Promise.resolve(env) },
  };
  vi.spyOn(connectors, 'createConversations').mockReturnValue({
    codex: { list: vi.fn<Conversations['list']>().mockResolvedValue([]) },
  });
  services = vi.spyOn(ops, 'implementations');
});
afterEach(async () => {
  await core?.close();
  core = undefined;
  vi.restoreAllMocks();
  remove();
});

async function start(): Promise<Core> {
  core = await createCore(config, NO_DESKTOP);
  await core.engines.open(CANVAS);
  return core;
}

/** The worktree services createCore composed, as X2's `branch.merge` will reach them. */
function worktrees(): WorktreeServices {
  const composed = services.mock.calls.at(-1)?.[0].worktrees;
  if (composed === undefined) throw new Error('No worktree services.');
  return composed;
}

/** Agent a's worktree made and set up (its setup skipped), its session started: its checkout. */
async function ready(running: Core): Promise<string> {
  expect(
    await running.call('session.open', { canvas: CANVAS, agent: 'a' }, CALLERS.you),
  ).toMatchObject({ ok: false });
  await vi.waitFor(
    async () => {
      const needs = await running.call('needs', { canvas: CANVAS }, CALLERS.you);
      expect(needs.ok && needs.value.items.some((item) => item.id.startsWith('setup/'))).toBe(true);
    },
    { timeout: 15000 },
  );
  const needs = await running.call('needs', { canvas: CANVAS }, CALLERS.you);
  if (!needs.ok) throw new Error(needs.error.sentence);
  const setup = needs.value.items.find((item) => item.id.startsWith('setup/'));
  if (setup === undefined) throw new Error('No setup');
  await running.call(
    'reply',
    { canvas: CANVAS, to: setup.id, answer: { choice: 'skip' } },
    CALLERS.you,
  );
  expect(
    await running.call('session.open', { canvas: CANVAS, agent: 'a' }, CALLERS.you),
  ).toMatchObject({ ok: true });
  const cwd = fake.started[0]?.cwd;
  if (cwd === undefined) throw new Error('No session');
  return cwd;
}

const g = (cwd: string, ...args: string[]) => git(cwd, env, ...args).trim();

it('merges an agent’s branch through the composed worktree services', async () => {
  const running = await start();
  const cwd = await ready(running);
  writeFileSync(path.join(cwd, 'agent.txt'), 'agent\n');
  g(cwd, 'add', '-A');
  commit(cwd, env, 'agent work');
  const ref = g(cwd, 'symbolic-ref', 'HEAD');
  const merge = worktrees().merge;
  if (merge === undefined) throw new Error('No merge service composed.');

  const result = await merge({
    canvas: CANVAS,
    agent: 'a',
    source: { ref, oid: g(cwd, 'rev-parse', 'HEAD') },
    into: { ref: 'refs/heads/main', oid: g(project, 'rev-parse', 'main') },
    request: randomUUID(),
    caller: { key: 'you', requester: 'you' },
  });

  expect(result).toMatchObject({ ok: true, value: { outcome: 'merged' } });
  expect(g(project, 'log', '-1', '--format=%s')).toMatch(/^Merge branch 'corrallm\//);
  expect(
    readOnDisk(profile, (disk) => disk.prepare('SELECT outcome FROM merge_job').all()),
  ).toEqual([{ outcome: 'merged' }]);
}, 60000);

it('reconciles a merge a crash left going on as the core starts: never installed, so interrupted', async () => {
  const running = await start();
  const cwd = await ready(running);
  await running.close();
  core = undefined;
  // What a core that crashed after recording its merge, and before installing it, left on disk.
  const tip = g(cwd, 'rev-parse', 'HEAD');
  const before = g(project, 'rev-parse', 'main');
  const tree = g(project, 'rev-parse', `${before}^{tree}`);
  const m = g(
    project,
    '-c',
    'user.name=You',
    '-c',
    'user.email=you@example.invalid',
    'commit-tree',
    '-p',
    before,
    '-p',
    tip,
    '-m',
    'merge',
    tree,
  );
  const records = readOnDisk(profile, (disk) => ({
    workspace: disk.prepare('SELECT id, repository_id, branch_ref FROM worktree').get(),
    repository: disk.prepare('SELECT identity FROM repository').get(),
  }));
  const real = realpathSync(project);
  const intent = JSON.stringify({
    version: 1,
    args: 'a'.repeat(64),
    requester: 'you',
    destination: {
      root: real,
      gitDir: path.join(real, '.git'),
      commonDir: path.join(real, '.git'),
      identity: records.repository?.identity,
      branch: 'refs/heads/main',
      oid: before,
    },
    merge: { tree, commit: m },
    source: {
      ref: records.workspace?.branch_ref,
      tip,
      gitDir: path.join(real, '.git', 'worktrees', String(records.workspace?.id)),
      checkpoint: null,
      digest: null,
    },
    origHead: null,
  });
  const id = randomUUID();
  writeOnDisk(
    profile,
    `INSERT INTO merge_job (id, canvas_id, agent_id, workspace_id, repository_id, caller_key,
       request_id, intent, intent_hash, phase, created_at, updated_at)
     VALUES ('${id}', '${CANVAS}', 'a', '${String(records.workspace?.id)}',
       '${String(records.workspace?.repository_id)}', 'you', '${randomUUID()}',
       '${intent.replaceAll("'", "''")}',
       '${createHash('sha256').update(intent).digest('hex')}', 'installing', 1, 1)`,
  );

  await start();

  await vi.waitFor(
    () => {
      expect(
        readOnDisk(profile, (disk) =>
          disk.prepare('SELECT outcome, sentence FROM merge_job WHERE id = ?').get(id),
        ),
      ).toMatchObject({
        outcome: 'interrupted',
        sentence: expect.stringMatching(/nothing changed/) as unknown,
      });
    },
    { timeout: 15000 },
  );
  expect(g(project, 'rev-parse', 'main')).toBe(before);
}, 60000);

it('quits only once a merge past its point of no return settled, before the workspaces’ Git stops', async () => {
  const settled = Promise.withResolvers<undefined>();
  const close = vi.spyOn(MergeService.prototype, 'close').mockReturnValue(settled.promise);
  const stop = vi.spyOn(WorkspaceGit.prototype, 'stop');
  const running = await start();
  let closed = false;
  const closing = running.close().then(() => {
    closed = true;
  });
  await vi.waitFor(() => {
    expect(close).toHaveBeenCalled();
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(stop).not.toHaveBeenCalled();
  expect(closed).toBe(false);
  settled.resolve(undefined);
  await closing;
  core = undefined;
  expect(stop).toHaveBeenCalled();
}, 60000);
