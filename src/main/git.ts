/** Settings for read-only Git commands that must not run repository-provided programs. */
export const SAFE_GIT_OPTIONS = [
  '-c',
  'core.quotepath=false',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'safe.bareRepository=explicit',
];
