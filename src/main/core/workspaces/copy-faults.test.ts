import * as fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { copyLocalFiles } from './copy';
import { commit, git, makeRepository } from './test-git';
import { testWorkspaces } from './test-workspace';
import type { TestWorkspaces } from './test-workspace';

vi.mock('node:fs', async (original) => ({ ...(await original<typeof fs>()) }));
vi.setConfig({ testTimeout: 30_000 });

let w: TestWorkspaces | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await w?.close();
  w = undefined;
});

describe.skipIf(process.platform === 'win32')('copy failure cleanup', () => {
  it('excludes the profile even when it is named through an alias', async () => {
    const t = (w = await testWorkspaces({
      '.gitignore': 'private/\n',
      '.worktreeinclude': 'private/\n',
    }));
    const profile = path.join(t.app, 'private');
    fs.mkdirSync(profile);
    fs.writeFileSync(path.join(profile, 'secret'), 'PROFILE_SECRET=1\n');
    const alias = path.join(t.root, 'profile-alias');
    fs.symlinkSync(profile, alias);
    const { tree, cwd } = await t.provision();
    const repository = await t.repository();
    await expect(
      copyLocalFiles(t.git, { repository, worktree: tree, cwd, profile: alias }),
    ).rejects.toMatchObject({ code: 'unsafe-path' });
    expect(fs.existsSync(path.join(tree.path, 'private', 'secret'))).toBe(false);
  });
  it('refuses a checkout root replaced by a symlink after its cwd was verified', async () => {
    const t = (w = await testWorkspaces({ '.gitignore': '.env\n', '.worktreeinclude': '.env\n' }));
    fs.writeFileSync(path.join(t.app, '.env'), 'SECRET=1\n');
    const { tree, cwd } = await t.provision();
    const repository = await t.repository();
    const outside = path.join(t.root, 'outside');
    makeRepository(outside, t.env, { 'README.md': 'outside\n' });
    fs.renameSync(tree.path, `${tree.path}.kept`);
    fs.symlinkSync(outside, tree.path);
    await expect(copyLocalFiles(t.git, { repository, worktree: tree, cwd })).rejects.toMatchObject({
      code: 'symlink',
    });
    expect(fs.existsSync(path.join(outside, '.env'))).toBe(false);
  });
  it.each(['file', 'directory'] as const)(
    'takes back the current copy when its %s flush fails',
    async (where) => {
      const t = (w = await testWorkspaces({
        '.gitignore': '.env\n',
        '.worktreeinclude': '.env\n',
      }));
      fs.writeFileSync(path.join(t.app, '.env'), 'SECRET=1\n');
      const { tree, cwd } = await t.provision();
      const repository = await t.repository();
      const flush = fs.fsyncSync;
      let failed = false;
      vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
        const stats = fs.fstatSync(fd);
        if (!failed && (where === 'directory' ? stats.isDirectory() : stats.isFile())) {
          failed = true;
          throw new Error('injected copy flush failure');
        }
        flush(fd);
      });
      await expect(
        copyLocalFiles(t.git, { repository, worktree: tree, cwd }),
      ).rejects.toMatchObject({ code: 'io' });
      expect(failed).toBe(true);
      expect(
        fs
          .readdirSync(tree.path)
          .filter((name) => name === '.env' || name.startsWith('.corrallm-copy-')),
      ).toEqual([]);
    },
  );

  it('refuses to adopt an existing public copy of a secret', async () => {
    const t = (w = await testWorkspaces({ '.gitignore': '.env\n', '.worktreeinclude': '.env\n' }));
    fs.writeFileSync(path.join(t.app, '.env'), 'SECRET=1\n');
    const { tree, cwd } = await t.provision();
    const repository = await t.repository();
    const existing = path.join(tree.path, '.env');
    fs.writeFileSync(existing, 'SECRET=1\n', { mode: 0o644 });
    await expect(copyLocalFiles(t.git, { repository, worktree: tree, cwd })).rejects.toMatchObject({
      code: 'exists',
    });
    expect(fs.statSync(existing).mode & 0o777).toBe(0o644);
  });

  it('refuses a selected name that aliases a tracked file by case', async () => {
    const t = (w = await testWorkspaces({
      '.gitignore': '.env\n',
      '.worktreeinclude': '.env\n',
    }));
    // The captured base tracks the other spelling. The picked checkout has untracked it.
    // `.ENV` is written after the first commit: committed with it, a case-sensitive filesystem
    // (Linux) doesn't ignore it by `.gitignore`'s `.env`, so there would be nothing to commit.
    fs.writeFileSync(path.join(t.app, '.ENV'), 'SECRET=1\n');
    git(t.app, t.env, 'add', '-f', '.ENV');
    commit(t.app, t.env, 'track the other spelling');
    git(t.app, t.env, 'rm', '--cached', '.ENV');
    fs.rmSync(path.join(t.app, '.ENV'));
    fs.writeFileSync(path.join(t.app, '.env'), 'SECRET=1\n');
    const { tree, cwd } = await t.provision();
    fs.chmodSync(path.join(tree.path, '.ENV'), 0o600);
    const repository = await t.repository();
    await expect(copyLocalFiles(t.git, { repository, worktree: tree, cwd })).rejects.toMatchObject({
      code: 'tracked',
    });
    expect(fs.readFileSync(path.join(tree.path, '.ENV'), 'utf8')).toBe('SECRET=1\n');
  });
});
