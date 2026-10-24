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
 * first: every configured driver must have its clean/process commands disabled. Throws for a driver
 * whose name holds `=`: `-c` splits at the first one, so Git could not be told to disable it.
 */
export function safeGitDiffArgs(
  command: 'diff' | 'log' | 'show',
  filterKeys: readonly string[],
): string[] {
  const drivers = new Set(
    filterKeys.flatMap((key) => /^(.*)\.(?:clean|process)$/s.exec(key)?.[1] ?? []),
  );
  for (const driver of drivers) {
    if (driver.includes('=')) {
      throw new Error(
        `The repository’s filter driver ${JSON.stringify(driver)} can’t be disabled.`,
      );
    }
  }
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
