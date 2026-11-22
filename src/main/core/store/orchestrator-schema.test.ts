import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import * as migrations from './migrations';
import type { Connection } from './sqlite';
import { openStore } from './open';
import { madeAtSchema, readOnDisk } from './test-store';
let profile: string | undefined;
afterEach(async () => {
  vi.doUnmock('./migrations');
  vi.resetModules();
  if (profile !== undefined) await rm(profile, { recursive: true, force: true });
});
it('requires a reader that preserves approved orchestrator revocations', async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'approved-schema-'));
  madeAtSchema(profile, 15).close();
  const current = await openStore(profile);
  if (current.store === undefined) throw new Error('No store');
  await current.store.close();
  expect(
    readOnDisk(profile, (db) => db.prepare('SELECT min_reader FROM meta').get()?.min_reader),
  ).toBe(16);
  const first = migrations.MIGRATIONS.slice(0, 15);
  vi.resetModules();
  vi.doMock('./migrations', () => ({
    ...migrations,
    SCHEMA: 15,
    MIGRATIONS: first,
    migrate: (connection: Connection) => {
      migrations.migrate(connection, first);
    },
  }));
  const legacy = await import('./open');
  const refused = await legacy.openStore(profile);
  await refused.store?.close();
  expect(refused.store).toBeUndefined();
});
