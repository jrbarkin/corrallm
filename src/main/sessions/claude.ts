import { homedir } from 'node:os';
import path from 'node:path';

import { canRun, findExecutable } from './executables';

/*
 * The `claude` executable both Claude connections run: Terminal runs it in a pty, and the Agent
 * SDK is pointed at it (`pathToClaudeCodeExecutable`), so that both use the version, login and
 * settings the user already has. corrallm never ships or updates its own.
 */

const EXECUTABLE = process.platform === 'win32' ? 'claude.exe' : 'claude';

/**
 * Where `claude` is: the path in CORRALLM_CLAUDE_PATH if the user set one (then only that one:
 * tests point it at a fake, and must never find the user's own), else the native installer's
 * (~/.local/bin), else the first on the agents' PATH (`env`, the login shell's). Undefined if none
 * can run.
 */
export async function findClaude(
  env: Readonly<Record<string, string>>,
  {
    home = homedir(),
    override = process.env.CORRALLM_CLAUDE_PATH,
  }: { home?: string; override?: string | undefined } = {},
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
