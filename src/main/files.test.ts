import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ProjectFiles, rank } from './files';

let folder: string;

beforeEach(async () => {
  folder = await mkdtemp(path.join(tmpdir(), 'corrallm-files-'));
});

afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

async function write(file: string) {
  await mkdir(path.dirname(path.join(folder, file)), { recursive: true });
  await writeFile(path.join(folder, file), '');
}

const files = () =>
  new ProjectFiles({
    environment: () => Promise.resolve({ ...process.env } as Record<string, string>),
  });

describe('ProjectFiles', () => {
  it('offers the files git knows of, and their folders, but not what it ignores', async () => {
    execFileSync('git', ['init', '-q'], { cwd: folder });
    await write('.gitignore');
    await writeFile(path.join(folder, '.gitignore'), 'secret.txt\n');
    await write('src/main/ipc.ts');
    await write('src/renderer/App.tsx');
    await write('secret.txt');
    execFileSync('git', ['add', 'src/main/ipc.ts'], { cwd: folder });

    const found = await files().find(folder, '', 50);
    expect(found).toEqual(
      expect.arrayContaining(['src/', 'src/main/', 'src/main/ipc.ts', 'src/renderer/App.tsx']),
    );
    expect(found).not.toContain('secret.txt');
  });

  it('walks a folder that is not a repository, skipping dependencies', async () => {
    await write('notes/plan.md');
    await write('node_modules/left-pad/index.js');
    const found = await files().find(folder, 'plan', 50);
    expect(found).toEqual(['notes/plan.md']);
    expect(await files().find(folder, 'left', 50)).toEqual([]);
  });

  it('does not run a repository’s fsmonitor when suggesting files', async () => {
    execFileSync('git', ['init', '-q'], { cwd: folder });
    await write('notes.md');
    execFileSync('git', ['add', 'notes.md'], { cwd: folder });
    const hook = path.join(folder, 'fsmonitor-hook');
    await writeFile(hook, "#!/bin/sh\nprintf invoked > fsmonitor-invoked\nprintf 'timestamp\\0'\n");
    await chmod(hook, 0o755);
    execFileSync('git', ['config', 'core.fsmonitor', './fsmonitor-hook'], { cwd: folder });

    expect(await files().find(folder, 'notes', 50)).toEqual(['notes.md']);
    await expect(readFile(path.join(folder, 'fsmonitor-invoked'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

describe('rank', () => {
  const paths = [
    'src/',
    'src/main/',
    'src/main/ipc.ts',
    'src/main/ipc.test.ts',
    'src/preload/index.ts',
    'src/shared/ipc.ts',
    'README.md',
  ];

  it('puts names starting with what was typed first, then names and paths containing it', () => {
    expect(rank(paths, 'ipc', 10)).toEqual([
      'src/main/ipc.ts',
      'src/shared/ipc.ts',
      'src/main/ipc.test.ts',
    ]);
    expect(rank(paths, 'main/', 10)).toEqual([
      'src/main/',
      'src/main/ipc.ts',
      'src/main/ipc.test.ts',
    ]);
  });

  it('matches what was typed in order, ignoring case, and offers at most `limit`', () => {
    expect(rank(paths, 'smipc', 10)).toEqual(['src/main/ipc.ts', 'src/main/ipc.test.ts']);
    expect(rank(paths, 'readme', 10)).toEqual(['README.md']);
    expect(rank(paths, '', 2)).toEqual(['README.md', 'src/']);
  });
});
