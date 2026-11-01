import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CanvasId } from '../../../shared/canvas';
import type { CanvasDocument } from '../../../shared/model/canvas';
import { CanvasMemory, conversationsIn, PROJECT_WORKSPACE } from '../../memory';
import { RunJournal } from '../../run-journal';
import { CATALOG, DEFAULT_ADAPTER } from '../../sessions/adapters';
import { Documents } from '../canvas/documents';
import { Proposals } from '../canvas/proposals';
import { FileReviews } from '../canvas/reviews';
import { commitDocument } from '../canvas/test-documents';
import { MessageStore, MessageTable } from '../delivery/messages';
import { WorkspaceStore } from '../workspaces/store';
import { mintTrustedPath as trusted } from '../host';
import * as migrations from './migrations';
import { MIGRATIONS, SCHEMA } from './migrations';
import { openStore, STORE_FILE } from './open';
import type { Connection } from './sqlite';
import { SYSTEM_DEPS } from './store';
import type { Store, StoreDeps } from './store';
import { madeAtSchema, openTestStore, readOnDisk, refuseWrites } from './test-store';

/*
 * Migration 3 on a profile as the core opens it (Core Database §5): what a corrallm of schema 2
 * kept, as its stores kept it, is kept as it was, and read by today's stores; a migration that fails
 * keeps schema 2 as it was; a corrallm of schema 2 refuses the database once it is migrated; and a
 * snapshot a corrallm of schema 2 took is restored and migrated. Opened, each is migrated on to the
 * latest schema (migration 4 after it: schema-4.test.ts), which the rows schema 2 has keep.
 */

/** No timers: nothing checkpoints or takes a snapshot while a test compares the database. */
const QUIET: StoreDeps = { ...SYSTEM_DEPS, later: () => () => undefined };

const CANVAS = '5f0c8f0e-2c4b-4d8e-9a77-1e2d3c4b5a61' as CanvasId;
const SESSION = '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e11';
const THREAD = '0199a3f0-1234-7000-8000-123456789abc';
const CHECKPOINT = {
  version: 2,
  state: '{"cursor":1}',
  messages: '{"version":1,"agents":[]}',
  updatedAt: 1,
} as const;
/** The schema a profile is migrated to as it opens, and the oldest that may open it then. */
const LATEST = { version: SCHEMA, minReader: MIGRATIONS.at(-1)?.minReader };
const DOCUMENT: CanvasDocument = {
  id: CANVAS,
  arrange: false,
  nodes: [
    { id: 'team', type: 'frame', position: { x: 0, y: 0 }, data: { label: 'Team' } },
    {
      id: 'lead',
      type: 'agent',
      parentId: 'team',
      position: { x: 10, y: 20 },
      data: {
        label: 'Lead',
        adapter: 'codex',
        role: 'Plan the work',
        queue: [{ id: 'plan', message: 'Write PLAN.md' }],
      },
    },
    {
      id: 'worker',
      type: 'agent',
      position: { x: 300, y: 20 },
      data: { label: 'Worker', adapter: 'claude-code', queue: [{ id: 'do', message: 'Do it' }] },
    },
  ],
  links: [{ source: 'lead', target: 'worker' }],
};
const SUMMARY = { file: 'team.corral', from: null, groups: 1 };

/** Schema 2's tables, each after those it refers to. */
const SCHEMA_2_TABLES = [
  'canvas',
  'document',
  'node',
  'link',
  'queue_item',
  'revision',
  'change',
  'proposal',
  'file_review',
  'run',
  'message',
  'read_position',
  'open_canvas',
  'conversation',
] as const;

let profile: string;
/** A profile today's stores keep a canvas in, as a corrallm of schema 2 kept it. */
let reference: string;

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-schema-3-'));
  reference = await mkdtemp(path.join(tmpdir(), 'corrallm-schema-2-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.doUnmock('./migrations');
  vi.resetModules();
  await rm(profile, { recursive: true, force: true });
  await rm(reference, { recursive: true, force: true });
});

/** The canvas's file, beside the reference profile. */
const fileOf = (): string => path.join(reference, 'team.corral');

/**
 * Keeps a canvas in the reference profile through today's stores, in every table schema 2 has: its
 * file, folder and conversations, its document and its revision, its run, a message and where a
 * party read to, a proposal waiting and a file review open.
 */
async function keepReference(): Promise<void> {
  const store = await openTestStore(reference, QUIET);
  try {
    const memory = new CanvasMemory(store);
    const documents = new Documents({
      store,
      memory,
      catalog: CATALOG,
      defaultAdapter: DEFAULT_ADAPTER,
    });
    documents.create(CANVAS, 'you');
    await commitDocument(documents, CANVAS, DOCUMENT);
    // Its file is there: one gone would leave the canvas unsaved, with no file, as it restores.
    await writeFile(fileOf(), JSON.stringify({ format: 'corrallm', version: 2, id: CANVAS }));
    await memory.setFile(CANVAS, trusted(fileOf()));
    await memory.update(CANVAS, (kept) => ({
      ...kept,
      project: trusted('/work'),
      conversations: {
        [PROJECT_WORKSPACE]: {
          'claude-code': { worker: { id: SESSION, role: 'none' } },
          codex: { lead: { id: THREAD } },
        },
      },
    }));
    const messages = new MessageStore(CANVAS, new MessageTable(store, memory), () => 1000);
    await messages.load();
    const journal = new RunJournal({ store, memory, messages: () => Promise.resolve(messages) });
    await journal.opened(CANVAS);
    await journal.save(CANVAS, (await journal.get(CANVAS)).token, CHECKPOINT);
    const sent = messages.add({
      from: 'outside:orchestrator',
      to: 'agent:lead',
      kind: 'text',
      origin: 'party',
      state: 'pending',
      body: 'Plan the work',
    });
    await messages.durable();
    const reviews = new FileReviews({ store, newId: () => 'review' });
    await store.write(() => {
      journal.moveRead(CANVAS, 'outside:orchestrator', messages.seqOf(sent.id) ?? 0);
      reviews.raiseWithin(CANVAS, 'f'.repeat(64), SUMMARY);
      store
        .prepare(
          `INSERT INTO proposal (id, canvas_id, op, args, by_party, touched, lost, raised_at)
           VALUES ('delete', ?, 'canvas.delete', ?, 'outside:orchestrator', ?, ?, 1)`,
        )
        .run(
          CANVAS,
          JSON.stringify({ nodes: ['worker'] }),
          JSON.stringify({ touched: { 'node/worker': 1 }, before: { 'node/worker': 1 } }),
          JSON.stringify({ what: 'delete Worker', title: 'Delete Worker?' }),
        );
    });
    await memory.flush();
  } finally {
    await store.close();
  }
}

/** Every column of `table`, as the database `connection` has it. */
const columnsOf = (connection: Pick<Connection, 'prepare'>, table: string): string[] =>
  connection
    .prepare('SELECT name FROM pragma_table_info(?)')
    .all(table)
    .map(({ name }) => String(name));

/** Every row of `table`, in an order of every column. */
function rowsOf(connection: Pick<Connection, 'prepare'>, table: string): unknown[] {
  const order = columnsOf(connection, table).map((_, i) => String(i + 1));
  return connection.prepare(`SELECT * FROM ${table} ORDER BY ${order.join(', ')}`).all();
}

/** What every table of schema 2 holds in `profile`'s database, on disk. */
const kept = (at: string): Record<string, unknown[]> =>
  readOnDisk(at, (disk) =>
    Object.fromEntries(SCHEMA_2_TABLES.map((table) => [table, rowsOf(disk, table)])),
  );

/**
 * Makes the profile's database as a corrallm of schema 2 made it, holding every row the reference
 * profile keeps in the tables schema 2 has: as a corrallm of schema 2 would have kept them.
 */
function keepAtSchema2(): void {
  const old = madeAtSchema(profile, 2);
  try {
    old.prepare('ATTACH DATABASE ? AS reference').run(path.join(reference, STORE_FILE));
    for (const table of SCHEMA_2_TABLES) {
      const columns = columnsOf(old, table)
        .map((column) => `"${column}"`)
        .join(', ');
      old.exec(`INSERT INTO main.${table} (${columns}) SELECT ${columns} FROM reference.${table}`);
    }
    old.exec('DETACH DATABASE reference');
  } finally {
    old.close();
  }
}

/**
 * The store's code as a corrallm of schema 2 had it: the same, with its migrations alone (its
 * modules loaded anew; the test's afterEach puts them back).
 */
async function schema2Code() {
  vi.resetModules();
  const first = MIGRATIONS.slice(0, 2);
  vi.doMock('./migrations', () => ({
    ...migrations,
    MIGRATIONS: first,
    SCHEMA: 2,
    migrate: (connection: Connection) => {
      migrations.migrate(connection, first);
    },
  }));
  return import('./open');
}

const schemaOn = (at: string) =>
  readOnDisk(at, (disk) => ({
    version: disk.prepare('PRAGMA user_version').get()?.user_version,
    minReader: disk.prepare('SELECT min_reader FROM meta').get()?.min_reader,
  }));

/** What today's stores read of the canvas in an open store. */
async function readThrough(store: Store) {
  const memory = new CanvasMemory(store);
  const documents = new Documents({
    store,
    memory,
    catalog: CATALOG,
    defaultAdapter: DEFAULT_ADAPTER,
  });
  const messages = new MessageStore(CANVAS, new MessageTable(store, memory), () => 2000);
  await messages.load();
  const journal = new RunJournal({ store, memory, messages: () => Promise.resolve(messages) });
  const proposals = new Proposals({
    store,
    messages: () => Promise.reject(new Error('No messages here')),
    conversations: () => Promise.resolve(new Set()),
  });
  const remembered = await memory.get(CANVAS);
  return {
    file: remembered.file,
    project: remembered.project,
    conversations: conversationsIn(remembered, PROJECT_WORKSPACE),
    workspaces: Object.keys(remembered.conversations),
    document: (await documents.load(CANVAS)).document,
    run: (await journal.get(CANVAS)).checkpoint,
    // Where the orchestrator read to: the message it sent.
    reads: Object.entries(await journal.reads(CANVAS)).map(([party, seq]) => ({
      party,
      read: messages.all().find((message) => messages.seqOf(message.id) === seq)?.body,
    })),
    messages: messages.all().map(({ from, to, body, state }) => ({ from, to, body, state })),
    proposals: proposals.open(CANVAS).map(({ op, by }) => ({ op, by })),
    review: new FileReviews({ store }).open(CANVAS)?.summary,
  };
}

describe('migration 3 on a profile', () => {
  it('keeps every row a corrallm of schema 2 kept as it was, which today’s stores read, its conversations the project folder’s', async () => {
    await keepReference();
    keepAtSchema2();
    expect(schemaOn(profile)).toEqual({ version: 2, minReader: 2 });
    const before = kept(reference);

    const store = await openTestStore(profile, QUIET);
    try {
      expect(schemaOn(profile)).toEqual(LATEST);
      expect(kept(profile)).toEqual(before);
      expect(
        readOnDisk(profile, (disk) =>
          disk.prepare('SELECT DISTINCT workspace_key FROM conversation').all(),
        ),
      ).toEqual([{ workspace_key: PROJECT_WORKSPACE }]);
      const read = await readThrough(store);
      expect(read).toEqual({
        file: fileOf(),
        project: '/work',
        conversations: {
          'claude-code': { worker: { id: SESSION, role: 'none' } },
          codex: { lead: { id: THREAD } },
        },
        workspaces: [PROJECT_WORKSPACE],
        document: DOCUMENT,
        run: CHECKPOINT,
        reads: [{ party: 'outside:orchestrator', read: 'Plan the work' }],
        messages: [
          {
            from: 'outside:orchestrator',
            to: 'agent:lead',
            body: 'Plan the work',
            state: 'pending',
          },
        ],
        proposals: [{ op: 'canvas.delete', by: 'outside:orchestrator' }],
        review: SUMMARY,
      });
    } finally {
      await store.close();
    }
  });

  it('keeps schema 2 as it was when migration 3 fails, and migrates it once it can', async () => {
    await keepReference();
    keepAtSchema2();
    const atSchema2 = kept(profile);
    // The disk fills as the migration records its version: everything before it is undone too.
    const release = refuseWrites(profile, 'meta', 'The disk is full');

    const failed = await openStore(profile, QUIET);

    expect(failed.store).toBeUndefined();
    expect(failed.said).toEqual(['The core’s database could not be opened (The disk is full).']);
    expect(schemaOn(profile)).toEqual({ version: 2, minReader: 2 });
    expect(kept(profile)).toEqual(atSchema2);
    expect(
      readOnDisk(profile, (disk) =>
        disk
          .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE '%worktree%'")
          .all(),
      ),
    ).toEqual([]);
    expect(readOnDisk(profile, (disk) => columnsOf(disk, 'conversation'))).not.toContain(
      'workspace_key',
    );

    release();
    const store = await openTestStore(profile, QUIET);
    try {
      expect(schemaOn(profile)).toEqual(LATEST);
      // As today's stores keep it: its conversations the project folder's.
      expect(kept(profile)).toEqual(kept(reference));
    } finally {
      await store.close();
    }
  });

  it('is refused, left as it is, by a corrallm of schema 2, which would run every agent in the project folder', async () => {
    const store = await openTestStore(profile, QUIET);
    store.tx(() => store.prepare('INSERT INTO canvas (id, used_at) VALUES (?, 1)').run(CANVAS));
    await store.close();
    const file = path.join(profile, STORE_FILE);
    const files = await readdir(profile);
    const bytes = await readFile(file);

    const older = await schema2Code();
    const refused = await older.openStore(profile, QUIET);

    expect(refused.store).toBeUndefined();
    expect(refused.said).toEqual([
      `The core’s database (${file}) was made by a newer corrallm, which this one can’t read, and was left as it is: open this profile with that corrallm, or a newer one.`,
    ]);
    expect(await readdir(profile)).toEqual(files);
    expect(Buffer.compare(await readFile(file), bytes)).toBe(0);
  });

  it('restores a snapshot a corrallm of schema 2 took, migrated, its conversations the project folder’s', async () => {
    // A corrallm of schema 2 keeps the canvas, and takes a snapshot as it closes.
    const older = await schema2Code();
    const opened = await older.openStore(profile, QUIET);
    const old = opened.store;
    if (old === undefined) throw new Error(opened.said.join(' '));
    old.tx(() => {
      old
        .prepare('INSERT INTO canvas (id, project, used_at) VALUES (?, ?, 1)')
        .run(CANVAS, '/work');
      old
        .prepare(
          `INSERT INTO conversation (canvas_id, adapter, agent_id, native_id, role_fingerprint)
           VALUES (?, 'codex', 'lead', ?, 'none')`,
        )
        .run(CANVAS, THREAD);
    });
    await old.close();
    vi.doUnmock('./migrations');
    vi.resetModules();
    expect(schemaOn(profile)).toEqual({ version: 2, minReader: 2 });
    // Then its database is damaged.
    await writeFile(path.join(profile, STORE_FILE), 'This is not a database. '.repeat(500));

    const { store, said } = await openStore(profile, QUIET);
    if (store === undefined) throw new Error(said.join(' '));
    try {
      expect(said[1]).toMatch(/^It was restored from its snapshot of /);
      expect(schemaOn(profile)).toEqual(LATEST);
      const remembered = await new CanvasMemory(store).get(CANVAS);
      expect(remembered).toEqual({
        project: '/work',
        conversations: { [PROJECT_WORKSPACE]: { codex: { lead: { id: THREAD, role: 'none' } } } },
      });
    } finally {
      await store.close();
    }
  });
});

describe('a profile at schema 3', () => {
  const REPOSITORY = '7c0e9a1e-1b6f-4b4f-9f3a-2d1c0b9a8e70';
  const WORKSPACE = '9d1c5a0e-0f4e-4c11-8a51-0b1f2e3d4c51';
  const JOB = 'c0ffee00-0000-4000-8000-000000000001';
  const HASH = 'b'.repeat(64);

  /** Every workspace record the profile keeps of the canvas, as the workspace store reads it. */
  function records(store: Store) {
    const workspaces = new WorkspaceStore({ store });
    return {
      repository: workspaces.repository(REPOSITORY),
      canvas: workspaces.canvasRepository(CANVAS),
      worktrees: workspaces.worktreesOf(CANVAS),
      bindings: workspaces.bindingsOf(CANVAS),
      jobs: workspaces.openJobs(),
      setup: workspaces.setup(WORKSPACE),
      project: workspaces.projectSetup(REPOSITORY),
    };
  }

  it('keeps its workspace records as it opens again, and as it restores its snapshot', async () => {
    const store = await openTestStore(profile, QUIET);
    const memory = new CanvasMemory(store);
    const workspaces = new WorkspaceStore({ store, now: () => 1000 });
    await store.write(() => {
      memory.ensure(CANVAS);
    });
    await workspaces.write((w) => {
      w.addRepository({
        id: REPOSITORY,
        pickedRoot: '/work/app',
        realRoot: '/work/app',
        commonDir: '/work/app/.git',
        identity: 'repository identity',
        rootKind: 'project',
        ownedRoot: '/work/app/.corral/worktrees/profile',
      });
      w.bindCanvas(CANVAS, REPOSITORY);
      w.createWorktree({
        id: WORKSPACE,
        canvas: CANVAS,
        repository: REPOSITORY,
        owner: 'group/team',
        path: `/work/app/.corral/worktrees/profile/${WORKSPACE}`,
        branchRef: `refs/heads/corrallm/profile/${WORKSPACE}`,
        baseCheckout: '/work/app',
        baseRef: null,
        baseOid: 'a'.repeat(40),
        forkedFrom: null,
      });
      w.bind(CANVAS, 'lead', WORKSPACE);
      w.recordJob({
        id: JOB,
        workspace: WORKSPACE,
        kind: 'create',
        phase: 'registered',
        generation: 1,
        payload: { ref: `refs/heads/corrallm/profile/${WORKSPACE}` },
      });
      w.offerSetup(WORKSPACE, {
        command: 'npm ci',
        source: 'detected',
        specHash: HASH,
        copyManifestHash: HASH,
      });
      w.setAlways(REPOSITORY, HASH);
    });
    const before = records(store);
    expect(before.worktrees).toHaveLength(1);
    expect(before.jobs).toHaveLength(1);
    // Closed, it takes a snapshot of itself.
    await store.close();

    const again = await openTestStore(profile, QUIET);
    try {
      expect(schemaOn(profile)).toEqual(LATEST);
      expect(records(again)).toEqual(before);
    } finally {
      await again.close();
    }

    // Damaged since: restored from its snapshot, at schema 3, its records as they were.
    await writeFile(path.join(profile, STORE_FILE), 'This is not a database. '.repeat(500));
    const { store: restored, said } = await openStore(profile, QUIET);
    if (restored === undefined) throw new Error(said.join(' '));
    try {
      expect(said[1]).toMatch(/^It was restored from its snapshot of /);
      expect(schemaOn(profile)).toEqual(LATEST);
      expect(records(restored)).toEqual(before);
      // Kept, with its workspace: never forgotten while it owns one.
      await expect(new CanvasMemory(restored).forget(CANVAS)).resolves.toBe(false);
    } finally {
      await restored.close();
    }
  });
});
