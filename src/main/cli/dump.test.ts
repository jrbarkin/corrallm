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
import { APPLICATION_ID } from '../core/store/open';
import { connect } from '../core/store/sqlite';
import type { Store } from '../core/store/store';
import { openTestStore } from '../core/store/test-store';
import { dump } from '../core/store/dump';

const exec = promisify(execFile);
const BUNDLE = path.resolve('dist-cli/corrallm.cjs');
const canvas = newCanvasId();
let profile: string;
let store: Store;
let messages: MessageStore;
let documents: Documents;
let journal: RunJournal;

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-dump-'));
  store = await openTestStore(profile);
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
  journal = new RunJournal({ store, memory });
  await journal.save(canvas, (await journal.get(canvas)).token, {
    version: 2,
    state: '{}',
    messages: '[]',
    updatedAt: 1,
  });
  messages = new MessageStore(canvas, new MessageTable(store, memory), () => 1000);
  await messages.load();
  messages.add({
    from: 'you',
    to: 'agent:a',
    kind: 'text',
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
      data: { canvas_id: canvas, state: { version: 2, state: {}, messages: [] }, updated_at: 1 },
    },
    { type: 'message', data: { canvas_id: canvas, body: 'Hello\nthere', state: 'pending' } },
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
      messages: '[]',
      updatedAt: 2,
    });
    messages.add({ from: 'you', to: 'agent:a', kind: 'text', state: 'pending', body: 'Later' });
    await messages.durable();
  });
  expect(lines.map((line) => JSON.parse(line) as unknown)).toMatchObject([
    { type: 'canvas' },
    { type: 'run', data: { state: { state: {} }, updated_at: 1 } },
    { type: 'message', data: { body: 'Hello\nthere' } },
  ]);
  expect(lines).toHaveLength(3);
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
