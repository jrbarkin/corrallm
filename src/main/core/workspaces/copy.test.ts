import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { COPY_LIMITS } from '../../../shared/model/worktree-setup';
import { CopyError, copyLocalFiles } from './copy';
import type { CopyRecord } from './copy';
import { commit, git } from './test-git';
import { testWorkspaces } from './test-workspace';
import type { TestWorkspaces } from './test-workspace';

/*
 * Copying a picked checkout's local files into a new workspace (B9a Design §4, Copy rules): only
 * regular files that the `.worktreeinclude` committed at the workspace's base selects and that Git
 * ignores in the picked checkout; never through a symlink on either side, never over a file the
 * workspace has, never past the limits; and all or nothing. Real Git, real checkouts.
 */

// Real repositories, on a machine that may be busy.
vi.setConfig({ testTimeout: 30_000 });

let w: TestWorkspaces | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

async function workspaces(files: Record<string, string>): Promise<TestWorkspaces> {
  w = await testWorkspaces(files);
  return w;
}

function write(at: string, text: string): void {
  mkdirSync(path.dirname(at), { recursive: true });
  writeFileSync(at, text);
}

async function copy(t: TestWorkspaces): Promise<{ record: CopyRecord; tree: string }> {
  const { tree, cwd } = await t.provision();
  const repository = await t.repository();
  const record = await copyLocalFiles(t.git, { repository, worktree: tree, cwd });
  return { record, tree: tree.path };
}

async function refusal(t: TestWorkspaces): Promise<{ code: string; tree: string }> {
  const { tree, cwd } = await t.provision();
  const repository = await t.repository();
  try {
    await copyLocalFiles(t.git, { repository, worktree: tree, cwd });
  } catch (error) {
    if (error instanceof CopyError) return { code: error.code, tree: tree.path };
    throw error;
  }
  throw new Error('It copied.');
}

describe.skipIf(process.platform === 'win32')('copyLocalFiles', () => {
  it('copies nothing without a .worktreeinclude, not even an ignored .env', async () => {
    const t = await workspaces({ '.gitignore': '.env\n', 'README.md': 'hello\n' });
    write(path.join(t.app, '.env'), 'SECRET=1\n');
    const { record, tree } = await copy(t);
    expect(record).toMatchObject({ manifest: null, files: [], bytes: 0 });
    expect(record.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(path.join(tree, '.env'))).toBe(false);
  });

  it('copies the selected, Git-ignored regular files privately, recording only names and hashes', async () => {
    const t = await workspaces({
      '.gitignore': '.env*\nsecrets/\nconfig/local.json\n*.log\n',
      '.worktreeinclude': '.env*\n!.env.example\nsecrets/\nconfig/local.json\nuntracked.txt\n',
      'README.md': 'hello\n',
      'config/app.json': '{"tracked":true}\n',
    });
    write(path.join(t.app, '.env'), 'A=1\n');
    write(path.join(t.app, '.env.local'), 'B=2\n');
    write(path.join(t.app, '.env.example'), 'A=\n');
    write(path.join(t.app, 'secrets', 'key'), 'key\n');
    write(path.join(t.app, 'secrets', 'deep', 'k2'), 'k2\n');
    write(path.join(t.app, 'config', 'local.json'), '{"local":true}\n');
    // Selected, but not ignored: an untracked file of the checkout's, not a local one.
    write(path.join(t.app, 'untracked.txt'), 'mine\n');
    // Ignored, but not selected.
    write(path.join(t.app, 'debug.log'), 'log\n');
    const { record, tree } = await copy(t);
    expect(record.files.map(({ path: file }) => file)).toEqual([
      '.env',
      '.env.local',
      'config/local.json',
      'secrets/deep/k2',
      'secrets/key',
    ]);
    for (const file of record.files) {
      const at = path.join(tree, file.path);
      expect(readFileSync(at, 'utf8')).toBe(readFileSync(path.join(t.app, file.path), 'utf8'));
      expect(statSync(at).mode & 0o777).toBe(0o600);
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(file.bytes).toBe(statSync(at).size);
    }
    expect(record.bytes).toBe(record.files.reduce((sum, file) => sum + file.bytes, 0));
    for (const file of ['.env.example', 'untracked.txt', 'debug.log']) {
      expect(existsSync(path.join(tree, file)), file).toBe(false);
    }
    // Its record names files, never what they hold.
    expect(JSON.stringify(record)).not.toMatch(/A=1|B=2|"local":true|key\\n/);
    // Its tracked files are as the base has them, and the copies are ignored there too.
    expect(readFileSync(path.join(tree, 'config', 'app.json'), 'utf8')).toBe('{"tracked":true}\n');
    expect(git(tree, t.env, 'status', '--porcelain')).toBe('');
  });

  it('reads the .worktreeinclude committed at the base, never one changed since or not committed', async () => {
    const t = await workspaces({
      '.gitignore': '.env\nsecrets/\n',
      '.worktreeinclude': '.env\n',
    });
    write(path.join(t.app, '.env'), 'A=1\n');
    write(path.join(t.app, 'secrets', 'key'), 'key\n');
    // The picked checkout's own copy asks for more, uncommitted: it isn't read.
    write(path.join(t.app, '.worktreeinclude'), '.env\nsecrets/\n');
    const { record, tree } = await copy(t);
    expect(record.files.map(({ path: file }) => file)).toEqual(['.env']);
    expect(existsSync(path.join(tree, 'secrets'))).toBe(false);
    expect(record.manifest).toMatch(/^[0-9a-f]{40}$/);
  });

  it('refuses a selected symlink, copying nothing, and leaves what it points to unread', async () => {
    const t = await workspaces({
      '.gitignore': '.env\nlinked\n',
      '.worktreeinclude': '.env\nlinked\n',
    });
    write(path.join(t.app, '.env'), 'A=1\n');
    const outside = path.join(t.root, 'outside', 'secret');
    write(outside, 'not the project’s\n');
    symlinkSync(outside, path.join(t.app, 'linked'));
    const { code, tree } = await refusal(t);
    expect(code).toBe('symlink');
    // All or nothing: not even the safe .env is copied.
    expect(existsSync(path.join(tree, '.env'))).toBe(false);
    expect(existsSync(path.join(tree, 'linked'))).toBe(false);
  });

  it('never writes through a symlink in the workspace: a folder the base has as a link refuses', async () => {
    const outside = path.join(
      (w = await testWorkspaces({ 'README.md': 'hello\n' })).root,
      'outside',
    );
    const t = w;
    mkdirSync(outside);
    // The base commit has `config` as a symlink out of the checkout ...
    symlinkSync(outside, path.join(t.app, 'config'));
    write(path.join(t.app, '.gitignore'), 'config/local.json\n');
    write(path.join(t.app, '.worktreeinclude'), 'config/local.json\n');
    git(t.app, t.env, 'add', '-A');
    commit(t.app, t.env, 'link');
    // ... while the picked checkout has a real folder there now, holding a local file.
    rmSync(path.join(t.app, 'config'));
    write(path.join(t.app, 'config', 'local.json'), '{"local":true}\n');
    const { code, tree } = await refusal(t);
    expect(code).toBe('symlink');
    expect(lstatSync(path.join(tree, 'config')).isSymbolicLink()).toBe(true);
    expect(existsSync(path.join(outside, 'local.json'))).toBe(false);
  });

  it('refuses a file over its size limit, copying nothing', async () => {
    const t = await workspaces({ '.gitignore': '.env*\n', '.worktreeinclude': '.env*\n' });
    write(path.join(t.app, '.env'), 'A=1\n');
    const big = path.join(t.app, '.env.big');
    write(big, '');
    truncateSync(big, COPY_LIMITS.fileBytes + 1);
    const { code, tree } = await refusal(t);
    expect(code).toBe('file-bytes');
    expect(existsSync(path.join(tree, '.env'))).toBe(false);
  });

  it('refuses more files than its limit, rather than copying some of them', async () => {
    const t = await workspaces({ '.gitignore': 'secrets/\n', '.worktreeinclude': 'secrets/\n' });
    for (let i = 0; i <= COPY_LIMITS.files; i += 1) {
      write(path.join(t.app, 'secrets', `key-${String(i)}`), 'k\n');
    }
    const { code, tree } = await refusal(t);
    expect(code).toBe('file-count');
    expect(existsSync(path.join(tree, 'secrets'))).toBe(false);
  });

  it('refuses a .worktreeinclude over its limit', async () => {
    const t = await workspaces({
      '.gitignore': '.env\n',
      '.worktreeinclude': `.env\n${'#'.repeat(COPY_LIMITS.manifestBytes)}\n`,
    });
    write(path.join(t.app, '.env'), 'A=1\n');
    expect((await refusal(t)).code).toBe('manifest-bytes');
  });

  it('refuses a .worktreeinclude that is a symlink at the base', async () => {
    const t = await workspaces({ '.gitignore': '.env\n', 'include.txt': '.env\n' });
    symlinkSync('include.txt', path.join(t.app, '.worktreeinclude'));
    git(t.app, t.env, 'add', '-A');
    commit(t.app, t.env, 'link the manifest');
    write(path.join(t.app, '.env'), 'A=1\n');
    expect((await refusal(t)).code).toBe('manifest');
  });

  it('never copies over a file the workspace tracks', async () => {
    const t = await workspaces({
      '.worktreeinclude': 'config/local.json\n',
      'config/local.json': '{"committed":true}\n',
    });
    // Ignored once it was tracked, which keeps it tracked at the base ...
    write(path.join(t.app, '.gitignore'), 'config/local.json\n');
    git(t.app, t.env, 'add', '.gitignore');
    commit(t.app, t.env, 'ignore it');
    // ... and no longer tracked in the picked checkout (not committed): a local file there.
    git(t.app, t.env, 'rm', '-q', '--cached', 'config/local.json');
    write(path.join(t.app, 'config', 'local.json'), '{"local":true}\n');
    const { code, tree } = await refusal(t);
    expect(code).toBe('tracked');
    expect(readFileSync(path.join(tree, 'config', 'local.json'), 'utf8')).toBe(
      '{"committed":true}\n',
    );
  });

  it('copies again after a crash part way, adopting its own copies, but never over a changed one', async () => {
    const t = await workspaces({ '.gitignore': '.env*\n', '.worktreeinclude': '.env*\n' });
    write(path.join(t.app, '.env'), 'A=1\n');
    write(path.join(t.app, '.env.local'), 'B=2\n');
    const { tree, cwd } = await t.provision();
    const repository = await t.repository();
    const first = await copyLocalFiles(t.git, { repository, worktree: tree, cwd });
    // A crash left only one of them.
    rmSync(path.join(tree.path, '.env.local'));
    const again = await copyLocalFiles(t.git, { repository, worktree: tree, cwd });
    expect(again).toEqual(first);
    expect(readFileSync(path.join(tree.path, '.env.local'), 'utf8')).toBe('B=2\n');
    // One changed in the workspace is never copied over.
    writeFileSync(path.join(tree.path, '.env'), 'A=changed\n');
    await expect(copyLocalFiles(t.git, { repository, worktree: tree, cwd })).rejects.toMatchObject({
      code: 'exists',
    });
    expect(readFileSync(path.join(tree.path, '.env'), 'utf8')).toBe('A=changed\n');
  });

  it('never copies another workspace’s files out of the owned folder', async () => {
    const t = await workspaces({ '.gitignore': '.env\n', '.worktreeinclude': '.env\n' });
    write(path.join(t.app, '.env'), 'A=picked\n');
    const one = await t.provision('agent/one');
    writeFileSync(path.join(one.tree.path, '.env'), 'A=one’s own\n');
    const two = await t.provision('agent/two');
    const repository = await t.repository();
    const record = await copyLocalFiles(t.git, {
      repository,
      worktree: two.tree,
      cwd: two.cwd,
    });
    expect(record.files.map(({ path: file }) => file)).toEqual(['.env']);
    expect(readFileSync(path.join(two.tree.path, '.env'), 'utf8')).toBe('A=picked\n');
  });
});
