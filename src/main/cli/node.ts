/*
 * The Node `corrallm` runs on, checked before anything else of the CLI loads (index.ts). This
 * module imports nothing, so that checking it loads nothing either.
 */

/** The oldest Node the CLI runs on: package.json's engines. */
export const NEEDED_NODE = '24.21.0';

/**
 * What a command line that can never work exits with (sysexits' EX_USAGE): one run by a Node too
 * old, too, which no retry mends.
 */
export const USAGE_ERROR = 64;

/**
 * Why the CLI won't run on Node `found` (as process.versions.node says it), in a sentence naming
 * both Nodes: undefined if `found` is NEEDED_NODE or later. A version it can't read is refused.
 */
export function nodeRefusal(found: string): string | undefined {
  const parts = (version: string) => version.split('.', 3).map((part) => Number.parseInt(part, 10));
  const have = parts(found);
  for (const [i, needed] of parts(NEEDED_NODE).entries()) {
    const had = have[i] ?? 0;
    if (had !== needed) {
      return had > needed
        ? undefined
        : `corrallm needs Node ${NEEDED_NODE} or later, and this is Node ${found}.`;
    }
  }
  return undefined;
}
