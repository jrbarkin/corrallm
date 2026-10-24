import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { guardedFiles, MAX_GUARDED_FILES, RewindGuardSchema, sameGuard } from './rewind-guard';
import type { RewindGuard } from './rewind-guard';

/*
 * R5's guard (B11 Design §16.6): every file a code restore's preview names, by size, modification
 * time and SHA-256, read without following a link; at most MAX_GUARDED_FILES of them.
 */

let folder: string;
let home: string;
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

beforeEach(async () => {
  folder = await mkdtemp(path.join(tmpdir(), 'corrallm-guard-'));
  home = path.join(folder, 'home');
  await mkdir(path.join(folder, 'project', 'src'), { recursive: true });
  await mkdir(home);
});

afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

describe('the guard of a code restore', () => {
  it('keeps each file the preview names as it is now: relative to the session’s folder, ~ for home', async () => {
    const project = path.join(folder, 'project');
    await writeFile(path.join(project, 'src', 'app.ts'), 'one');
    await writeFile(path.join(home, 'notes.md'), 'two');
    const files = await guardedFiles(project, home, ['src/app.ts', '~/notes.md', 'gone.ts']);
    expect(files).toEqual([
      {
        path: 'src/app.ts',
        size: 3,
        mtimeMs: expect.any(Number) as unknown,
        sha256: sha256('one'),
      },
      {
        path: '~/notes.md',
        size: 3,
        mtimeMs: expect.any(Number) as unknown,
        sha256: sha256('two'),
      },
      { path: 'gone.ts', size: null, mtimeMs: null, sha256: null },
    ]);
  });

  it('sees a file changed since, even with its size and time kept', async () => {
    const project = path.join(folder, 'project');
    const file = path.join(project, 'src', 'app.ts');
    await writeFile(file, 'aaaa');
    const when = new Date('2026-10-01T00:00:00Z');
    await utimes(file, when, when);
    const [before] = await guardedFiles(project, home, ['src/app.ts']);
    await writeFile(file, 'bbbb');
    await utimes(file, when, when);
    const [after] = await guardedFiles(project, home, ['src/app.ts']);
    expect(after?.size).toBe(before?.size);
    expect(after?.mtimeMs).toBe(before?.mtimeMs);
    expect(after?.sha256).not.toBe(before?.sha256);
  });

  it('never follows a link: its target’s name is what it keeps', async () => {
    const project = path.join(folder, 'project');
    await writeFile(path.join(home, 'secret'), 'not to be read');
    await symlink(path.join(home, 'secret'), path.join(project, 'src', 'link.ts'));
    const [link] = await guardedFiles(project, home, ['src/link.ts']);
    expect(link?.sha256).toBe(sha256(path.join(home, 'secret')));
    expect(link?.sha256).not.toBe(sha256('not to be read'));
  });

  it('refuses more files than a proposal guards', async () => {
    const many = Array.from({ length: MAX_GUARDED_FILES + 1 }, (_, at) => `f${String(at)}.ts`);
    await expect(guardedFiles(folder, home, many)).rejects.toThrow(/more than the 200/);
  });

  it('reads back only as a guard, strictly, and compares file for file', () => {
    const guard: RewindGuard = {
      adapter: 'claude-code',
      conversation: null,
      message: 'u1',
      connection: 'claude-code.sdk',
      workspaceGeneration: 0,
      files: [{ path: 'a.ts', size: 1, mtimeMs: 2, sha256: 'a'.repeat(64) }],
    };
    expect(RewindGuardSchema.parse(guard)).toEqual(guard);
    expect(RewindGuardSchema.safeParse({ ...guard, extra: true }).success).toBe(false);
    expect(sameGuard(guard, { ...guard })).toBe(true);
    expect(sameGuard(guard, { ...guard, workspaceGeneration: 1 })).toBe(false);
    expect(
      sameGuard(guard, {
        ...guard,
        files: [{ path: 'a.ts', size: 1, mtimeMs: 3, sha256: 'a'.repeat(64) }],
      }),
    ).toBe(false);
  });
});
