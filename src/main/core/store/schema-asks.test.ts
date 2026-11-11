import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import * as migrations from './migrations';
import { MIGRATIONS } from './migrations';
import { STORE_FILE } from './open';
import type { Connection } from './sqlite';
import { SYSTEM_DEPS } from './store';
import { madeAtSchema } from './test-store';

let profile: string;
beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-schema-asks-'));
});
afterEach(async () => {
  vi.doUnmock('./migrations');
  vi.resetModules();
  await rm(profile, { recursive: true, force: true });
});

it.each([9, 10, 11, 12, 14, 15])(
  'requires reader %i after upgrading, leaving the store intact on refusal',
  async (version) => {
    const connection = madeAtSchema(profile, version - 1);
    migrations.migrate(connection, MIGRATIONS.slice(0, version));
    connection.close();
    const file = path.join(profile, STORE_FILE);
    const before = await readFile(file);

    vi.resetModules();
    const older = MIGRATIONS.slice(0, version - 1);
    vi.doMock('./migrations', () => ({
      ...migrations,
      MIGRATIONS: older,
      SCHEMA: version - 1,
      migrate: (disk: Connection) => {
        migrations.migrate(disk, older);
      },
    }));
    const { openStore } = await import('./open');
    const refused = await openStore(profile, { ...SYSTEM_DEPS, later: () => () => undefined });
    // Close an erroneously admitted store too, so a failing regression leaves no owned writer.
    await refused.store?.close();
    expect(refused.store).toBeUndefined();
    expect(refused.said).toEqual([
      `The core’s database (${file}) was made by a newer corrallm, which this one can’t read, and was left as it is: open this profile with that corrallm, or a newer one.`,
    ]);
    expect(await readFile(file)).toEqual(before);
  },
);
