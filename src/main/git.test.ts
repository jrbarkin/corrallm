import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SAFE_GIT_OPTIONS, safeGitDiffArgs } from './git';

it.each(['diff', 'log', 'show'] as const)(
  'keeps %s patches from running external diffs, textconv, configured filter drivers, signature programs or a submodule’s programs',
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
      '--submodule=short',
      '--ignore-submodules=dirty',
    ]);
    expect(SAFE_GIT_OPTIONS).toContain('core.fsmonitor=false');
    expect(SAFE_GIT_OPTIONS).toContain('safe.bareRepository=explicit');
  },
);

it('disables diff programs even when there are no filter drivers', () => {
  expect(safeGitDiffArgs('diff', [])).toEqual([
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--submodule=short',
    '--ignore-submodules=dirty',
  ]);
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
    '--submodule=short',
    '--ignore-submodules=dirty',
  ]);
});

/*
 * `-c` splits at the first `=`, so `-c filter.x=y.clean=` sets `filter.x` and leaves a driver
 * named `x=y` (selected by `filter=x=y` in .gitattributes) running. Run against a real repository
 * in a throwaway folder: the driver's program must never run.
 */
describe.skipIf(process.platform === 'win32')(
  'a driver Git can’t be told to disable by name',
  () => {
    let root: string;
    beforeEach(() => {
      root = realpathSync(mkdtempSync(path.join(tmpdir(), 'corrallm-git-')));
    });
    afterEach(() => {
      rmSync(root, { recursive: true, force: true });
    });

    it('is refused, and its program never runs', () => {
      const env = {
        PATH: process.env.PATH ?? '',
        HOME: root,
        GIT_CONFIG_NOSYSTEM: '1',
        LC_ALL: 'C',
      };
      const repository = path.join(root, 'repository');
      const sentinel = path.join(root, 'ran');
      const program = path.join(root, 'driver.sh');
      writeFileSync(program, `#!/bin/sh\necho ran >> '${sentinel}'\ncat\n`, { mode: 0o755 });
      const git = (...args: string[]) =>
        execFileSync('git', args, { cwd: repository, env, encoding: 'utf8' });
      mkdirSync(repository);
      git('init', '-q');
      writeFileSync(path.join(repository, '.gitattributes'), '*.txt filter=x=y\n');
      writeFileSync(path.join(repository, 'a.txt'), 'one\n');
      git('add', '.');
      git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
      git('config', 'filter.x=y.clean', program);
      writeFileSync(path.join(repository, 'a.txt'), 'two\n');
      const keys = git(
        'config',
        '--null',
        '--name-only',
        '--get-regexp',
        '^filter\\..*\\.(clean|process)$',
      ).split('\0');

      let args: string[] | undefined;
      try {
        args = safeGitDiffArgs('diff', keys);
      } catch {
        args = undefined;
      }
      if (args !== undefined) git(...SAFE_GIT_OPTIONS, ...args);
      expect(existsSync(sentinel)).toBe(false);
      expect(args).toBeUndefined();
    });
  },
);
