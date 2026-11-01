import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, expect, it } from 'vitest';

import { newCanvasId } from '../../shared/canvas';
import { CanvasMemory } from '../memory';
import { RunJournal } from '../run-journal';
import { CATALOG, DEFAULT_ADAPTER } from '../sessions/adapters';
import { Documents } from '../core/canvas/documents';
import { commitDocument } from '../core/canvas/test-documents';
import { MessageStore, MessageTable } from '../core/delivery/messages';
import { migrate, MIGRATIONS, SCHEMA } from '../core/store/migrations';
import { APPLICATION_ID, STORE_FILE } from '../core/store/open';
import { connect } from '../core/store/sqlite';
import { SYSTEM_DEPS } from '../core/store/store';
import type { Store } from '../core/store/store';
import { madeAtSchema, openTestStore } from '../core/store/test-store';
import { dump } from '../core/store/dump';
import { WorkspaceStore } from '../core/workspaces/store';

const exec = promisify(execFile);
/** A checkpoint's submissions when it has none. */
const NONE = '{"version":1,"agents":[]}';
const BUNDLE = path.resolve('dist-cli/corrallm.cjs');
const canvas = newCanvasId();
let profile: string;
let store: Store;
let messages: MessageStore;
let documents: Documents;
let journal: RunJournal;

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-dump-'));
  // Only the dump may affect these hashes. The owner's idle checkpoint/snapshot would
  // legitimately rewrite core.db and its WAL while a slow CLI process starts.
  store = await openTestStore(profile, {
    ...SYSTEM_DEPS,
    later: () => () => undefined,
  });
  const memory = new CanvasMemory(store);
  documents = new Documents({ store, memory, catalog: CATALOG, defaultAdapter: DEFAULT_ADAPTER });
  documents.create(canvas, 'you');
  await commitDocument(documents, canvas, {
    id: canvas,
    arrange: false,
    nodes: [
      {
        id: 'a',
        type: 'agent',
        position: { x: 1, y: 2 },
        data: { label: 'Agent', adapter: 'codex', queue: [{ id: 'task', message: 'Work' }] },
      },
    ],
    links: [],
  });
  messages = new MessageStore(canvas, new MessageTable(store, memory), () => 1000);
  await messages.load();
  journal = new RunJournal({ store, memory, messages: () => Promise.resolve(messages) });
  await journal.save(canvas, (await journal.get(canvas)).token, {
    version: 2,
    state: '{}',
    messages: NONE,
    updatedAt: 1,
  });
  messages.add({
    from: 'you',
    to: 'agent:a',
    kind: 'text',
    origin: 'manual',
    state: 'pending',
    body: 'Hello\nthere',
  });
  await messages.durable();
});

afterEach(async () => {
  await store.close();
  await rm(profile, { recursive: true, force: true });
});

async function run(target = profile): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_NO_WARNINGS: '1' };
  delete env.CORRALLM_NATIVE_SELFTEST;
  try {
    return {
      code: 0,
      ...(await exec(process.execPath, [BUNDLE, 'dump', '--profile', target], { env })),
    };
  } catch (error) {
    const { code, stdout, stderr } = error as { code: number; stdout: string; stderr: string };
    return { code, stdout, stderr };
  }
}

async function bytes(): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(profile, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (name.endsWith('-shm')) continue; // SQLite readers participate in the shared WAL index.
    result[name] = createHash('sha256')
      .update(await readFile(path.join(profile, name)))
      .digest('hex');
  }
  return result;
}

it('dumps canvases with their document, runs and WAL messages without taking the owner’s lock or writing', async () => {
  const lock = path.join(profile, 'core.lock');
  await writeFile(lock, JSON.stringify({ owner: 'serve', pid: process.pid, started: Date.now() }));
  const before = await bytes();
  const result = await run();
  expect(result.code, result.stderr).toBe(0);
  expect(result.stderr).toBe('');
  const rows = result.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as unknown);
  expect(rows).toMatchObject([
    {
      type: 'canvas',
      data: { id: canvas },
      document: { nodes: [{ id: 'a', label: 'Agent' }], items: [{ id: 'task' }] },
    },
    {
      type: 'run',
      data: { canvas_id: canvas, state: { format: 3, run: {} }, updated_at: 1 },
    },
    {
      type: 'message',
      data: {
        canvas_id: canvas,
        origin: 'manual',
        body: 'Hello\nthere',
        display: null,
        resend_of: null,
        state: 'pending',
      },
    },
  ]);
  expect(await bytes()).toEqual(before);
});

it('refuses an unreadable newer database without changing it or printing a partial dump', async () => {
  await store.write(() => {
    store.exec(
      `PRAGMA user_version = ${String(SCHEMA + 1)}; UPDATE meta SET min_reader = ${String(SCHEMA + 1)}`,
    );
  });
  const before = await bytes();
  const result = await run();
  expect(result.code).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toMatch(/newer corrallm/);
  expect(await bytes()).toEqual(before);
});

it('does not create a missing profile or database', async () => {
  const before = await bytes();
  const result = await run(path.join(profile, 'missing'));
  expect(result.code).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toMatch(/could not|unable to open/i);
  expect(await bytes()).toEqual(before);
});

it('leaves a closed database unchanged, creating only SQLite’s empty reader sidecars', async () => {
  await store.close();
  const before = await bytes();
  expect((await run()).code).toBe(0);
  const after = await bytes();
  expect(after['core.db']).toBe(before['core.db']);
  expect(Object.keys(after).filter((name) => name !== 'core.db-wal')).toEqual(Object.keys(before));
  expect((await readFile(`${store.file}-wal`)).length).toBe(0);
});

it('holds one consistent read while awaiting a slow output pipe and the owner continues writing', async () => {
  const lines: string[] = [];
  await dump(store.file, async (line) => {
    lines.push(line);
    if (lines.length !== 1) return;
    await journal.save(canvas, (await journal.get(canvas)).token, {
      version: 2,
      state: '{"new":true}',
      messages: NONE,
      updatedAt: 2,
    });
    messages.add({
      from: 'you',
      to: 'agent:a',
      kind: 'text',
      origin: 'manual',
      state: 'pending',
      body: 'Later',
    });
    await messages.durable();
  });
  expect(lines.map((line) => JSON.parse(line) as unknown)).toMatchObject([
    { type: 'canvas' },
    { type: 'run', data: { state: { run: {} }, updated_at: 1 } },
    { type: 'message', data: { body: 'Hello\nthere' } },
  ]);
  expect(lines).toHaveLength(3);
});

it('dumps each repository with its setup, and each canvas’s workspace records, in the same read', async () => {
  const workspaces = new WorkspaceStore({ store, now: () => 1000 });
  const repository = '7c0e9a1e-1b6f-4b4f-9f3a-2d1c0b9a8e70';
  const workspace = '9d1c5a0e-0f4e-4c11-8a51-0b1f2e3d4c51';
  const job = 'c0ffee00-0000-4000-8000-000000000001';
  const hash = 'b'.repeat(64);
  await workspaces.write((w) => {
    w.addRepository({
      id: repository,
      pickedRoot: '/work/app',
      realRoot: '/work/app',
      commonDir: '/work/app/.git',
      identity: 'repository identity',
      rootKind: 'project',
      ownedRoot: '/work/app/.corral/worktrees/profile',
    });
    w.setProjectCommand(repository, 'make setup', 'posix');
    w.bindCanvas(canvas, repository);
    w.createWorktree({
      id: workspace,
      canvas,
      repository,
      owner: 'agent/a',
      path: `/work/app/.corral/worktrees/profile/${workspace}`,
      branchRef: `refs/heads/corrallm/profile/${workspace}`,
      baseCheckout: '/work/app',
      baseRef: 'refs/heads/main',
      baseOid: 'a'.repeat(40),
      forkedFrom: null,
    });
    w.bind(canvas, 'a', workspace);
    w.recordJob({
      id: job,
      workspace,
      kind: 'create',
      phase: 'intent',
      generation: 1,
      payload: { base: 'a'.repeat(40) },
    });
    w.offerSetup(workspace, {
      command: 'make setup',
      source: 'configured',
      specHash: hash,
      copyManifestHash: hash,
    });
  });
  const lines: string[] = [];
  await dump(store.file, (line) => {
    lines.push(line);
    return Promise.resolve();
  });
  expect(lines.map((line) => JSON.parse(line) as unknown)).toMatchObject([
    {
      type: 'repository',
      data: { id: repository, real_root: '/work/app', root_kind: 'project', generation: 0 },
      setup: { repository_id: repository, command: 'make setup', shell_kind: 'posix' },
    },
    {
      type: 'canvas',
      data: { id: canvas },
      repository: { canvas_id: canvas, repository_id: repository, generation: 1 },
      worktrees: [
        {
          id: workspace,
          owner_key: 'agent/a',
          state: 'creating',
          branch_ref: `refs/heads/corrallm/profile/${workspace}`,
          setup: { workspace_id: workspace, state: 'pending', command_snapshot: 'make setup' },
          // Its payload decoded, as other JSON columns are.
          jobs: [{ id: job, kind: 'create', phase: 'intent', payload: { base: 'a'.repeat(40) } }],
        },
      ],
      bindings: [{ agent_id: 'a', workspace_id: workspace, generation: 1000 }],
    },
    { type: 'run' },
    { type: 'message' },
  ]);
  expect(lines).toHaveLength(4);
});

it('dumps a schema-2 database without migrating it: no workspace records, conversations by agent', async () => {
  const older = await mkdtemp(path.join(tmpdir(), 'corrallm-dump-2-'));
  try {
    const old = madeAtSchema(older, 2);
    try {
      old
        .prepare('INSERT INTO canvas (id, project, used_at) VALUES (?, ?, 1)')
        .run(canvas, '/work');
      old
        .prepare(
          `INSERT INTO conversation (canvas_id, adapter, agent_id, native_id)
           VALUES (?, 'codex', 'a', 'thread')`,
        )
        .run(canvas);
    } finally {
      old.close();
    }
    const file = path.join(older, STORE_FILE);
    const before = await readFile(file);
    const lines: string[] = [];
    await dump(file, (line) => {
      lines.push(line);
      return Promise.resolve();
    });
    const [line, ...rest] = lines.map((one) => JSON.parse(one) as Record<string, unknown>);
    expect(rest).toEqual([]);
    expect(line).toMatchObject({
      type: 'canvas',
      data: { id: canvas, project: '/work' },
      conversations: [{ adapter: 'codex', agent_id: 'a', native_id: 'thread' }],
      document: null,
    });
    expect(Object.keys(line ?? {})).not.toContain('worktrees');
    expect(Object.keys(line ?? {})).not.toContain('repository');
    expect(await readFile(file)).toEqual(before);
    const schema = connect(file, { readOnly: true });
    try {
      expect(schema.prepare('PRAGMA user_version').get()).toEqual({ user_version: 2 });
    } finally {
      schema.close();
    }
  } finally {
    await rm(older, { recursive: true, force: true });
  }
});

it('dumps how each message came to be, what a view shows of it and what it resends', async () => {
  const original = messages.all()[0];
  if (original === undefined) throw new Error('No message');
  const resent = messages.add({
    from: 'you',
    to: 'agent:a',
    kind: 'text',
    origin: 'resend',
    display: { images: 1, requiresImages: true },
    body: 'Hello\nthere',
    state: 'pending',
    resendOf: original.id,
  });
  await messages.durable();
  const lines: string[] = [];
  await dump(store.file, (line) => {
    lines.push(line);
    return Promise.resolve();
  });
  expect(lines.map((line) => JSON.parse(line) as unknown).slice(-2)).toMatchObject([
    { type: 'message', data: { id: original.id, origin: 'manual', resend_of: null } },
    {
      type: 'message',
      data: {
        id: resent.id,
        origin: 'resend',
        // Decoded, as other JSON columns are.
        display: { images: 1, requiresImages: true },
        reply_to: null,
        resend_of: original.id,
      },
    },
  ]);
});

it('dumps a record’s settled decision decoded, as other JSON columns are', async () => {
  const record = messages.all()[0];
  if (record === undefined) throw new Error('No message');
  const settled = {
    v: 1,
    need: 'prompt/a/1/0f1e2d3c-4b5a-4968-8776-655443322110',
    prompt: { id: '0f1e2d3c-4b5a-4968-8776-655443322110', kind: 'form' },
    outcome: { type: 'form', action: 'decline' },
  };
  await store.write(() => {
    store
      .prepare('UPDATE message SET settled = ? WHERE id = ?')
      .run(JSON.stringify(settled), record.id);
  });
  const lines: string[] = [];
  await dump(store.file, (line) => {
    lines.push(line);
    return Promise.resolve();
  });
  expect(lines.map((line) => JSON.parse(line) as unknown).at(-1)).toMatchObject({
    type: 'message',
    data: { id: record.id, settled },
  });
});

it('dumps a schema-3 database without migrating it: its runs and messages as schema 3 kept them', async () => {
  const older = await mkdtemp(path.join(tmpdir(), 'corrallm-dump-3-'));
  try {
    const old = madeAtSchema(older, 3);
    const legacy = { version: 2, state: { version: 2 }, messages: { version: 1, agents: [] } };
    try {
      old.prepare('INSERT INTO canvas (id, used_at) VALUES (?, 1)').run(canvas);
      old
        .prepare('INSERT INTO run (canvas_id, state, updated_at) VALUES (?, ?, 1)')
        .run(canvas, JSON.stringify(legacy));
      old
        .prepare(
          `INSERT INTO message (id, canvas_id, from_party, to_party, kind, body, reply_to, state,
             sent_at, told)
           VALUES ('resent', ?, 'you', 'agent:a', 'text', 'Hello', 'original', 'pending', 1,
             'resend:original')`,
        )
        .run(canvas);
    } finally {
      old.close();
    }
    const file = path.join(older, STORE_FILE);
    const before = await readFile(file);
    const lines: string[] = [];
    await dump(file, (line) => {
      lines.push(line);
      return Promise.resolve();
    });
    const [, run, message] = lines.map((one) => JSON.parse(one) as Record<string, unknown>);
    expect(run).toMatchObject({ type: 'run', data: { state: legacy } });
    expect(message).toMatchObject({
      type: 'message',
      data: { id: 'resent', reply_to: 'original', told: 'resend:original' },
    });
    expect(Object.keys(message?.data ?? {})).not.toContain('origin');
    expect(await readFile(file)).toEqual(before);
    const schema = connect(file, { readOnly: true });
    try {
      expect(schema.prepare('PRAGMA user_version').get()).toEqual({ user_version: 3 });
    } finally {
      schema.close();
    }
  } finally {
    await rm(older, { recursive: true, force: true });
  }
});

it('dumps an older readable schema without migrating it', async () => {
  const file = path.join(profile, 'old.db');
  const old = connect(file);
  try {
    old.exec(`PRAGMA application_id = ${String(APPLICATION_ID)}`);
    migrate(old, MIGRATIONS.slice(0, 1));
    old.prepare('INSERT INTO canvas (id, used_at) VALUES (?, 1)').run(canvas);
    old
      .prepare('INSERT INTO run (canvas_id, state, updated_at) VALUES (?, ?, 1)')
      .run(canvas, '{}');
    old
      .prepare('INSERT INTO run_workflow (canvas_id, workflow, hash) VALUES (?, ?, ?)')
      .run(canvas, 'earlier canvas', 'hash');
  } finally {
    old.close();
  }
  const before = await readFile(file);
  const lines: string[] = [];
  await dump(file, (line) => {
    lines.push(line);
    return Promise.resolve();
  });
  expect(lines.map((line) => JSON.parse(line) as unknown)).toMatchObject([
    {
      type: 'canvas',
      data: { id: canvas },
      workflow: { workflow: 'earlier canvas', hash: 'hash' },
    },
    { type: 'run', data: { state: {} } },
  ]);
  expect(await readFile(file)).toEqual(before);
});
