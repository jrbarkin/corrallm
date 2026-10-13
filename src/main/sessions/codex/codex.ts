import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { canRun, findExecutable, searchPath } from '../executables';

/*
 * The `codex` executable both Codex connections run: Terminal runs its interactive CLI in a pty,
 * and App Server runs `codex app-server`, so that both use the version, login (~/.codex) and
 * settings (config.toml, AGENTS.md, MCP servers) the user already has. corrallm never ships or
 * updates its own, and talks to it only over its own interfaces: a terminal, or JSON-RPC.
 */

/**
 * The oldest Codex corrallm runs: the one it was built against (its app server's protocol, its
 * terminal's titles and hooks were read from 0.160.1).
 */
export const MIN_CODEX_VERSION = '0.160.0';

export interface FindCodexOptions {
  home?: string;
  /** A path the user set (CORRALLM_CODEX_PATH): the only one tried, if set. */
  override?: string | undefined;
  platform?: NodeJS.Platform;
}

/**
 * Where `codex` is: the path in CORRALLM_CODEX_PATH if the user set one (then only that one: tests
 * point it at a fake, and must never find the user's own), else the standalone installer's (~/.local/bin, a link into ~/.codex/packages), else the first on the agents' PATH
 * (`env`, the login shell's: Homebrew's, npm's). On Windows, npm installs a `codex.cmd` launcher,
 * which cannot run without a shell: the native `codex.exe` it would start is run instead.
 * Undefined if none can run.
 */
export async function findCodex(
  env: Readonly<Record<string, string>>,
  {
    home = homedir(),
    override = process.env.CORRALLM_CODEX_PATH,
    platform = process.platform,
  }: FindCodexOptions = {},
): Promise<string | undefined> {
  if (override) return (await canRun(override)) ? override : undefined;
  const executable = platform === 'win32' ? 'codex.exe' : 'codex';
  const found = await findExecutable(executable, env, [
    path.join(home, '.local', 'bin', executable),
  ]);
  if (found !== undefined || platform !== 'win32') return found;
  for (const folder of searchPath(env)) {
    if (!(await canRun(path.join(folder, 'codex.cmd')))) continue;
    const native = await npmNative(folder);
    if (native !== undefined) return native;
  }
  return undefined;
}

/** Where `codex` is (see `findCodex`); rejects, saying how to install it, if there is none. */
export async function requireCodex(
  env: Readonly<Record<string, string>>,
  options?: FindCodexOptions,
): Promise<string> {
  const found = await findCodex(env, options);
  if (found === undefined) {
    throw new Error(
      "Codex isn't installed, or corrallm can't find it. Install the Codex CLI " +
        '(https://developers.openai.com/codex/cli), log in by running `codex login` in a terminal, ' +
        'then try again.',
    );
  }
  return found;
}

/** The version in what `codex --version` prints ("codex-cli 0.160.1"). */
export function parseVersion(output: string): string | undefined {
  return /codex-cli\s+(\d+\.\d+\.\d+\S*)/.exec(output)?.[1];
}

/** Why a Codex of `version` is too old for corrallm, or undefined if it is not. */
export function checkVersion(version: string): string | undefined {
  const parts = (value: string) => value.split(/[.-]/).slice(0, 3).map(Number);
  const have = parts(version);
  const need = parts(MIN_CODEX_VERSION);
  for (let i = 0; i < need.length; i += 1) {
    const a = have[i] ?? 0;
    const b = need[i] ?? 0;
    if (a !== b) {
      return a > b
        ? undefined
        : `This is Codex ${version}; corrallm needs Codex ${MIN_CODEX_VERSION} or later. Update Codex, then try again.`;
    }
  }
  return undefined;
}

/** How long `codex --version` may take. */
const VERSION_MS = 10_000;

/** The version of the Codex at `codex` (what `codex --version` says), in the agents' environment. */
export function codexVersion(
  codex: string,
  env: Readonly<Record<string, string>>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(codex, ['--version'], { env, timeout: VERSION_MS }, (error, stdout) => {
      const version = error ? undefined : parseVersion(stdout);
      if (version === undefined) {
        reject(new Error(`Could not tell which version of Codex ${codex} is.`, { cause: error }));
      } else resolve(version);
    });
  });
}

/**
 * The native `codex.exe` npm installed beside a `codex.cmd` launcher in `folder` (npm's global
 * folder): in its platform's package, inside the @openai/codex package or beside it.
 */
async function npmNative(folder: string): Promise<string | undefined> {
  const scopes = [
    path.join(folder, 'node_modules', '@openai', 'codex', 'node_modules', '@openai'),
    path.join(folder, 'node_modules', '@openai'),
  ];
  for (const scope of scopes) {
    for (const pkg of await names(scope)) {
      if (!pkg.startsWith('codex')) continue;
      const vendor = path.join(scope, pkg, 'vendor');
      for (const triple of await names(vendor)) {
        const exe = path.join(vendor, triple, 'codex', 'codex.exe');
        if (await canRun(exe)) return exe;
      }
    }
  }
  return undefined;
}

/** The names in a folder, or none if it cannot be read. */
async function names(folder: string): Promise<string[]> {
  return readdir(folder).catch(() => []);
}
