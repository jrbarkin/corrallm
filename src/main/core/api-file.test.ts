import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readApiFile, removeOwnApiFile, writeApiFile } from './api-file';
import type { ApiFile } from './api-file';
import { processStart } from './lock';

/*
 * The profile's api.json, one format for every owner (the app's core and `corrallm serve`): written
 * 0600 once its owner listens, read only while the process it names runs, and removed only by the
 * owner that wrote that very record, so an old owner's late cleanup never removes a new one's.
 */

let profile: string;

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-api-file-'));
});
afterEach(async () => {
  await rm(profile, { recursive: true, force: true });
});

/** This process's record, listening on `port`. */
function own(port: number): ApiFile {
  return {
    url: `http://127.0.0.1:${String(port)}/mcp`,
    port,
    pid: process.pid,
    started: processStart(),
  };
}

describe('api.json', () => {
  it('is written whole and 0600, and read back while its process runs', async () => {
    const record = own(4321);
    await writeApiFile(profile, record);
    expect((await stat(path.join(profile, 'api.json'))).mode & 0o777).toBe(0o600);
    expect(await readApiFile(profile)).toEqual(record);
  });

  it('is removed by the owner that wrote it', async () => {
    const record = own(4321);
    await writeApiFile(profile, record);
    expect(removeOwnApiFile(profile, record)).toBe(true);
    expect(existsSync(path.join(profile, 'api.json'))).toBe(false);
    // Nothing else is left beside it.
    expect(await readdir(profile)).toEqual([]);
  });

  it('is left alone by an owner whose record a newer one replaced: a late cleanup removes nothing', async () => {
    const old = own(4321);
    await writeApiFile(profile, old);
    // A new core (the next epoch, another process) listens on the same port and publishes.
    const newer: ApiFile = { ...old, pid: old.pid + 1 };
    await writeApiFile(profile, newer);
    expect(removeOwnApiFile(profile, old)).toBe(false);
    expect(JSON.parse(await readFile(path.join(profile, 'api.json'), 'utf8'))).toEqual(newer);
    expect(await readdir(profile)).toEqual(['api.json']);
  });

  it('is left alone when it names another port of this process', async () => {
    const before = own(4321);
    await writeApiFile(profile, before);
    const after = own(4322);
    await writeApiFile(profile, after);
    expect(removeOwnApiFile(profile, before)).toBe(false);
    expect(JSON.parse(await readFile(path.join(profile, 'api.json'), 'utf8'))).toEqual(after);
  });

  it('is nothing to remove when there is none, or it is not a record', async () => {
    expect(removeOwnApiFile(profile, own(4321))).toBe(false);
    await writeApiFile(profile, own(4321));
    await rm(path.join(profile, 'api.json'));
    expect(removeOwnApiFile(profile, own(4321))).toBe(false);
    expect(await readdir(profile)).toEqual([]);
  });
});
