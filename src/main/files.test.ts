import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { deflateSync } from 'node:zlib';

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { MAX_FILE_MATCHES } from '../shared/session';

import { FileList, ProjectFiles } from './files';

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

  it('never walks into the workspaces’ checkouts the core keeps in .corral', async () => {
    await write('notes/plan.md');
    await write('.corral/worktrees/profile/workspace/src/plan-b.md');
    await write('canvas.corral');
    expect(await files().find(folder, 'plan', 50)).toEqual(['notes/plan.md']);
    expect(await files().find(folder, 'corral', 50)).toEqual(['canvas.corral']);
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

  it('keeps a folder’s prepared list for ten seconds, then lists it again', async () => {
    let now = 0;
    const project = new ProjectFiles({ environment: () => Promise.resolve({}), now: () => now });
    await write('first.md');
    expect(await project.find(folder, '', MAX_FILE_MATCHES)).toEqual(['first.md']);
    await write('second.md');
    now = 9999;
    expect(await project.find(folder, 'second', MAX_FILE_MATCHES)).toEqual([]);
    now = 10_000;
    expect(await project.find(folder, 'SECOND', MAX_FILE_MATCHES)).toEqual(['second.md']);
  });
});

/* A sparse index may need a promised tree, even though ls-files reads no blob bodies. */
describe.skipIf(process.platform === 'win32')('file suggestions in a sparse partial clone', () => {
  it.each([false, true])(
    'runs no remote program (Git ignores GIT_NO_LAZY_FETCH: %s)',
    async (oldGit) => {
      const source = path.join(folder, 'source');
      const clone = path.join(folder, 'clone');
      const sentinel = path.join(folder, 'ran');
      const env = {
        PATH: process.env.PATH ?? '',
        HOME: folder,
        GIT_CONFIG_NOSYSTEM: '1',
        LC_ALL: 'C',
      };
      const git = (cwd: string, ...args: string[]) =>
        execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: 'pipe' });
      await mkdir(source);
      git(source, 'init', '-qb', 'main');
      for (const name of ['keep', 'omitted']) {
        await mkdir(path.join(source, name));
        await writeFile(path.join(source, name, 'a.txt'), `${name}\n`);
      }
      git(source, 'add', '.');
      git(source, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
      git(source, 'config', 'uploadpack.allowFilter', 'true');
      git(folder, 'clone', '-q', '--filter=blob:none', '--no-checkout', `file://${source}`, clone);
      git(clone, 'sparse-checkout', 'set', '--cone', '--sparse-index', 'keep');
      git(clone, 'checkout', '-q');
      expect(git(clone, 'ls-files', '--sparse', '--stage')).toContain('040000');
      const missing = git(clone, 'rev-parse', 'HEAD:omitted').trim();
      const objects = git(clone, 'cat-file', '--batch-all-objects', '--batch-check=%(objectname)')
        .trim()
        .split('\n');
      // Repack locally without this promised tree, retaining every other object. No network or
      // remote helper is involved in fixture creation; the only remote so far was the temp source.
      const kept = objects
        .filter((oid) => oid !== missing)
        .map((oid) => {
          const kind = git(clone, 'cat-file', '-t', oid).trim();
          const body = execFileSync('git', ['cat-file', kind, oid], { cwd: clone, env });
          return {
            oid,
            data: deflateSync(
              Buffer.concat([Buffer.from(`${kind} ${String(body.length)}\0`), body]),
            ),
          };
        });
      const objectDir = path.join(clone, '.git', 'objects');
      await rename(objectDir, path.join(folder, 'old-objects'));
      await mkdir(objectDir);
      for (const { oid, data } of kept) {
        const prefix = path.join(objectDir, oid.slice(0, 2));
        await mkdir(prefix, { recursive: true });
        await writeFile(path.join(prefix, oid.slice(2)), data);
      }
      git(clone, 'config', 'remote.origin.url', `ext::sh -c touch% ${sentinel}`);
      git(clone, 'config', 'protocol.ext.allow', 'always');
      // A real control: expanding the sparse index tries the repository's remote command.
      git(clone, 'ls-files', '--cached', '--others', '--exclude-standard', '-z');
      expect(await readFile(sentinel, 'utf8')).toBe('');
      await rm(sentinel);
      let runtime = env;
      const used = path.join(folder, 'used');
      if (oldGit) {
        const real = execFileSync('sh', ['-c', 'command -v git'], { env, encoding: 'utf8' }).trim();
        const bin = path.join(folder, 'bin');
        await mkdir(bin);
        await writeFile(
          path.join(bin, 'git'),
          `#!/bin/sh\ntouch '${used}'\nunset GIT_NO_LAZY_FETCH\nexec '${real}' "$@"\n`,
          { mode: 0o755 },
        );
        runtime = { ...env, PATH: `${bin}${path.delimiter}${env.PATH}` };
      }
      const suggestions = new ProjectFiles({ environment: () => Promise.resolve(runtime) });
      expect(await suggestions.find(clone, 'keep/a', 50)).toContain('keep/a.txt');
      await expect(readFile(sentinel, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      if (oldGit) expect(await readFile(used, 'utf8')).toBe('');
    },
  );
});

describe('FileList', () => {
  const paths = [
    'src/',
    'src/main/',
    'src/main/ipc.ts',
    'src/main/ipc.test.ts',
    'src/preload/index.ts',
    'src/shared/ipc.ts',
    'README.md',
  ];

  it('puts names starting with what was typed first, then names and paths containing it', async () => {
    const list = await FileList.create(paths);
    expect(await list.find('ipc', 10)).toEqual([
      'src/main/ipc.ts',
      'src/shared/ipc.ts',
      'src/main/ipc.test.ts',
    ]);
    expect(await list.find('main/', 10)).toEqual([
      'src/main/',
      'src/main/ipc.ts',
      'src/main/ipc.test.ts',
    ]);
  });

  it('matches what was typed in order, ignoring case, and offers at most `limit`', async () => {
    const list = await FileList.create(paths);
    expect(await list.find('smipc', 10)).toEqual(['src/main/ipc.ts', 'src/main/ipc.test.ts']);
    expect(await list.find('readme', 10)).toEqual(['README.md']);
    expect(await list.find('', 2)).toEqual(['README.md', 'src/']);
  });
});

describe('a large FileList', () => {
  const paths = Array.from({ length: 50_000 }, (_, i) => {
    const folder = `packages/area-${String(i % 100)}/src/deep/feature-${String(i % 13)}`;
    const name = `${i % 2 ? 'Worker' : 'worker'}-${String(50_000 - i).padStart(5, '0')}`;
    return `${folder}/${name}${i % 5 ? '.ts' : '.test.ts'}`;
  });
  paths.push(...Array.from({ length: 1500 }, (_, i) => `packages/area-${String(i)}/src/deep/`));
  paths.push('README.md', 'Readme.md', 'readme.md', 'a/b.ts', 'a/B.ts', 'a/b.ts');
  paths.push(
    'İstanbul/💡.ts',
    'astral-💡/no-symbol.txt',
    'lone-\ud83d.ts',
    'lone-\udca1.ts',
    'literal\\backslash.ts',
    'trailing//',
    '',
  );
  let list: FileList;

  beforeAll(async () => {
    list = await FileList.create(paths);
  });

  it.each([
    '',
    'w',
    'WORKER-00',
    'area-7/src',
    'pafw',
    'area-7\\src',
    'no-such-file!',
    '💡',
    'i̇',
    '\ud83d',
    '\udca1',
    'a💡n',
    'a\ud83dn',
    'l\ud83dt',
  ])('keeps the old ranking and order for query %j at every limit', async (query) => {
    for (const limit of [0, 1, MAX_FILE_MATCHES, paths.length + 1]) {
      expect(await list.find(query, limit)).toEqual(referenceRank(paths, query, limit));
    }
  });

  it('lets other event-loop work run while scanning a cached list', async () => {
    let ran = false;
    const otherWork = setImmediate().then(() => {
      ran = true;
    });
    await list.find('pafw', MAX_FILE_MATCHES);
    expect(ran).toBe(true);
    await otherWork;
  });

  it('lets other event-loop work run while preparing a large list', async () => {
    let ran = false;
    const otherWork = setImmediate().then(() => {
      ran = true;
    });
    await FileList.create(paths);
    expect(ran).toBe(true);
    await otherWork;
  });
});

/** The original ranker, kept independently to check every score and tie against it. */
function referenceRank(paths: readonly string[], query: string, limit: number): string[] {
  const wanted = query.toLowerCase().replace(/\\/g, '/');
  const scored = paths.flatMap((file) => {
    const score = referenceScore(file.toLowerCase(), wanted);
    return score === undefined ? [] : [{ file, score }];
  });
  scored.sort(
    (a, b) =>
      a.score - b.score ||
      a.file.length - b.file.length ||
      (a.file < b.file ? -1 : a.file > b.file ? 1 : 0),
  );
  return scored.slice(0, limit).map(({ file }) => file);
}

function referenceScore(file: string, query: string): number | undefined {
  if (query === '') return file.split('/').length;
  const name = path.posix.basename(file.replace(/\/$/, ''));
  if (name.startsWith(query)) return 0;
  if (name.includes(query)) return 1;
  if (file.includes(query)) return 2;
  let at = 0;
  for (const char of file) {
    if (char === query[at]) at += 1;
    if (at === query.length) return 3;
  }
  return undefined;
}
