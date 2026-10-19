import { mkdtemp, rm } from 'node:fs/promises';
import type * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { restoreSnapshot, snapshotName, snapshotTime, takeSnapshot } from './snapshots';
import { connect } from './sqlite';

/*
 * A snapshot's name says when it was taken, and only a snapshot's name is read as one. A snapshot,
 * and a snapshot restored, are forced to disk before they are named.
 */

/** What the file system was asked to force to disk, and to move, in order (by base name). */
const disk = vi.hoisted(() => [] as string[]);

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        await sync();
        disk.push(`fsync ${path.basename(String(args[0]))}`);
      };
      return handle;
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      await actual.rename(...args);
      disk.push(`rename to ${path.basename(String(args[1]))}`);
    },
  };
});

let profile: string;

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-snapshots-'));
  disk.length = 0;
});

afterEach(async () => {
  await rm(profile, { recursive: true, force: true });
});

describe('snapshot names', () => {
  it('name when a snapshot was taken, in UTC, and read back as that time', () => {
    const at = Date.UTC(2026, 9, 19, 12, 34, 56, 789);
    expect(snapshotName(at)).toBe('core-2026-10-19T12-34-56-789Z.db');
    expect(snapshotTime(snapshotName(at))).toBe(at);
  });

  it('read as no time a name that isn’t a snapshot’s', () => {
    for (const name of [
      'core.db',
      'core-2026-10-19T12-34-56-789Z.db.partial',
      'core-2026-13-45T12-34-56-789Z.db',
      'core-2026-10-19T12-34-56Z.db',
      'core.rejected-0a6f6a5e-4bb3-4c3e-8a8c-3f7f2c1e9d10.db',
    ]) {
      expect(snapshotTime(name), name).toBeUndefined();
    }
  });
});

describe('snapshots on disk', () => {
  /** Forcing a folder's entries to disk: Windows opens no folder to. */
  const folder = (name: string) => (process.platform === 'win32' ? [] : [`fsync ${name}`]);

  it('are forced to disk before they are named, and their folder after', async () => {
    const source = path.join(profile, 'core.db');
    const database = connect(source);
    database.exec("CREATE TABLE note (text TEXT NOT NULL) STRICT; INSERT INTO note VALUES ('a')");
    database.close();

    const snapshot = await takeSnapshot(source, profile, Date.UTC(2026, 9, 19, 12));

    expect(disk).toEqual([
      'fsync core-2026-10-19T12-00-00-000Z.db.partial',
      'rename to core-2026-10-19T12-00-00-000Z.db',
      ...folder('backups'),
    ]);

    disk.length = 0;
    const restored = path.join(profile, 'restored.db');
    await restoreSnapshot(snapshot, restored);

    expect(disk).toEqual([
      'fsync restored.db.restoring',
      'rename to restored.db',
      ...folder(path.basename(profile)),
    ]);
    const reader = connect(restored, { readOnly: true });
    try {
      expect(reader.prepare('SELECT text FROM note').all()).toEqual([{ text: 'a' }]);
    } finally {
      reader.close();
    }
  });
});
