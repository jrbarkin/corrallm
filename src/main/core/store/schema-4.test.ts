import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CanvasId } from '../../../shared/canvas';
import { decodeSubmissions } from '../engine/delivery/submission-state';
import { CanvasMemory, conversationsIn, PROJECT_WORKSPACE } from '../../memory';
import { RunJournal } from '../../run-journal';
import { CATALOG, DEFAULT_ADAPTER } from '../../sessions/adapters';
import { Documents } from '../canvas/documents';
import { Proposals } from '../canvas/proposals';
import { FileReviews } from '../canvas/reviews';
import { MessageStore, MessageTable } from '../delivery/messages';
import { WorkspaceStore } from '../workspaces/store';
import * as migrations from './migrations';
import { MIGRATIONS, SCHEMA } from './migrations';
import { openStore, STORE_FILE } from './open';
import type { Connection } from './sqlite';
import { SYSTEM_DEPS } from './store';
import type { Store, StoreDeps } from './store';
import { madeAtSchema, openTestStore, readOnDisk, refuseWrites } from './test-store';

/*
 * Migration 4 on a profile as the core opens it (B11 Design §4, §16 item 2): what a corrallm of
 * schema 3 kept (test-schema-3.json: every row its own stores and core kept, at 767a382) is kept
 * with its meaning, and read by today's stores: each run in its own envelope, each manual
 * submission your message, each message by what made it, a resend's link its resend_of; a
 * migration that fails keeps schema 3 as it was; a corrallm of schema 3 refuses the database once
 * it is migrated; a snapshot a corrallm of schema 3 took is restored and migrated; and so is a
 * profile of schema 2, through schema 3.
 */

/** No timers: nothing checkpoints or takes a snapshot while a test compares the database. */
const QUIET: StoreDeps = { ...SYSTEM_DEPS, later: () => () => undefined };
/** The schema a profile is migrated to as it opens, and the oldest that may open it then. */
const LATEST = { version: SCHEMA, minReader: MIGRATIONS.at(-1)?.minReader };

type Row = Record<string, unknown>;
interface Fixture {
  schema: 3;
  sequence: number;
  tables: Record<string, Row[]>;
}
const FIXTURE = JSON.parse(
  readFileSync(path.join(import.meta.dirname, 'test-schema-3.json'), 'utf8'),
) as Fixture;

/** The fixture's canvases: one the core ran, one a window ran, two runs beside a refusal. */
const SERVED = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b' as CanvasId;
const WINDOW = '5f0c8f0e-2c4b-4d8e-9a77-1e2d3c4b5a61' as CanvasId;
const OVERSIZED = '6a1d9f1f-3d5c-4e9f-8b88-2f3e4d5c6b72' as CanvasId;
const REFUSED = '7b2e0a2a-4e6d-4fa0-9c99-3a4f5e6d7c83' as CanvasId;
/** The tables migration 4 changes nothing of. */
const UNCHANGED = Object.keys(FIXTURE.tables).filter(
  (table) => !['meta', 'run', 'message'].includes(table),
);

let profile: string;

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-schema-4-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.doUnmock('./migrations');
  vi.resetModules();
  await rm(profile, { recursive: true, force: true });
});

/** Every column of `table`, as the database `connection` has it. */
const columnsOf = (connection: Pick<Connection, 'prepare'>, table: string): string[] =>
  connection
    .prepare('SELECT name FROM pragma_table_info(?)')
    .all(table)
    .map(({ name }) => String(name));

/** Every row of `table`, in an order of every column. */
function rowsOf(connection: Pick<Connection, 'prepare'>, table: string): Row[] {
  const order = columnsOf(connection, table).map((_, i) => String(i + 1));
  return connection.prepare(`SELECT * FROM ${table} ORDER BY ${order.join(', ')}`).all();
}

/** Every row the profile's database has in each of `tables`, on disk. */
const kept = (tables: readonly string[]): Record<string, Row[]> =>
  readOnDisk(profile, (disk) =>
    Object.fromEntries(tables.map((table) => [table, rowsOf(disk, table)])),
  );

/** The fixture's rows of `tables`, as `kept` reads them: in the same order. */
const fixtureOf = (tables: readonly string[]): Record<string, Row[]> =>
  Object.fromEntries(tables.map((table) => [table, FIXTURE.tables[table] ?? []]));

/**
 * Makes the profile's database as a corrallm of `schema` made it, holding every row the fixture
 * has of the tables that schema has, each with the columns it has: as that corrallm kept them.
 */
function keepAt(schema: 2 | 3): void {
  const old = madeAtSchema(profile, schema);
  try {
    old.exec('PRAGMA foreign_keys = OFF');
    const tables = new Set(
      old
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
        .all()
        .map(({ name }) => String(name)),
    );
    for (const [table, rows] of Object.entries(FIXTURE.tables)) {
      if (!tables.has(table)) continue;
      const columns = columnsOf(old, table);
      if (table === 'meta') {
        // Made by its migrations: its row as the fixture's, where the schema has its columns.
        for (const column of columns.filter((one) => one !== 'id' && one !== 'min_reader')) {
          old.prepare(`UPDATE meta SET ${column} = ?`).run(rows[0]?.[column] as number);
        }
        continue;
      }
      for (const row of rows) {
        const present = columns.filter((column) => column in row);
        old
          .prepare(
            `INSERT INTO ${table} (${present.map((one) => `"${one}"`).join(', ')})
             VALUES (${present.map(() => '?').join(', ')})`,
          )
          .run(...present.map((column) => row[column] as string | number | null));
      }
    }
    old
      .prepare("UPDATE sqlite_sequence SET seq = max(seq, ?) WHERE name = 'message'")
      .run(FIXTURE.sequence);
    expect(old.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally {
    old.close();
  }
}

const schemaOn = () =>
  readOnDisk(profile, (disk) => ({
    version: disk.prepare('PRAGMA user_version').get()?.user_version,
    minReader: disk.prepare('SELECT min_reader FROM meta').get()?.min_reader,
  }));

/**
 * The store's code as a corrallm of schema 3 had it: the same, with its migrations alone (its
 * modules loaded anew; the test's afterEach puts them back).
 */
async function schema3Code() {
  vi.resetModules();
  const first = MIGRATIONS.slice(0, 3);
  vi.doMock('./migrations', () => ({
    ...migrations,
    MIGRATIONS: first,
    SCHEMA: 3,
    migrate: (connection: Connection) => {
      migrations.migrate(connection, first);
    },
  }));
  return import('./open');
}

/** A legacy run's state, as schema 3 journaled it. */
const legacy = (canvas: CanvasId) => {
  const row = FIXTURE.tables.run?.find((one) => one.canvas_id === canvas);
  return JSON.parse(String(row?.state)) as {
    version?: 2;
    state?: unknown;
    messages?: unknown;
    saveError?: string;
  };
};

/** The submissions a legacy run kept, as an engine of schema 3 restored them. */
const submissionsOf = (canvas: CanvasId) =>
  decodeSubmissions(JSON.stringify(legacy(canvas).messages));

/**
 * The message rows the fixture has, as migration 4 classifies each by what made it (and migration
 * 6 leaves them: no settled decision).
 */
function classified(): Row[] {
  return (FIXTURE.tables.message ?? []).map((row) => {
    const replyTo = row.reply_to as string | null;
    const resend =
      replyTo !== null &&
      [`resend:${replyTo}`, `resend:${replyTo}:images`].includes(String(row.told));
    return {
      ...row,
      origin: resend ? 'resend' : row.from_party === 'you' ? 'manual' : 'party',
      display: resend && String(row.told).endsWith(':images') ? '{"requiresImages":true}' : null,
      reply_to: resend ? null : replyTo,
      resend_of: resend ? replyTo : null,
      told: resend ? null : row.told,
      settled: null,
    };
  });
}

/** What today's stores read of the profile, open. */
async function readThrough(store: Store) {
  const memory = new CanvasMemory(store);
  const table = new MessageTable(store, memory);
  const stores = new Map<CanvasId, MessageStore>();
  const messagesOf = async (canvas: CanvasId) => {
    let messages = stores.get(canvas);
    if (messages === undefined) {
      messages = new MessageStore(canvas, table, () => 2000);
      await messages.load();
      stores.set(canvas, messages);
    }
    return messages;
  };
  const journal = new RunJournal({ store, memory, messages: messagesOf });
  const documents = new Documents({
    store,
    memory,
    catalog: CATALOG,
    defaultAdapter: DEFAULT_ADAPTER,
  });
  const proposals = new Proposals({
    store,
    messages: () => Promise.reject(new Error('No messages here')),
    conversations: () => Promise.resolve(new Set()),
  });
  const workspaces = new WorkspaceStore({ store });
  const runs = Object.fromEntries(
    await Promise.all(
      [SERVED, WINDOW, OVERSIZED, REFUSED].map(
        async (canvas) => [canvas, await journal.get(canvas)] as const,
      ),
    ),
  );
  return {
    runs,
    messages: { served: await messagesOf(SERVED), window: await messagesOf(WINDOW) },
    reads: await journal.reads(SERVED),
    conversations: {
      served: conversationsIn(await memory.get(SERVED), PROJECT_WORKSPACE),
      window: conversationsIn(await memory.get(WINDOW), PROJECT_WORKSPACE),
    },
    documents: {
      served: (await documents.load(SERVED)).document.nodes.map(({ id }) => id),
      window: (await documents.load(WINDOW)).document.nodes.map(({ id }) => id),
    },
    proposals: proposals.open(SERVED).map(({ op, by }) => ({ op, by })),
    review: new FileReviews({ store }).open(SERVED)?.summary,
    worktrees: workspaces.worktreesOf(SERVED).map(({ id, state }) => ({ id, state })),
    bindings: workspaces.bindingsOf(SERVED).map(({ agent, workspace }) => ({ agent, workspace })),
  };
}

describe('migration 4 on a profile', () => {
  it('keeps every row a corrallm of schema 3 kept and its meaning, which today’s stores read', async () => {
    keepAt(3);
    expect(schemaOn()).toEqual({ version: 3, minReader: 3 });
    expect(kept(Object.keys(FIXTURE.tables))).toEqual(fixtureOf(Object.keys(FIXTURE.tables)));

    const store = await openTestStore(profile, QUIET);
    try {
      expect(schemaOn()).toEqual(LATEST);
      // What migration 4 changes nothing of, as it was.
      expect(kept(UNCHANGED)).toEqual(fixtureOf(UNCHANGED));
      expect(kept(['meta']).meta).toEqual([
        { ...FIXTURE.tables.meta?.[0], min_reader: LATEST.minReader },
      ]);
      // Each message as it was, in its place, by what made it: two resends, linked by resend_of.
      const messages = kept(['message']).message ?? [];
      const before = classified();
      expect(messages.slice(0, before.length)).toEqual(before);
      expect(before.filter(({ origin }) => origin === 'resend')).toHaveLength(2);
      // No place given before is given again.
      expect(
        Number(
          readOnDisk(profile, (disk) =>
            disk.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'message'").get(),
          )?.seq,
        ),
      ).toBeGreaterThanOrEqual(FIXTURE.sequence);
      expect(
        Math.min(...messages.slice(before.length).map(({ seq }) => Number(seq))),
      ).toBeGreaterThan(FIXTURE.sequence);
      // Each run in its own envelope, its submissions gone from it.
      const runs: Record<string, unknown> = Object.fromEntries(
        (kept(['run']).run ?? []).map(({ canvas_id: canvas, state, updated_at: at }) => [
          String(canvas),
          { state: JSON.parse(String(state)) as unknown, at },
        ]),
      );
      const at = (canvas: CanvasId) =>
        FIXTURE.tables.run?.find((one) => one.canvas_id === canvas)?.updated_at;
      expect(runs).toEqual({
        [SERVED]: { state: { format: 3, run: legacy(SERVED).state }, at: at(SERVED) },
        [WINDOW]: { state: { format: 3, run: legacy(WINDOW).state }, at: at(WINDOW) },
        [OVERSIZED]: {
          state: {
            format: 3,
            run: legacy(OVERSIZED).state,
            saveError: legacy(OVERSIZED).saveError,
          },
          at: at(OVERSIZED),
        },
        [REFUSED]: { state: { format: 3, saveError: legacy(REFUSED).saveError }, at: at(REFUSED) },
      });
      // The window's submissions, your messages to its agents, after every message there was;
      // the core's, each represented already by the message it delivered.
      const imported = messages.slice(before.length);
      expect(imported.map(({ canvas_id: canvas }) => canvas)).toEqual(Array(7).fill(WINDOW));
      expect(
        imported.map(({ from_party: from, origin, body, state }) => ({
          from,
          origin,
          body,
          state,
        })),
      ).toEqual([
        { from: 'you', origin: 'manual', body: 'Try again with the tests', state: 'replied' },
        { from: 'you', origin: 'manual', body: 'Explain the plan', state: 'replied' },
        { from: 'you', origin: 'resend', body: 'Explain the plan', state: 'replied' },
        { from: 'you', origin: 'manual', body: '/compact', state: 'replied' },
        { from: 'you', origin: 'manual', body: 'Typed in the terminal', state: 'replied' },
        // What went on, and what waited behind it, as the window's corrallm closed.
        { from: 'you', origin: 'manual', body: 'A slow follow-up', state: 'unresolved' },
        { from: 'you', origin: 'manual', body: 'Then this', state: 'unresolved' },
      ]);

      const read = await readThrough(store);
      // The engine restores the window's run as it did, its submissions as they were restored.
      expect(read.runs[WINDOW]?.checkpoint?.state).toBe(JSON.stringify(legacy(WINDOW).state));
      expect(decodeSubmissions(read.runs[WINDOW]?.checkpoint?.messages ?? '')).toEqual(
        submissionsOf(WINDOW),
      );
      // The core's, from the messages that represent them: each as it ended, a resend as one.
      expect(read.runs[SERVED]?.checkpoint?.state).toBe(JSON.stringify(legacy(SERVED).state));
      const served = decodeSubmissions(read.runs[SERVED]?.checkpoint?.messages ?? '');
      const restored3 = submissionsOf(SERVED);
      const [cancelled, resent] = restored3.get('a') ?? [];
      const [cut] = restored3.get('b') ?? [];
      expect(served).toEqual(
        new Map([
          // Your message cancelled, then its resend: linked as one now, which schema 3 never had.
          ['a', [cancelled, { ...resent, retryOf: cancelled?.id }]],
          // Your message the core's close cut off: unresolved, as its message is.
          ['b', [{ id: cut?.id, text: cut?.text, status: 'cancelled', unresolved: true }]],
        ]),
      );
      // Beside its refusal, the last run that fit; none where none did.
      expect(read.runs[OVERSIZED]?.checkpoint?.state).toBe(JSON.stringify(legacy(OVERSIZED).state));
      expect(read.runs[OVERSIZED]?.saveError).toBe(legacy(OVERSIZED).saveError);
      expect(read.runs[REFUSED]).toMatchObject({
        checkpoint: null,
        saveError: legacy(REFUSED).saveError,
      });
      // Every message read, a resend's link as such.
      expect(read.messages.served.all()).toHaveLength(
        before.filter(({ canvas_id: canvas }) => canvas === SERVED).length,
      );
      for (const row of before.filter(({ origin }) => origin === 'resend')) {
        const message = read.messages.served.get(String(row.id));
        expect(message).toMatchObject({ resendOf: row.resend_of });
        expect(message?.replyTo).toBeUndefined();
        expect(read.messages.served.originOf(String(row.id))).toBe('resend');
      }
      expect(read.messages.window.all()).toHaveLength(7);
      expect(read.reads).toEqual({
        'outside:orchestrator': FIXTURE.tables.read_position?.[0]?.seq,
      });
      expect(read).toMatchObject({
        conversations: {
          served: { codex: { a: { id: 'thread-a' } } },
          window: { 'claude-code': { lead: { role: 'none' } } },
        },
        documents: { served: ['a', 'b'], window: ['lead', 'helper'] },
        proposals: [{ op: 'canvas.delete', by: 'outside:orchestrator' }],
        review: { file: 'served.corral', groups: 1 },
        worktrees: [{ state: 'creating' }],
        bindings: [{ agent: 'a' }],
      });
    } finally {
      await store.close();
    }
  });

  it('keeps schema 3 as it was when migration 4 fails, and migrates it once it can', async () => {
    keepAt(3);
    const before = kept(Object.keys(FIXTURE.tables));
    // The disk fills as its conversion rewrites the first run: its message table's rebuild, and
    // every message it imported, are undone too.
    const release = refuseWrites(profile, 'run', 'The disk is full');

    const failed = await openStore(profile, QUIET);

    expect(failed.store).toBeUndefined();
    expect(failed.said).toEqual(['The core’s database could not be opened (The disk is full).']);
    expect(schemaOn()).toEqual({ version: 3, minReader: 3 });
    expect(kept(Object.keys(FIXTURE.tables))).toEqual(before);
    expect(readOnDisk(profile, (disk) => columnsOf(disk, 'message'))).not.toContain('origin');

    release();
    const store = await openTestStore(profile, QUIET);
    try {
      expect(schemaOn()).toEqual(LATEST);
      expect(kept(['message']).message?.slice(0, classified().length)).toEqual(classified());
    } finally {
      await store.close();
    }
  });

  it('is refused, left as it is, by a corrallm of schema 3, which would journal runs and messages schema 4 can’t read', async () => {
    const store = await openTestStore(profile, QUIET);
    store.tx(() => store.prepare('INSERT INTO canvas (id, used_at) VALUES (?, 1)').run(SERVED));
    await store.close();
    const file = path.join(profile, STORE_FILE);
    const files = await readdir(profile);
    const bytes = await readFile(file);

    const older = await schema3Code();
    const refused = await older.openStore(profile, QUIET);

    expect(refused.store).toBeUndefined();
    expect(refused.said).toEqual([
      `The core’s database (${file}) was made by a newer corrallm, which this one can’t read, and was left as it is: open this profile with that corrallm, or a newer one.`,
    ]);
    expect(await readdir(profile)).toEqual(files);
    expect(Buffer.compare(await readFile(file), bytes)).toBe(0);
  });

  it('restores a snapshot a corrallm of schema 3 took, migrated: its run converted, its resend one', async () => {
    // A corrallm of schema 3 keeps the window's canvas and the core's resend, and takes a snapshot
    // as it closes.
    const older = await schema3Code();
    const opened = await older.openStore(profile, QUIET);
    const old = opened.store;
    if (old === undefined) throw new Error(opened.said.join(' '));
    const rows = (canvas: CanvasId, table: string) =>
      (FIXTURE.tables[table] ?? []).filter((row) => row.canvas_id === canvas);
    old.tx(() => {
      for (const [table, canvas] of [
        ['canvas', undefined],
        ['run', WINDOW],
        ['message', SERVED],
      ] as const) {
        const found =
          canvas === undefined
            ? (FIXTURE.tables.canvas ?? []).filter(({ id }) =>
                [SERVED, WINDOW].includes(id as CanvasId),
              )
            : rows(canvas, table);
        for (const row of found) {
          const columns = Object.keys(row);
          old
            .prepare(
              `INSERT INTO ${table} (${columns.join(', ')})
               VALUES (${columns.map(() => '?').join(', ')})`,
            )
            .run(...columns.map((column) => row[column] as string | number | null));
        }
      }
    });
    await old.close();
    vi.doUnmock('./migrations');
    vi.resetModules();
    expect(schemaOn()).toEqual({ version: 3, minReader: 3 });
    // Then its database is damaged.
    await writeFile(path.join(profile, STORE_FILE), 'This is not a database. '.repeat(500));

    const { store, said } = await openStore(profile, QUIET);
    if (store === undefined) throw new Error(said.join(' '));
    try {
      expect(said[1]).toMatch(/^It was restored from its snapshot of /);
      expect(schemaOn()).toEqual(LATEST);
      const read = await readThrough(store);
      expect(decodeSubmissions(read.runs[WINDOW]?.checkpoint?.messages ?? '')).toEqual(
        submissionsOf(WINDOW),
      );
      const resends = classified().filter(({ origin }) => origin === 'resend');
      for (const row of resends) {
        expect(read.messages.served.get(String(row.id))).toMatchObject({
          resendOf: row.resend_of,
        });
      }
    } finally {
      await store.close();
    }
  });

  it('migrates a profile of schema 2 through schema 3, keeping its runs’ and messages’ meaning', async () => {
    keepAt(2);
    expect(schemaOn()).toEqual({ version: 2, minReader: 2 });
    const store = await openTestStore(profile, QUIET);
    try {
      expect(schemaOn()).toEqual(LATEST);
      expect(kept(['message']).message?.slice(0, classified().length)).toEqual(classified());
      const read = await readThrough(store);
      expect(decodeSubmissions(read.runs[WINDOW]?.checkpoint?.messages ?? '')).toEqual(
        submissionsOf(WINDOW),
      );
      expect(read.conversations.served).toEqual({ codex: { a: { id: 'thread-a' } } });
    } finally {
      await store.close();
    }
  });
});

describe('migration 4’s conversion', () => {
  it('is reached from the migrations alone', () => {
    const root = path.resolve(import.meta.dirname, '..', '..', '..', '..');
    const sources = (dir: string): string[] =>
      readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) return sources(file);
        return /\.(?:ts|tsx|mts)$/.test(entry.name) ? [file] : [];
      });
    const importing = sources('src').filter((file) =>
      /from\s+['"][^'"]*conversion-4['"]|import\(\s*['"][^'"]*conversion-4['"]/.test(
        readFileSync(path.join(root, file), 'utf8'),
      ),
    );
    expect(importing).toEqual([path.join('src', 'main', 'core', 'store', 'migrations.ts')]);
  });
});
