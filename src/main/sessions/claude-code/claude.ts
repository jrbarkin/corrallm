import { execFile } from '../process';
import { homedir } from 'node:os';
import path from 'node:path';

import { canRun, findExecutable } from '../executables';

/*
 * The `claude` executable both Claude connections run: Terminal runs it in a pty, and the Agent
 * SDK is pointed at it (`pathToClaudeCodeExecutable`), so that both use the version, login and
 * settings the user already has. corrallm never ships or updates its own.
 */

const EXECUTABLE = process.platform === 'win32' ? 'claude.exe' : 'claude';

/**
 * Where `claude` is: an explicit path if given (then only that one:
 * tests point it at a fake, and must never find the user's own), else the native installer's
 * (~/.local/bin), else the first on the agents' PATH (`env`, the login shell's). Undefined if none
 * can run.
 */
export async function findClaude(
  env: Readonly<Record<string, string>>,
  { home = homedir(), override }: { home?: string; override?: string | undefined } = {},
): Promise<string | undefined> {
  if (override) return (await canRun(override)) ? override : undefined;
  return findExecutable(EXECUTABLE, env, [path.join(home, '.local', 'bin', EXECUTABLE)]);
}

/** Where `claude` is (see `findClaude`); rejects, saying how to install it, if there is none. */
export async function requireClaude(
  env: Readonly<Record<string, string>>,
  options?: Parameters<typeof findClaude>[1],
): Promise<string> {
  const found = await findClaude(env, options);
  if (found === undefined) {
    throw new Error(
      "Claude Code isn't installed, or corrallm can't find it. Install it (https://code.claude.com), " +
        'log in by running `claude` once in a terminal, then try again.',
    );
  }
  return found;
}

/** How long `claude --help` may take. */
const HELP_MS = 10_000;

/** The flags a `claude --help` lists ("--effort", "-r", "--resume"…). */
export function helpFlags(help: string): Set<string> {
  const flags = new Set<string>();
  for (const line of help.split('\n')) {
    // An option's line starts with its flags, comma-separated, before its value and description.
    const names = /^\s+(-[\w-]+(?:,\s*-[\w-]+)*)/.exec(line)?.[1];
    for (const name of names?.split(/,\s*/) ?? []) flags.add(name);
  }
  return flags;
}

/**
 * What finds the flags a `claude` takes (as its --help lists them), so that a session is started
 * only with flags its CLI knows (an older one exits on an unknown option). Each executable is
 * asked once; one that cannot say (it fails, or is too slow) takes none, and is asked again next
 * time.
 */
export function claudeFlags(): (
  claude: string,
  env: Readonly<Record<string, string>>,
) => Promise<ReadonlySet<string>> {
  const asked = new Map<string, Promise<ReadonlySet<string>>>();
  return (claude, env) => {
    let flags = asked.get(claude);
    if (!flags) {
      flags = new Promise((resolve) => {
        execFile(claude, ['--help'], { env, timeout: HELP_MS }, (error, stdout) => {
          if (error) asked.delete(claude);
          resolve(error ? new Set() : helpFlags(stdout));
        });
      });
      asked.set(claude, flags);
    }
    return flags;
  };
}
