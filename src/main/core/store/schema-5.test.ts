import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CanvasId } from '../../../shared/canvas';
import { WorkspaceStore } from '../workspaces/store';
import * as migrations from './migrations';
import { MIGRATIONS, SCHEMA } from './migrations';
import { openStore, STORE_FILE } from './open';
import type { Connection } from './sqlite';
import { SYSTEM_DEPS } from './store';
import type { StoreDeps } from './store';
import { madeAtSchema, openTestStore, readOnDisk, writeOnDisk } from './test-store';

/*
 * Migration 5 on a profile as the core opens it (B9b Design §9 C8): the merge journal, `merge_job`,
 * added to what a corrallm of schema 4 kept, every row of it kept and read by today's stores; a
 * migration that fails keeps schema 4 as it was; and a corrallm of schema 4, which couldn't
 * reconcile a merge a crash interrupted, refuses the database once it is migrated.
 */

/** No timers: nothing checkpoints or takes a snapshot while a test compares the database. */
const QUIET: StoreDeps = { ...SYSTEM_DEPS, later: () => () => undefined };
const LATEST = { version: SCHEMA, minReader: MIGRATIONS.at(-1)?.minReader };

const CANVAS = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b' as CanvasId;
const REPOSITORY = '7c0e9a1e-1b6f-4b4f-9f3a-2d1c0b9a8e70';
const WORKSPACE = '9d1c5a0e-0f4e-4c11-8a51-0b1f2e3d4c51';

let profile: string;

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-schema-5-'));
});

afterEach(async () => {
  vi.doUnmock('./migrations');
  vi.resetModules();
  await rm(profile, { recursive: true, force: true });
});

const schemaOn = () =>
  readOnDisk(profile, (disk) => ({
    version: disk.prepare('PRAGMA user_version').get()?.user_version,
    minReader: disk.prepare('SELECT min_reader FROM meta').get()?.min_reader,
  }));

const tablesOn = () =>
  readOnDisk(profile, (disk) =>
    disk
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
      .all()
      .map(({ name }) => String(name)),
  );

/** Every row of the tables a corrallm of schema 4 kept a workspace in, on disk. */
const workspaceRows = () =>
  readOnDisk(profile, (disk) =>
    Object.fromEntries(
      ['canvas', 'repository', 'canvas_repository', 'worktree', 'agent_worktree'].map((table) => [
        table,
        disk.prepare(`SELECT * FROM ${table}`).all(),
      ]),
    ),
  );

/** A profile as a corrallm of schema 4 kept it: a canvas whose agent works in a workspace. */
function keepAt4(): void {
  const old: Connection = madeAtSchema(profile, 4);
  try {
    old.prepare("INSERT INTO canvas (id, project, used_at) VALUES (?, '/work/app', 1)").run(CANVAS);
    old
      .prepare(
        `INSERT INTO repository (id, picked_root, real_root, common_dir, identity, root_kind,
           owned_root, generation)
         VALUES (?, '/work/app', '/work/app', '/work/app/.git', 'identity', 'project',
           '/work/app/.corral/worktrees/p', 1)`,
      )
      .run(REPOSITORY);
    old
      .prepare(
        'INSERT INTO canvas_repository (canvas_id, repository_id, generation) VALUES (?, ?, 1)',
      )
      .run(CANVAS, REPOSITORY);
    old
      .prepare(
        `INSERT INTO worktree (id, canvas_id, repository_id, owner_key, path, branch_ref,
           base_checkout, base_oid, state, generation, created_at)
         VALUES (?, ?, ?, 'agent/a', ?, ?, '/work/app', ?, 'ready', 1, 1)`,
      )
      .run(
        WORKSPACE,
        CANVAS,
        REPOSITORY,
        `/work/app/.corral/worktrees/p/${WORKSPACE}`,
        `refs/heads/corrallm/p/${WORKSPACE}`,
        'a'.repeat(40),
      );
    old
      .prepare(
        "INSERT INTO agent_worktree (canvas_id, agent_id, workspace_id, generation) VALUES (?, 'a', ?, 1)",
      )
      .run(CANVAS, WORKSPACE);
  } finally {
    old.close();
  }
}

/**
 * The store's code as a corrallm of schema 4 had it: the same, with its migrations alone (its
 * modules loaded anew; afterEach puts them back).
 */
async function schema4Code() {
  vi.resetModules();
  const first = MIGRATIONS.slice(0, 4);
  vi.doMock('./migrations', () => ({
    ...migrations,
    MIGRATIONS: first,
    SCHEMA: 4,
    migrate: (connection: Connection) => {
      migrations.migrate(connection, first);
    },
  }));
  return import('./open');
}

describe('migration 5 on a profile', () => {
  it('adds the merge journal to what a corrallm of schema 4 kept, which today’s stores read', async () => {
    keepAt4();
    expect(schemaOn()).toEqual({ version: 4, minReader: 4 });
    const before = workspaceRows();

    const store = await openTestStore(profile, QUIET);
    try {
      expect(schemaOn()).toEqual(LATEST);
      expect(workspaceRows()).toEqual(before);
      expect(tablesOn()).toContain('merge_job');
      const workspaces = new WorkspaceStore({ store });
      expect(workspaces.binding(CANVAS, 'a')).toMatchObject({ workspace: WORKSPACE });
      expect(readOnDisk(profile, (disk) => disk.prepare('SELECT * FROM merge_job').all())).toEqual(
        [],
      );
    } finally {
      await store.close();
    }
  });

  it('keeps schema 4 as it was when migration 5 fails, and migrates it once it can', async () => {
    keepAt4();
    // What a migration 5 can't make: an index by its index's name, which it would make.
    writeOnDisk(profile, 'CREATE INDEX merge_job_open ON canvas (used_at)');
    const before = workspaceRows();

    const failed = await openStore(profile, QUIET);

    expect(failed.store).toBeUndefined();
    expect(failed.said[0]).toMatch(/^The core’s database could not be opened/);
    expect(schemaOn()).toEqual({ version: 4, minReader: 4 });
    expect(tablesOn()).not.toContain('merge_job');
    expect(workspaceRows()).toEqual(before);

    writeOnDisk(profile, 'DROP INDEX merge_job_open');
    const store = await openTestStore(profile, QUIET);
    try {
      expect(schemaOn()).toEqual(LATEST);
      expect(tablesOn()).toContain('merge_job');
    } finally {
      await store.close();
    }
  });

  it('is refused, left as it is, by a corrallm of schema 4, which couldn’t reconcile a merge a crash interrupted', async () => {
    keepAt4();
    const store = await openTestStore(profile, QUIET);
    await store.close();
    const file = path.join(profile, STORE_FILE);
    const files = await readdir(profile);
    const bytes = await readFile(file);

    const older = await schema4Code();
    const refused = await older.openStore(profile, QUIET);

    expect(refused.store).toBeUndefined();
    expect(refused.said).toEqual([
      `The core’s database (${file}) was made by a newer corrallm, which this one can’t read, and was left as it is: open this profile with that corrallm, or a newer one.`,
    ]);
    expect(await readdir(profile)).toEqual(files);
    expect(Buffer.compare(await readFile(file), bytes)).toBe(0);
  });
});
