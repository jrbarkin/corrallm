import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createCore } from './core';
import type { Core, CoreConfig } from './core';
import { FakeConnector } from '../sessions/fake';
import { keepCanvases, readOnDisk } from './store/test-store';
import { CALLERS, CANVAS, NO_DESKTOP } from './test-registry';
import { WorkspaceGit } from './workspaces/runtime-git';
import { commit, git, gitEnvironment, makeRepository, scratch } from './workspaces/test-git';

let root: string;
let remove: () => void;
let core: Core;
let fake: FakeConnector;
let project: string;
let config: CoreConfig;
let env: Record<string, string>;
beforeEach(async () => {
  ({ root, remove } = scratch('corrallm-workspaces-composed-'));
  project = path.join(root, 'project');
  env = gitEnvironment(path.join(root, 'home'));
  makeRepository(project, env, { 'base.txt': 'base\n' });
  const profile = path.join(root, 'profile');
  mkdirSync(profile);
  const file = path.join(root, 'canvas.corral');
  writeFileSync(
    file,
    JSON.stringify({
      format: 'corrallm',
      version: 2,
      id: CANVAS,
      nodes: ['a', 'b'].map((id, i) => ({
        id,
        kind: 'agent',
        label: id,
        position: { x: i * 300, y: 0 },
        adapter: 'codex',
        connection: 'codex.app-server',
      })),
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
  core = await createCore(config, NO_DESKTOP);
  await core.engines.open(CANVAS);
});
afterEach(async () => {
  await core.close();
  vi.restoreAllMocks();
  remove();
});

async function skip(agent: string): Promise<void> {
  const opened = await core.call('session.open', { canvas: CANVAS, agent }, CALLERS.you);
  expect(opened).toMatchObject({ ok: false, error: { code: 'unavailable' } });
  await vi.waitFor(
    async () => {
      const needs = await core.call('needs', { canvas: CANVAS }, CALLERS.you);
      expect(needs.ok && needs.value.items.some((item) => item.id.startsWith('setup/'))).toBe(true);
    },
    { timeout: 15000 },
  );
  const result = await core.call('needs', { canvas: CANVAS }, CALLERS.you);
  if (!result.ok) throw new Error(result.error.sentence);
  const setup = result.value.items.find((item) => item.id.startsWith('setup/'));
  expect(
    setup,
    'the composed setup service must offer the workspace before its CLI starts',
  ).toBeDefined();
  if (!setup) throw new Error('No setup');
  expect(
    await core.call(
      'reply',
      { canvas: CANVAS, to: setup.id, answer: { choice: 'skip' } },
      CALLERS.you,
    ),
  ).toMatchObject({ ok: true });
}

it('holds starts for setup, then runs two ungrouped agents in distinct verified worktrees', async () => {
  await skip('a');
  expect(fake.started).toHaveLength(0);
  expect(
    await core.call('session.open', { canvas: CANVAS, agent: 'a' }, CALLERS.you),
  ).toMatchObject({ ok: true });
  await skip('b');
  expect(
    await core.call('session.open', { canvas: CANVAS, agent: 'b' }, CALLERS.you),
  ).toMatchObject({ ok: true });
  const [a, b] = fake.started;
  expect(a?.cwd).not.toBe(project);
  expect(b?.cwd).not.toBe(project);
  expect(a?.cwd).not.toBe(b?.cwd);
  expect(a?.cwd).toContain(path.join(project, '.corral', 'worktrees'));
  if (!a || !b) throw new Error('Missing fake sessions');
  writeFileSync(path.join(a.cwd, 'only-a.txt'), 'a');
  writeFileSync(path.join(b.cwd, 'only-b.txt'), 'b');
  expect(
    await core.call('project.files', { canvas: CANVAS, agent: 'a', query: 'only-' }, CALLERS.you),
  ).toMatchObject({ ok: true, value: { items: ['only-a.txt'] } });
  expect(
    await core.call('project.files', { canvas: CANVAS, agent: 'b', query: 'only-' }, CALLERS.you),
  ).toMatchObject({ ok: true, value: { items: ['only-b.txt'] } });
  const foreign = path.join(project, '.corral', 'worktrees', 'another-profile', 'secret');
  mkdirSync(path.dirname(foreign), { recursive: true });
  writeFileSync(foreign, 'secret');
  expect(
    await core.call('link.reveal', { url: pathToFileURL(foreign).href }, CALLERS.you),
  ).toMatchObject({ ok: true, value: { revealed: false } });
  expect(
    await core.call(
      'link.reveal',
      { url: pathToFileURL(path.join(a.cwd, 'only-a.txt')).href },
      CALLERS.you,
    ),
  ).toMatchObject({ ok: true, value: { revealed: true } });
}, 30000);

it('keeps a message pending through provisioning and setup and explains its hold', async () => {
  const result = await core.call(
    'message',
    { canvas: CANVAS, to: 'a', body: 'hello' },
    CALLERS['outside-write'],
  );
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) throw new Error(result.error.sentence);
  const mail = await core.engines.messagesOf(CANVAS);
  await vi.waitFor(
    () => {
      expect(mail.get(result.value.id)?.state).toBe('pending');
      expect(
        mail
          .all()
          .some((message) => message.kind === 'notice' && message.body.includes('worktree')),
      ).toBe(true);
    },
    { timeout: 15000 },
  );
  expect(fake.started).toHaveLength(0);
}, 30000);

it('keeps the previous session through a pending rebind and closes it only at Switch', async () => {
  await skip('a');
  await core.call('session.open', { canvas: CANVAS, agent: 'a' }, CALLERS.you);
  await skip('b');
  await core.call('session.open', { canvas: CANVAS, agent: 'b' }, CALLERS.you);
  const old = fake.started[1]?.cwd;
  const second = fake.sessions[1];
  if (!second) throw new Error('No second session');
  const close = vi.spyOn(second, 'close');
  expect(
    await core.call(
      'canvas.group',
      { canvas: CANVAS, nodes: ['a', 'b'], kind: 'frame' },
      CALLERS.you,
    ),
  ).toMatchObject({ ok: true });
  expect(close).not.toHaveBeenCalled();
  const needs = await core.call('needs', { canvas: CANVAS }, CALLERS.you);
  if (!needs.ok) throw new Error(needs.error.sentence);
  const rebind = needs.value.items.find((item) => item.id.startsWith('rebind/'));
  if (!rebind) throw new Error('Missing Switch');
  const send = vi.spyOn(second, 'send');
  const pending = await core.call(
    'message',
    { canvas: CANVAS, to: 'b', body: 'wait for Switch' },
    CALLERS['outside-write'],
  );
  if (!pending.ok) throw new Error(pending.error.sentence);
  const mail = await core.engines.messagesOf(CANVAS);
  await vi.waitFor(() => {
    expect(
      mail.all().some((one) => one.kind === 'notice' && one.body.includes('previous worktree')),
    ).toBe(true);
  });
  expect(mail.get(pending.value.id)?.state).toBe('pending');
  expect(send).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
  expect(
    await core.call(
      'reply',
      { canvas: CANVAS, to: rebind.id, answer: { choice: 'switch' } },
      CALLERS.you,
    ),
  ).toMatchObject({ ok: true });
  expect(close).toHaveBeenCalledOnce();
  expect(
    await core.call('session.open', { canvas: CANVAS, agent: 'b' }, CALLERS.you),
  ).toMatchObject({ ok: true });
  expect(fake.started.at(-1)?.cwd).not.toBe(old);
  expect(fake.started.at(-1)?.cwd).toBe(fake.started[0]?.cwd);
}, 30000);

it('proposes deleting an agent whose composed workspace holds work', async () => {
  await skip('a');
  await core.call('session.open', { canvas: CANVAS, agent: 'a' }, CALLERS.you);
  const cwd = fake.started[0]?.cwd;
  if (!cwd) throw new Error('No checkout');
  writeFileSync(path.join(cwd, 'uncommitted.txt'), 'keep this');
  await core.call('canvas.delete', { canvas: CANVAS, nodes: ['a'] }, CALLERS.you);
  const needs = await core.call('needs', { canvas: CANVAS }, CALLERS.you);
  expect(needs).toMatchObject({
    ok: true,
    value: {
      items: expect.arrayContaining([expect.objectContaining({ kind: 'proposal' })]) as unknown,
    },
  });
  const canvas = await core.call('canvas.get', { canvas: CANVAS }, CALLERS.you);
  expect(canvas).toMatchObject({
    ok: true,
    value: { nodes: expect.arrayContaining([expect.objectContaining({ id: 'a' })]) as unknown },
  });
}, 30000);

it('recovers the same intent and binding after provisioning stops between Git phases', async () => {
  // The original, called below with the spied instance as its `this`.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const run = WorkspaceGit.prototype.run;
  const stop = vi.spyOn(WorkspaceGit.prototype, 'run').mockImplementation(function (
    this: WorkspaceGit,
    call,
  ) {
    if (call.args[0] === 'read-tree')
      return Promise.reject(new Error('Simulated crash before population'));
    return run.call(this, call);
  });
  await core.call('session.open', { canvas: CANVAS, agent: 'a' }, CALLERS.you);
  await vi.waitFor(
    () => {
      expect(stop.mock.calls.some(([call]) => call.args[0] === 'read-tree')).toBe(true);
    },
    { timeout: 15000 },
  );
  await core.close();
  stop.mockRestore();
  core = await createCore(config, NO_DESKTOP);
  await core.engines.open(CANVAS);
  await skip('a');
  expect(
    await core.call('session.open', { canvas: CANVAS, agent: 'a' }, CALLERS.you),
  ).toMatchObject({ ok: true });
  expect(fake.started).toHaveLength(1);
}, 30000);

it('forks a spawned agent’s worktree from its source’s committed HEAD, through a batch', async () => {
  await skip('a');
  await core.call('session.open', { canvas: CANVAS, agent: 'a' }, CALLERS.you);
  const cwd = fake.started[0]?.cwd;
  if (!cwd) throw new Error('No checkout');
  writeFileSync(path.join(cwd, 'committed.txt'), 'kept\n');
  git(cwd, env, 'add', '--', 'committed.txt');
  commit(cwd, env, 'work');
  const head = git(cwd, env, 'rev-parse', 'HEAD').trim();
  writeFileSync(path.join(cwd, 'uncommitted.txt'), 'not forked\n');
  const batch = await core.call(
    'canvas.batch',
    { canvas: CANVAS, ops: [{ op: 'canvas.spawnAgent', args: { from: 'a', relation: 'peer' } }] },
    CALLERS.you,
  );
  if (!batch.ok) throw new Error(batch.error.sentence);
  const [spawned] = (batch.value as { results: readonly unknown[] }).results;
  const id = (spawned as { id?: string } | undefined)?.id;
  if (id === undefined) throw new Error('No spawned agent');
  // In the batch's one commit: the spawned agent bound to a tree of its own, forked from a's.
  const rows = readOnDisk(path.join(root, 'profile'), (disk) =>
    disk
      .prepare(
        `SELECT b.agent_id, w.base_oid, w.forked_from, s.workspace_id AS source
           FROM agent_worktree b JOIN worktree w ON w.id = b.workspace_id
           JOIN agent_worktree s ON s.canvas_id = b.canvas_id AND s.agent_id = 'a'
          WHERE b.canvas_id = ? AND b.agent_id = ?`,
      )
      .all(CANVAS, id),
  );
  expect(rows).toEqual([
    {
      agent_id: id,
      base_oid: head,
      forked_from: rows[0]?.source,
      source: expect.any(String) as unknown,
    },
  ]);
  await skip(id);
  expect(await core.call('session.open', { canvas: CANVAS, agent: id }, CALLERS.you)).toMatchObject(
    { ok: true },
  );
  const forked = fake.started.at(-1)?.cwd;
  if (!forked) throw new Error('No forked checkout');
  expect(forked).not.toBe(cwd);
  expect(readFileSync(path.join(forked, 'committed.txt'), 'utf8')).toBe('kept\n');
  expect(existsSync(path.join(forked, 'uncommitted.txt'))).toBe(false);
}, 30000);
