import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MIGRATIONS, SCHEMA } from './migrations';
import { APPLICATION_ID, JOURNAL_SIZE_LIMIT, openStore } from './open';
import { connect } from './sqlite';
import type { Store } from './store';

/*
 * Opening the profile's database (Core Database §5): <profile>/core.db, made 0600 before SQLite
 * opens it, its pragmas set and read back, checked, and migrated; never throwing.
 */

let profile: string;
let file: string;
let opened: Store[];

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-store-'));
  file = path.join(profile, 'core.db');
  opened = [];
});

afterEach(async () => {
  for (const store of opened) await store.close();
  await rm(profile, { recursive: true, force: true });
});

/** Opens the profile's store, which must open. */
async function open(): Promise<{ store: Store; said: string[] }> {
  const { store, said } = await openStore(profile);
  if (store === undefined) throw new Error(`The store did not open: ${said.join(' ')}`);
  opened.push(store);
  return { store, said };
}

const pragma = (store: Store, name: string): unknown =>
  store.prepare(`PRAGMA ${name}`).get()?.[name];

describe('openStore', () => {
  it.skipIf(process.platform === 'win32')(
    'makes the database, its log and its index the user’s alone, whatever the umask',
    async () => {
      const umask = process.umask(0o022);
      try {
        const { store, said } = await open();
        store.tx(() => store.prepare("INSERT INTO canvas (id, used_at) VALUES ('c', 1)").run());
        expect(said).toEqual([]);
        for (const name of ['core.db', 'core.db-wal', 'core.db-shm']) {
          expect((await stat(path.join(profile, name))).mode & 0o777, name).toBe(0o600);
        }
      } finally {
        process.umask(umask);
      }
    },
  );

  it('sets SQLite up as the core needs it, and it reads back so', async () => {
    const { store } = await open();
    const darwin = process.platform === 'darwin' ? 1 : 0;
    expect({
      auto_vacuum: pragma(store, 'auto_vacuum'),
      journal_mode: pragma(store, 'journal_mode'),
      synchronous: pragma(store, 'synchronous'),
      fullfsync: pragma(store, 'fullfsync'),
      checkpoint_fullfsync: pragma(store, 'checkpoint_fullfsync'),
      foreign_keys: pragma(store, 'foreign_keys'),
      trusted_schema: pragma(store, 'trusted_schema'),
      journal_size_limit: pragma(store, 'journal_size_limit'),
      wal_autocheckpoint: pragma(store, 'wal_autocheckpoint'),
      application_id: pragma(store, 'application_id'),
      user_version: pragma(store, 'user_version'),
    }).toEqual({
      // INCREMENTAL
      auto_vacuum: 2,
      journal_mode: 'wal',
      // FULL
      synchronous: 2,
      fullfsync: darwin,
      checkpoint_fullfsync: darwin,
      foreign_keys: 1,
      trusted_schema: 0,
      journal_size_limit: JOURNAL_SIZE_LIMIT,
      wal_autocheckpoint: 0,
      application_id: APPLICATION_ID,
      user_version: SCHEMA,
    });
  });

  it('vacuums incrementally an empty database SQLite had begun before it', async () => {
    const begun = connect(file);
    begun.exec('PRAGMA journal_mode = WAL');
    begun.close();
    const { store } = await open();
    expect(pragma(store, 'auto_vacuum')).toBe(2);
    expect(pragma(store, 'application_id')).toBe(APPLICATION_ID);
  });

  it('opens again what it kept', async () => {
    const first = await open();
    first.store.tx(() =>
      first.store.prepare("INSERT INTO canvas (id, used_at) VALUES ('kept', 1)").run(),
    );
    await first.store.close();
    const { store, said } = await open();
    expect(said).toEqual([]);
    expect(store.prepare('SELECT id FROM canvas').all()).toEqual([{ id: 'kept' }]);
  });

  it('refuses a database a newer corrallm made that this one can’t read, leaving it as it was', async () => {
    const { store } = await open();
    await store.close();
    const newer = connect(file);
    newer.exec(`UPDATE meta SET min_reader = ${String(SCHEMA + 1)}`);
    newer.exec(`PRAGMA user_version = ${String(SCHEMA + 1)}`);
    newer.close();
    const files = await readdir(profile);
    const bytes = await readFile(file);

    const refused = await openStore(profile);

    expect(refused.store).toBeUndefined();
    expect(refused.said).toEqual([
      `The core’s database (${file}) was made by a newer corrallm, which this one can’t read, and was left as it is: open this profile with that corrallm, or a newer one.`,
    ]);
    expect(await readdir(profile)).toEqual(files);
    expect(Buffer.compare(await readFile(file), bytes)).toBe(0);
  });

  it('opens a database a newer corrallm made that it may still read, keeping what it added', async () => {
    const { store } = await open();
    await store.close();
    const newer = connect(file);
    newer.exec('CREATE TABLE later (note TEXT NOT NULL) STRICT');
    newer.exec("INSERT INTO later (note) VALUES ('added by a newer corrallm')");
    newer.exec(`PRAGMA user_version = ${String(SCHEMA + 1)}`);
    newer.close();

    const reopened = await open();

    expect(reopened.said).toEqual([]);
    expect(pragma(reopened.store, 'user_version')).toBe(SCHEMA + 1);
    expect(reopened.store.prepare('SELECT note FROM later').all()).toEqual([
      { note: 'added by a newer corrallm' },
    ]);
    expect(reopened.store.prepare('SELECT min_reader FROM meta').get()).toEqual({
      min_reader: MIGRATIONS.at(-1)?.minReader,
    });
  });

  it('says why it can’t open a database it can’t reach, and opens none', async () => {
    const notAFolder = path.join(profile, 'not-a-folder');
    await writeFile(notAFolder, '');
    const { store, said } = await openStore(notAFolder);
    expect(store).toBeUndefined();
    expect(said).toEqual([
      expect.stringMatching(/^The core’s database could not be opened \(.*ENOTDIR.*\)\.$/),
    ]);
  });
});
