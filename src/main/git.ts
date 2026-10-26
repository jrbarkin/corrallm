/**
 * Baseline arguments for read-only Git. Every call also overlays SAFE_GIT_ENV on its environment;
 * patch-producing commands additionally need safeGitDiffArgs.
 */
export const SAFE_GIT_OPTIONS = [
  '-c',
  'core.quotepath=false',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'safe.bareRepository=explicit',
];

/**
 * Over a read-only git's environment: a partial clone fetches no blob or tree it lacks, since the
 * fetch would run whatever its remote names (an `ext::` command its configuration allows, its
 * upload-pack, ssh). Git before 2.45.1 (and its 2.39.4+ backports) ignores GIT_NO_LAZY_FETCH, so
 * GIT_ALLOW_PROTOCOL, the one transport policy above every configuration, is an empty allowlist.
 * A word such as "none" would instead allow an external helper named git-remote-none.
 */
export const SAFE_GIT_ENV: Readonly<Record<string, string>> = {
  GIT_NO_LAZY_FETCH: '1',
  GIT_ALLOW_PROTOCOL: '',
};

/**
 * Command arguments after SAFE_GIT_OPTIONS, for patches that must not run repository programs.
 * Read filterKeys with `git config --null --name-only --get-regexp '^filter\..*\.(clean|process)$'`
 * first: every configured driver must have its clean/process commands disabled. Throws for a driver
 * whose name holds `=`: `-c` splits at the first one, so Git could not be told to disable it.
 * For log and show, `--no-show-signature` keeps log.showSignature from running gpg.program. A submodule is shown by
 * its commit only and never asked whether it is dirty: either would start a git in it, with its own
 * configuration (its external diff, its filter drivers), which no flag here reaches. Only the
 * command-line `--ignore-submodules` outranks a committed .gitmodules' `ignore`.
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
    // Only log and show verify signatures; diff (--no-index too) refuses the option.
    ...(command === 'diff' ? [] : ['--no-show-signature']),
    '--submodule=short',
    '--ignore-submodules=dirty',
  ];
}
