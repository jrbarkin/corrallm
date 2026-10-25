/**
 * Baseline settings for read-only Git. Patch-producing commands also need safeGitDiffArgs, and
 * SAFE_GIT_ENV over their environment.
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
 * Environment over the caller's for patch-producing Git: a partial clone fetches no missing object,
 * since a fetch runs the programs its remote's config names (upload-pack, ssh). Git 2.44 and later.
 */
export const SAFE_GIT_ENV = { GIT_NO_LAZY_FETCH: '1' } as const;

/**
 * Command arguments after SAFE_GIT_OPTIONS, for patches that must not run repository programs.
 * Read filterKeys with `git config --null --name-only --get-regexp '^filter\..*\.(clean|process)$'`
 * first: every configured driver must have its clean/process commands disabled. log and show also
 * check no signature, whatever log.showSignature says, since that runs gpg.program (or gpg.ssh.program).
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
    ...(command === 'diff' ? [] : ['--no-show-signature']),
  ];
}
