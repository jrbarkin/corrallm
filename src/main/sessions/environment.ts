import { spawn } from './process';

/*
 * The environment agents run in. An app opened from the Finder or the Dock gets a bare PATH, so
 * an agent would miss what the user installed (Homebrew, nvm, `claude` itself) and so would its
 * shell commands, hooks and MCP servers. Agents get the environment the user's login shell sets
 * up instead, without what belongs to whatever started corrallm.
 */

/** Printed around the environment, so that whatever the user's shell profile prints is skipped. */
const MARK = '__CORRALLM_ENV__';
/** How long the login shell may take to start. */
const SHELL_MS = 10_000;

/**
 * Variables that belong to what started corrallm, not to the user: a Claude Code session (when
 * corrallm runs from one, as under `pnpm dev`), a terminal or IDE, or Electron. An agent started
 * with them would take itself for part of that.
 */
const INHERITED = new Set([
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_AGENT_SDK_VERSION',
  'TERM_SESSION_ID',
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',
  'TERM_FEATURES',
  'TERMINFO_DIRS',
  'NODE_OPTIONS',
]);
const INHERITED_PREFIXES = ['ITERM_', 'ELECTRON_', 'CORRALLM_'];

/** `env` without what agents must not inherit (see INHERITED), and without unset variables. */
export function agentEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        !INHERITED.has(entry[0]) &&
        !INHERITED_PREFIXES.some((prefix) => entry[0].startsWith(prefix)),
    ),
  );
}

/**
 * The environment the user's login shell sets up ($SHELL, run as a login and interactive shell),
 * or `env` itself where there is none (Windows) or it fails or takes too long.
 */
export async function loginShellEnvironment({
  env = process.env,
  platform = process.platform,
  timeoutMs = SHELL_MS,
}: {
  env?: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
} = {}): Promise<Record<string, string>> {
  const own = defined(env);
  if (platform === 'win32') return own;
  const shell = env.SHELL ?? (platform === 'darwin' ? '/bin/zsh' : '/bin/sh');
  try {
    const output = await run(
      shell,
      ['-ilc', `printf '%s' ${MARK}; env -0; printf '%s' ${MARK}`],
      // Keeps oh-my-zsh from asking to update.
      { ...own, DISABLE_AUTO_UPDATE: 'true' },
      timeoutMs,
    );
    return parseEnvironment(output) ?? own;
  } catch {
    return own;
  }
}

/** The variables `env -0` printed between the markers, or undefined if they are missing. */
export function parseEnvironment(output: string): Record<string, string> | undefined {
  const [, between] = output.split(MARK);
  if (between === undefined) return undefined;
  const env: Record<string, string> = {};
  for (const line of between.split('\0')) {
    const at = line.indexOf('=');
    if (at > 0) env[line.slice(0, at)] = line.slice(at + 1);
  }
  return env;
}

function defined(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

/** Runs `command` with `args` (no input), resolving with what it printed, if it exits cleanly. */
function run(
  command: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${command} took longer than ${String(timeoutMs)}ms`));
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(chunks).toString('utf8'));
      else reject(new Error(`${command} exited with ${String(code)}`));
    });
  });
}
