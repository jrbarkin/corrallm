import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, expect, it } from 'vitest';

import type { Core } from '../core';
import { NO_DESKTOP } from '../test-registry';
import { createCore, databaseOf } from './test-core';
import { readOnDisk } from './test-store';

const cores: Core[] = [];
const profiles: string[] = [];
afterEach(async () => {
  await Promise.all(cores.splice(0).map((core) => core.close()));
  await Promise.all(
    profiles.splice(0).map((profile) => rm(profile, { recursive: true, force: true })),
  );
});

it('keeps each concurrently composed test core paired with its own store', async () => {
  const folders = await Promise.all(
    [1, 2].map(() => mkdtemp(path.join(tmpdir(), 'corrallm-test-core-'))),
  );
  profiles.push(...folders);
  const started = await Promise.all(
    folders.map(async (profile) => {
      const core = await createCore(
        {
          profile,
          app: { name: 'corrallm', version: '1.0.0' },
          check: true,
          distribution: 'local',
          watchFolder: () => ({ close: () => undefined }),
        },
        NO_DESKTOP,
      );
      cores.push(core);
      return { core, profile };
    }),
  );
  for (const { core, profile } of started) {
    const store = databaseOf(core);
    expect(store.file).toBe(path.join(profile, 'core.db'));
    await store.write(() => {
      store.run('CREATE TABLE test_marker (value TEXT) STRICT');
      store.run('INSERT INTO test_marker VALUES (?)', profile);
    });
    expect(
      readOnDisk(profile, (reader) => reader.prepare('SELECT value FROM test_marker').get()),
    ).toEqual({ value: profile });
  }
});
