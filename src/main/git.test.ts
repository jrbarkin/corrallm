import { expect, it } from 'vitest';

import { SAFE_GIT_OPTIONS, safeGitDiffArgs } from './git';

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
