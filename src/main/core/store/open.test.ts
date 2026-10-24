import {
  copyFile,
  mkdir,
  mkdtemp,
  open as openFile,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JOURNAL_SIZE_LIMIT } from './checkpointer';
import * as migrations from './migrations';
import { MIGRATIONS, SCHEMA } from './migrations';
import { APPLICATION_ID, openStore } from './open';
import { connect } from './sqlite';
import type { Connection } from './sqlite';
import { SYSTEM_DEPS } from './store';
import type { Store, StoreDeps } from './store';

/*
 * Opening the profile's database (Core Database §5): <profile>/core.db, made 0600 before SQLite
 * opens it, its pragmas set and read back, checked, and migrated; never throwing. A damaged one is
 * set aside with its log and index, and the newest sound snapshot restored, if there is one.
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
async function open(deps?: StoreDeps): Promise<{ store: Store; said: string[] }> {
  const { store, said } = await openStore(profile, deps);
  if (store === undefined) throw new Error(`The store did not open: ${said.join(' ')}`);
  opened.push(store);
  return { store, said };
}

const pragma = (store: Store, name: string): unknown =>
  store.prepare(`PRAGMA ${name}`).get()?.[name];

describe('openStore', () => {
  it('creates only SQLite’s database, log and index on a normal open', async () => {
    const { said } = await open();
    expect(said).toEqual([]);
    expect((await readdir(profile)).sort()).toEqual(['core.db', 'core.db-shm', 'core.db-wal']);
  });

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
      // NORMAL: the store flushes its log itself, after each commit, off the loop (store.ts)
      synchronous: 1,
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

  it('has what opening wrote on the drive before it is used: checkpointed into the database', async () => {
    const { store } = await open();
    // The database's file alone, without its log.
    const alone = path.join(profile, 'alone.db');
    await copyFile(file, alone);
    const schema = connect(alone, { readOnly: true });
    try {
      expect(schema.prepare('PRAGMA user_version').get()).toEqual({ user_version: SCHEMA });
      expect(
        schema.prepare("SELECT count(*) AS tables FROM sqlite_schema WHERE name = 'message'").get(),
      ).toEqual({ tables: 1 });
    } finally {
      schema.close();
    }
    expect(pragma(store, 'user_version')).toBe(SCHEMA);
  });

  it('begins its log as it opens, so that no commit of its own begins it', async () => {
    const { store } = await open();
    // The log's header: its checkpoint's number and its salts, which beginning it anew changes.
    const header = async () => (await readFile(`${file}-wal`)).subarray(12, 24).toString('hex');
    const begun = await header();
    expect(begun).toMatch(/^[0-9a-f]{24}$/);
    await store.write(() =>
      store.prepare("INSERT INTO canvas (id, used_at) VALUES ('c', 1)").run(),
    );
    expect(await header()).toBe(begun);
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

  it('rolls back what a crash left in a rollback journal, as SQLite does, and opens what was committed', async () => {
    const first = await open();
    first.store.tx(() =>
      first.store.prepare("INSERT INTO canvas (id, used_at) VALUES ('kept', 1)").run(),
    );
    await first.store.close();
    // The database before it keeps a write-ahead log (as a snapshot just restored is), and a
    // transaction cut short in it: its pages spilled into the file, the journal hot beside it.
    const [snapshot] = await readdir(path.join(profile, 'backups'));
    const elsewhere = await mkdtemp(path.join(tmpdir(), 'corrallm-crash-'));
    const crashing = path.join(elsewhere, 'core.db');
    await copyFile(path.join(profile, 'backups', snapshot ?? ''), crashing);
    const writer = connect(crashing);
    writer.exec('PRAGMA cache_size = 1; PRAGMA cache_spill = 1; BEGIN IMMEDIATE');
    for (let i = 0; i < 200; i++) {
      writer
        .prepare(
          `INSERT INTO message (id, canvas_id, from_party, to_party, kind, origin, body, state,
             sent_at)
           VALUES (?, 'kept', 'you', 'agent:a', 'text', 'manual', ?, 'pending', 1)`,
        )
        .run(`message ${String(i)}`, 'x'.repeat(500));
    }
    await copyFile(crashing, file);
    await copyFile(`${crashing}-journal`, `${file}-journal`);
    writer.exec('ROLLBACK');
    writer.close();
    await rm(elsewhere, { recursive: true, force: true });

    const { store, said } = await open();

    expect(said).toEqual([]);
    expect(store.prepare('SELECT id FROM canvas').all()).toEqual([{ id: 'kept' }]);
    expect(store.prepare('SELECT count(*) AS messages FROM message').get()).toEqual({
      messages: 0,
    });
    expect(store.prepare('PRAGMA quick_check').get()).toEqual({ quick_check: 'ok' });
    expect(pragma(store, 'journal_mode')).toBe('wal');
    await expect(stat(`${file}-journal`)).rejects.toThrow(/ENOENT/);
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

  it('is refused, left as it is, by a corrallm of schema 1, which would not read its document', async () => {
    const { store } = await open();
    store.tx(() => store.prepare("INSERT INTO canvas (id, used_at) VALUES ('c', 1)").run());
    await store.close();
    const files = await readdir(profile);
    const bytes = await readFile(file);
    // The code as a corrallm of schema 1 had it: the same, with its migrations alone.
    vi.resetModules();
    const first = MIGRATIONS.slice(0, 1);
    vi.doMock('./migrations', () => ({
      ...migrations,
      MIGRATIONS: first,
      SCHEMA: 1,
      migrate: (connection: Connection) => {
        migrations.migrate(connection, first);
      },
    }));
    try {
      const older = await import('./open');

      const refused = await older.openStore(profile);

      expect(refused.store).toBeUndefined();
      expect(refused.said).toEqual([
        `The core’s database (${file}) was made by a newer corrallm, which this one can’t read, and was left as it is: open this profile with that corrallm, or a newer one.`,
      ]);
      expect(await readdir(profile)).toEqual(files);
      expect(Buffer.compare(await readFile(file), bytes)).toBe(0);
    } finally {
      vi.doUnmock('./migrations');
      vi.resetModules();
    }
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

describe('a damaged database', () => {
  /** A clock stopped at `at`, and timers that never run. */
  const stoppedAt = (at: number): StoreDeps => ({
    ...SYSTEM_DEPS,
    later: () => () => undefined,
    now: () => at,
  });
  const CANVAS = '0a6f6a5e-4bb3-4c3e-8a8c-3f7f2c1e9d10';

  /** Keeps a canvas and its messages, then closes: all of it in core.db, and a snapshot of it. */
  async function keepMessages(at: number): Promise<void> {
    const { store } = await open(stoppedAt(at));
    store.tx(() => {
      store.prepare('INSERT INTO canvas (id, used_at) VALUES (?, 1)').run(CANVAS);
      for (let i = 0; i < 300; i++) {
        store
          .prepare(
            `INSERT INTO message (id, canvas_id, from_party, to_party, kind, origin, body, state,
               sent_at)
             VALUES (?, ?, 'you', 'agent:a', 'text', 'manual', ?, 'pending', 1)`,
          )
          .run(`message ${String(i)}`, CANVAS, 'x'.repeat(200));
      }
    });
    await store.close();
  }

  /** Overwrites part of each of `pages` (numbered from 1) of the database's file. */
  async function damage(pages: number[]): Promise<void> {
    const handle = await openFile(file, 'r+');
    try {
      for (const page of pages) {
        await handle.write(Buffer.alloc(512, 0x5a), 0, 512, (page - 1) * 4096 + 100);
      }
    } finally {
      await handle.close();
    }
  }

  /** Leaves at `log` a log another database wrote, and never checkpointed. */
  async function leaveLog(log: string): Promise<void> {
    const elsewhere = await mkdtemp(path.join(tmpdir(), 'corrallm-gone-'));
    const gone = connect(path.join(elsewhere, 'gone.db'));
    gone.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0');
    gone.exec("CREATE TABLE gone (note TEXT) STRICT; INSERT INTO gone VALUES ('from the log')");
    await copyFile(path.join(elsewhere, 'gone.db-wal'), log);
    gone.close();
    await rm(elsewhere, { recursive: true, force: true });
  }

  /** What was set aside: the database's file, as moved. */
  async function setAside(): Promise<string> {
    const [name, ...others] = (await readdir(profile)).filter((one) =>
      /^core\.rejected-[0-9a-f-]{36}\.db$/.test(one),
    );
    if (name === undefined || others.length > 0) throw new Error('Not one database set aside');
    return path.join(profile, name);
  }

  const canvases = (store: Store) => store.prepare('SELECT id FROM canvas').all();
  /** How many messages the store keeps from parties: not corrallm's notices of them. */
  const messages = (store: Store) =>
    store.prepare("SELECT count(*) AS messages FROM message WHERE kind = 'text'").get();
  /** That the store opened keeps what is written to it. */
  function works(store: Store): void {
    store.tx(() => store.prepare("INSERT INTO canvas (id, used_at) VALUES ('after', 2)").run());
    expect(canvases(store)).toContainEqual({ id: 'after' });
  }

  it('sets aside a file that isn’t a database, with its log, index and journal, and starts empty', async () => {
    await writeFile(file, 'This is not a database. '.repeat(500));
    await writeFile(`${file}-wal`, 'its log');
    await writeFile(`${file}-shm`, 'its index');
    // A journal with no transaction in it to roll back (its header zeroed, as SQLite may leave it).
    const journal = Buffer.concat([Buffer.alloc(28), Buffer.from('its journal')]);
    await writeFile(`${file}-journal`, journal);

    const { store, said } = await open();

    const rejected = await setAside();
    expect(said).toEqual([
      `The core’s database was damaged (file is not a database), and was moved to ${rejected}.`,
      'It starts empty.',
    ]);
    expect(await readFile(rejected, 'utf8')).toBe('This is not a database. '.repeat(500));
    expect(await readFile(`${rejected}-wal`, 'utf8')).toBe('its log');
    expect(Buffer.compare(await readFile(`${rejected}-journal`), journal)).toBe(0);
    // The log's index, which SQLite rebuilds from the log whenever it reads it, went with it.
    await expect(stat(`${rejected}-shm`)).resolves.toBeDefined();
    expect(canvases(store)).toEqual([]);
    works(store);
  });

  it('sets aside a database with damaged pages, restoring the newest snapshot that is sound', async () => {
    await keepMessages(Date.UTC(2026, 9, 19, 12));
    // A newer snapshot, which isn't sound.
    await writeFile(path.join(profile, 'backups', 'core-2026-10-19T13-00-00-000Z.db'), 'torn');
    const pages = (await stat(file)).size / 4096;
    await damage([pages - 6, pages - 4, pages - 2]);

    const { store, said } = await open();

    const rejected = await setAside();
    expect(said).toEqual([
      expect.stringMatching(
        /^The core’s database was damaged \(SQLite’s check found: .+\), and was moved to /,
      ),
      'It was restored from its snapshot of 2026-10-19T12:00:00.000Z: what changed since then is lost.',
    ]);
    expect(said[0]?.endsWith(` ${rejected}.`)).toBe(true);
    expect(canvases(store)).toEqual([{ id: CANVAS }]);
    expect(messages(store)).toEqual({ messages: 300 });
    expect(store.prepare('PRAGMA quick_check').get()).toEqual({ quick_check: 'ok' });
    works(store);
  });

  it('restores no snapshot that is empty, isn’t corrallm’s, or that this corrallm can’t read', async () => {
    await keepMessages(Date.UTC(2026, 9, 19, 12));
    const backups = path.join(profile, 'backups');
    const kept = path.join(backups, 'core-2026-10-19T12-00-00-000Z.db');
    // Newer snapshots: one a newer corrallm made, another app's database, and one whose bytes
    // never reached the disk.
    const newer = path.join(backups, 'core-2026-10-19T14-00-00-000Z.db');
    await copyFile(kept, newer);
    const raised = connect(newer);
    raised.exec(`UPDATE meta SET min_reader = ${String(SCHEMA + 1)}`);
    raised.exec(`PRAGMA user_version = ${String(SCHEMA + 1)}`);
    raised.close();
    const theirs = connect(path.join(backups, 'core-2026-10-19T15-00-00-000Z.db'));
    theirs.exec('CREATE TABLE theirs (id INTEGER PRIMARY KEY) STRICT');
    theirs.close();
    await writeFile(path.join(backups, 'core-2026-10-19T16-00-00-000Z.db'), '');
    await writeFile(file, 'This is not a database. '.repeat(500));

    const { store, said } = await open();

    expect(said[1]).toBe(
      'It was restored from its snapshot of 2026-10-19T12:00:00.000Z: what changed since then is lost.',
    );
    expect(canvases(store)).toEqual([{ id: CANVAS }]);
    expect(messages(store)).toEqual({ messages: 300 });
  });

  it('finishes a restore cut short the next time it opens, rather than starting empty', async () => {
    await keepMessages(Date.UTC(2026, 9, 19, 12));
    await writeFile(file, 'This is not a database. '.repeat(500));
    // The snapshot's copy fails once the database is set aside (on a full disk, say): here,
    // something is in its way.
    await mkdir(`${file}.restoring`);
    const failed = await openStore(profile);
    expect(failed.store).toBeUndefined();
    expect(failed.said).toEqual([
      `The core’s database was damaged (file is not a database), and was moved to ${await setAside()}.`,
      expect.stringMatching(/^The core’s database could not be opened \(.+\)\.$/),
    ]);
    await rm(`${file}.restoring`, { recursive: true });
    // A log left without its database belongs to none: never replayed into the snapshot.
    await leaveLog(`${file}-wal`);

    const { store, said } = await open();

    expect(said).toEqual([
      `The core’s database (${file}) was missing.`,
      'It was restored from its snapshot of 2026-10-19T12:00:00.000Z: what changed since then is lost.',
    ]);
    expect(canvases(store)).toEqual([{ id: CANVAS }]);
    expect(messages(store)).toEqual({ messages: 300 });
    expect(store.prepare('PRAGMA quick_check').get()).toEqual({ quick_check: 'ok' });
  });

  for (const snapshot of [true, false]) {
    it(`gives no message a place given before, restored ${snapshot ? 'from a snapshot' : 'empty'}`, async () => {
      const noon = Date.UTC(2026, 9, 19, 12);
      // Numbered on from the clock as it opened: noon's 300 messages.
      await keepMessages(noon);
      if (!snapshot) await rm(path.join(profile, 'backups'), { recursive: true });
      // Places given after the snapshot, which a cursor may hold, lost with the database.
      const lost = connect(file);
      const given = [301, 302, 303].map(
        (seq) =>
          lost
            .prepare(
              `INSERT INTO message (id, canvas_id, from_party, to_party, kind, origin, body, state,
                 sent_at)
               VALUES (?, ?, 'you', 'agent:a', 'text', 'manual', 'Hello', 'pending', 1) RETURNING seq`,
            )
            .get(`lost ${String(seq)}`, CANVAS)?.seq,
      );
      lost.close();
      expect(given).toEqual([noon + 301, noon + 302, noon + 303]);
      await writeFile(file, 'This is not a database. '.repeat(500));

      const { store } = await open(stoppedAt(Date.UTC(2026, 9, 19, 18)));

      if (!snapshot) store.prepare('INSERT INTO canvas (id, used_at) VALUES (?, 1)').run(CANVAS);
      const next = store
        .prepare(
          `INSERT INTO message (id, canvas_id, from_party, to_party, kind, origin, body, state,
             sent_at)
           VALUES ('after', ?, 'you', 'agent:a', 'text', 'manual', 'Hello', 'pending', 1) RETURNING seq`,
        )
        .get(CANVAS)?.seq;
      expect(next).toBeGreaterThan(noon + 303);
      expect(Number.isSafeInteger(next)).toBe(true);
      expect(store.prepare('SELECT typeof(seq) AS type FROM sqlite_sequence').all()).toEqual([
        { type: 'integer' },
      ]);
    });
  }

  it('gives no document a revision given before, restored from a snapshot', async () => {
    const noon = Date.UTC(2026, 9, 19, 12);
    await keepMessages(noon);
    const kept = connect(file);
    kept
      .prepare(
        `INSERT INTO document (canvas_id, rev, arrange, by_party, changed_at)
         VALUES (?, 5, 0, 'you', 1)`,
      )
      .run(CANVAS);
    kept.close();
    // Taken as it closes: the newest snapshot, which keeps the document at revision 5.
    const { store: snapshotted } = await open(stoppedAt(noon + 1000));
    await snapshotted.close();
    // Revisions given after the snapshot, which a token's `expect` may hold, lost with the database.
    const lost = connect(file);
    lost.prepare('UPDATE document SET rev = 9 WHERE canvas_id = ?').run(CANVAS);
    lost.close();
    await writeFile(file, 'This is not a database. '.repeat(500));
    const evening = Date.UTC(2026, 9, 19, 18);

    const { store } = await open(stoppedAt(evening));

    expect(store.prepare('SELECT rev FROM document').all()).toEqual([{ rev: evening }]);
  });

  it('never sends what waited in the snapshot it restores: unresolved, each sender told after every place given', async () => {
    const noon = Date.UTC(2026, 9, 19, 12);
    const { store: before } = await open(stoppedAt(noon));
    const row = (id: string, from: string, state: string, kind = 'text') =>
      before
        .prepare(
          `INSERT INTO message (id, canvas_id, from_party, to_party, kind, origin, body, state,
             sent_at)
           VALUES (?, ?, ?, 'agent:a', ?, 'manual', 'Hello', ?, 1)`,
        )
        .run(id, CANVAS, from, kind, state);
    before.tx(() => {
      before.prepare('INSERT INTO canvas (id, used_at) VALUES (?, 1)').run(CANVAS);
      row('waited', 'outside:orchestrator', 'pending');
      row('yours', 'you', 'pending');
      row('out', 'outside:orchestrator', 'delivering');
      row('done', 'outside:orchestrator', 'replied');
      row('told', 'corrallm', 'delivered', 'notice');
    });
    await before.close();
    await writeFile(file, 'This is not a database. '.repeat(500));

    const { store } = await open(stoppedAt(Date.UTC(2026, 9, 19, 18)));

    const sentence = (id: string) =>
      `Your message ${id} won’t be sent: corrallm’s database was restored from a snapshot taken while it waited, so whether it went since is unknown.`;
    const turn = (id: string) =>
      JSON.stringify({ status: 'failed', reason: 'error', message: sentence(id) });
    expect(
      store
        .prepare('SELECT seq, id, state, turn FROM message WHERE kind <> ? ORDER BY seq')
        .all('notice'),
    ).toEqual([
      { seq: noon + 1, id: 'waited', state: 'unresolved', turn: turn('waited') },
      { seq: noon + 2, id: 'yours', state: 'unresolved', turn: turn('yours') },
      // Being delivered, it is cut off as its canvas opens, as after any restart.
      { seq: noon + 3, id: 'out', state: 'delivering', turn: null },
      { seq: noon + 4, id: 'done', state: 'replied', turn: null },
    ]);
    const notices = store
      .prepare(
        `SELECT seq, from_party, to_party, body, reply_to, turn, state, sent_at FROM message
         WHERE kind = 'notice' AND reply_to IS NOT NULL ORDER BY seq`,
      )
      .all();
    expect(notices).toEqual(
      ['waited', 'yours'].map((id, i) => ({
        seq: Date.UTC(2026, 9, 19, 18) + i + 1,
        from_party: 'corrallm',
        to_party: id === 'yours' ? 'you' : 'outside:orchestrator',
        body: sentence(id),
        reply_to: id,
        turn: turn(id),
        state: 'delivered',
        sent_at: Date.UTC(2026, 9, 19, 18),
      })),
    );
  });

  it('sets aside a database SQLite finds damaged as it opens it', async () => {
    await keepMessages(Date.UTC(2026, 9, 19, 12));
    await rm(path.join(profile, 'backups'), { recursive: true });
    // The first page's tree, past the file's header.
    await damage([1]);

    const { store, said } = await open();

    expect(said).toEqual([
      `The core’s database was damaged (database disk image is malformed), and was moved to ${await setAside()}.`,
      'It starts empty.',
    ]);
    expect(canvases(store)).toEqual([]);
    works(store);
  });

  it('sets aside a database that isn’t corrallm’s', async () => {
    const other = connect(file);
    other.exec('CREATE TABLE theirs (id INTEGER PRIMARY KEY) STRICT');
    other.close();

    const { store, said } = await open();

    expect(said).toEqual([
      `The core’s database was damaged (it isn’t corrallm’s), and was moved to ${await setAside()}.`,
      'It starts empty.',
    ]);
    works(store);
  });

  it('begins a database anew without a log left behind by one that is gone', async () => {
    // As one set aside without its log would leave: SQLite deletes a log it finds beside an
    // empty file, never replaying it.
    await leaveLog(`${file}-wal`);

    const { store, said } = await open();

    expect(said).toEqual([]);
    expect(store.prepare("SELECT name FROM sqlite_schema WHERE name = 'gone'").all()).toEqual([]);
    expect(store.prepare('PRAGMA quick_check').get()).toEqual({ quick_check: 'ok' });
    works(store);
  });
});
