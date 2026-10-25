import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SAFE_GIT_ENV, SAFE_GIT_OPTIONS, safeGitDiffArgs } from './git';

it.each(['diff', 'log', 'show'] as const)(
  'keeps %s patches from running external diffs, textconv or configured filter drivers',
  (command) => {
    const args = safeGitDiffArgs(command, [
      'filter.lfs.clean',
      'filter.lfs.process',
      'filter.other.driver.process',
      'filter.other.driver.clean',
      '',
    ]);
    expect(args).toEqual([
      '-c',
      'filter.lfs.clean=',
      '-c',
      'filter.lfs.process=',
      '-c',
      'filter.lfs.required=false',
      '-c',
      'filter.other.driver.clean=',
      '-c',
      'filter.other.driver.process=',
      '-c',
      'filter.other.driver.required=false',
      command,
      '--no-ext-diff',
      '--no-textconv',
      ...(command === 'diff' ? [] : ['--no-show-signature']),
    ]);
    expect(SAFE_GIT_OPTIONS).toContain('core.fsmonitor=false');
    expect(SAFE_GIT_OPTIONS).toContain('safe.bareRepository=explicit');
  },
);

it('disables diff programs even when there are no filter drivers', () => {
  expect(safeGitDiffArgs('diff', [])).toEqual(['diff', '--no-ext-diff', '--no-textconv']);
});

it('blanks an empty driver name returned by Git’s filter-key query', () => {
  expect(safeGitDiffArgs('diff', ['filter..clean'])).toEqual([
    '-c',
    'filter..clean=',
    '-c',
    'filter..process=',
    '-c',
    'filter..required=false',
    'diff',
    '--no-ext-diff',
    '--no-textconv',
  ]);
});

/** No user or system configuration: only the fixture repository's own. */
const ISOLATED = { PATH: process.env.PATH ?? '', GIT_CONFIG_NOSYSTEM: '1' };

/** Runs git in `cwd`: what it printed, whatever its exit code. */
function git(
  cwd: string,
  args: readonly string[],
  { input, env = ISOLATED }: { input?: string; env?: NodeJS.ProcessEnv } = {},
): string {
  const run = spawnSync('git', args, { cwd, env, input, encoding: 'utf8' });
  if (run.error) throw run.error;
  return run.stdout;
}

/** A program for a repository's config to name, which leaves `pwned` in `dir` if it ever runs. */
async function marker(dir: string, name: string): Promise<string> {
  const program = path.join(dir, name);
  await writeFile(program, `#!/bin/sh\ntouch '${path.join(dir, 'pwned')}'\nexit 1\n`, {
    mode: 0o755,
  });
  return program;
}

describe.skipIf(process.platform === 'win32')('read-only Git in a hostile repository', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'corrallm-git-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const pwned = () => existsSync(path.join(dir, 'pwned'));

  it.each(['log', 'show'] as const)(
    '%s runs no signature-checking program the repository configures',
    async (command) => {
      const repo = path.join(dir, 'repo');
      git(dir, ['init', '-q', repo]);
      // A signed commit, its signature made up: git runs gpg.program only to verify it.
      const tree = git(repo, ['write-tree']).trim();
      const commit = git(repo, ['hash-object', '-t', 'commit', '-w', '--stdin'], {
        input: [
          `tree ${tree}`,
          'author A <a@example.com> 0 +0000',
          'committer A <a@example.com> 0 +0000',
          'gpgsig -----BEGIN PGP SIGNATURE-----',
          ' ',
          ' made up',
          ' -----END PGP SIGNATURE-----',
          '',
          'signed',
          '',
        ].join('\n'),
      }).trim();
      git(repo, ['update-ref', 'HEAD', commit]);
      git(repo, ['config', 'log.showSignature', 'true']);
      git(repo, ['config', 'gpg.program', await marker(dir, 'gpg.sh')]);
      // The fixture is hostile: plain git runs the program.
      git(repo, [command]);
      expect(pwned()).toBe(true);
      await rm(path.join(dir, 'pwned'));

      const shown = git(repo, [...SAFE_GIT_OPTIONS, ...safeGitDiffArgs(command, [])]);
      expect(shown).toContain('signed');
      expect(pwned()).toBe(false);
    },
    20_000,
  );

  // Git before 2.44 ignores GIT_NO_LAZY_FETCH and has no other switch for it.
  it.skipIf(!gitAtLeast(2, 44))(
    'shows a partial clone’s commit without fetching, so no fetch program the repository configures runs',
    async () => {
      const origin = path.join(dir, 'origin');
      const clone = path.join(dir, 'clone');
      git(dir, ['init', '-q', origin]);
      await writeFile(path.join(origin, 'a.txt'), 'hello\n');
      git(origin, ['add', 'a.txt']);
      git(origin, ['-c', 'user.name=A', '-c', 'user.email=a@example.com', 'commit', '-qm', 'one']);
      git(origin, ['config', 'uploadpack.allowFilter', 'true']);
      git(dir, ['clone', '-q', '--filter=blob:none', '--no-checkout', `file://${origin}`, clone]);
      git(clone, ['config', 'remote.origin.uploadpack', await marker(dir, 'upload.sh')]);
      // The fixture is hostile: plain git fetches a.txt to show it, running the program.
      git(clone, ['show']);
      expect(pwned()).toBe(true);
      await rm(path.join(dir, 'pwned'));

      git(clone, [...SAFE_GIT_OPTIONS, ...safeGitDiffArgs('show', [])], {
        env: { ...ISOLATED, ...SAFE_GIT_ENV },
      });
      expect(pwned()).toBe(false);
    },
    20_000,
  );
});

/** Whether the git on PATH is at least `major.minor`. */
function gitAtLeast(major: number, minor: number): boolean {
  const [, have = '0', minorHave = '0'] = /(\d+)\.(\d+)/.exec(git(tmpdir(), ['--version'])) ?? [];
  return Number(have) > major || (Number(have) === major && Number(minorHave) >= minor);
}
