import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import type * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { writeWhole } from './whole-file';

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

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'corrallm-whole-'));
  file = path.join(dir, 'store.json');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('writeWhole', () => {
  it('writes a file whole while other writes of it are under way, each beside it on its own', async () => {
    const texts = ['one', 'two', 'three', 'four', 'five'].map((word) => `${word}\n`);
    await Promise.all(texts.map((text) => writeWhole(file, text)));
    expect(texts).toContain(await readFile(file, 'utf8'));
    // Nothing is left beside it.
    expect(await readdir(dir)).toEqual(['store.json']);
  });

  it('forces a durable write to disk: the file before it is moved into place, its folder after', async () => {
    disk.length = 0;
    await writeWhole(file, 'kept\n', { durable: true, mode: 0o600 });
    expect(await readFile(file, 'utf8')).toBe('kept\n');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(disk).toEqual([
      expect.stringMatching(/^fsync store\.json\..+\.partial$/) as string,
      'rename to store.json',
      ...(process.platform === 'win32' ? [] : [`fsync ${path.basename(dir)}`]),
    ]);
    // Any other write is moved into place only.
    disk.length = 0;
    await writeWhole(file, 'again\n');
    expect(disk).toEqual(['rename to store.json']);
  });
});
