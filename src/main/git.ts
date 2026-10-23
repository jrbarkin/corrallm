/** Baseline settings for read-only Git. Patch-producing commands also need safeGitDiffArgs. */
export const SAFE_GIT_OPTIONS = [
  '-c',
  'core.quotepath=false',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'safe.bareRepository=explicit',
];

/**
 * Command arguments after SAFE_GIT_OPTIONS, for patches that must not run repository programs.
 * Read filterKeys with `git config --null --name-only --get-regexp '^filter\..*\.(clean|process)$'`
 * first: every configured driver must have its clean/process commands disabled.
 */
export function safeGitDiffArgs(
  command: 'diff' | 'log' | 'show',
  filterKeys: readonly string[],
): string[] {
  const drivers = new Set(
    filterKeys.flatMap((key) => /^(.*)\.(?:clean|process)$/.exec(key)?.[1] ?? []),
  );
  return [
    ...[...drivers].flatMap((driver) => [
      '-c',
      `${driver}.clean=`,
      '-c',
      `${driver}.process=`,
      '-c',
      `${driver}.required=false`,
    ]),
    command,
    '--no-ext-diff',
    '--no-textconv',
  ];
}
