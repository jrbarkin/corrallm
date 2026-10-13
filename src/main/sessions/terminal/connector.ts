import { realpath } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';

import type { UsageBackend, UsageWindows } from '../../../shared/usage';
import { claudeFlags, requireClaude } from '../claude';
import type { Connector, LiveSession, SessionHost, SessionSpec } from '../connector';
import { ClaudeCode } from './claude-code';
import { FirstRuns } from './first-run';
import { HOOK_TOKEN, HookServer } from './hooks';
import { spawnPty } from './pty';
import type { SpawnPty } from './pty';
import { TerminalSession, TIMING } from './session';
import type { TerminalTiming } from './session';

/*
 * The Terminal connection: a Claude agent runs Claude Code's own interactive CLI (the user's
 * `claude`, with their login, settings, hooks and MCP servers) in a pseudo-terminal, in the
 * canvas's project folder, and its agent view shows that terminal (session.ts, with Claude Code's
 * TerminalCli: claude-code.ts). Claude Code asks whether to trust a folder the first time it runs
 * there: its sessions in a folder take turns to start until one is past that (first-run.ts).
 */

/** Variables a terminal sets for the programs in it. */
const TERMINAL = { TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'corrallm' };

/**
 * The environment Claude Code runs in, in corrallm's terminal: the agents' (the user's login
 * shell's), as a terminal sets it up, with its hooks' token (hooks.ts). Claude Code reports its
 * status to the terminal unless told not to (CLAUDE_CODE_DISABLE_TERMINAL_TITLE); corrallm needs it.
 */
export function terminalEnvironment(
  env: Readonly<Record<string, string>>,
  token: string,
): Record<string, string> {
  const rest = Object.fromEntries(
    Object.entries(env).filter(([name]) => name !== 'CLAUDE_CODE_DISABLE_TERMINAL_TITLE'),
  );
  return {
    ...rest,
    ...TERMINAL,
    // Claude Code draws with Unicode: a terminal without a locale gets a UTF-8 one.
    ...(rest.LANG === undefined && rest.LC_ALL === undefined ? { LANG: 'en_US.UTF-8' } : {}),
    [HOOK_TOKEN]: token,
  };
}

export interface TerminalConnectorOptions {
  /** Starts the pseudo-terminal (node-pty; a fake in tests). */
  spawn?: SpawnPty;
  /** Finds the `claude` to run, in the agents' environment. */
  findClaude?: (env: Readonly<Record<string, string>>) => Promise<string>;
  /** The flags that `claude` takes (its --help's: claude.ts). */
  flags?: (claude: string, env: Readonly<Record<string, string>>) => Promise<ReadonlySet<string>>;
  /** Where sessions' settings files go. */
  tmp?: string;
  timing?: Partial<TerminalTiming>;
  /** The user's home folder. */
  home?: string;
  /** Takes the usage readings its sessions' status lines report (main's UsageReadings). */
  usage?: (backend: UsageBackend, windows: UsageWindows) => void;
}

export class TerminalConnector implements Connector {
  readonly #spawn: SpawnPty;
  readonly #findClaude: (env: Readonly<Record<string, string>>) => Promise<string>;
  readonly #flags: (
    claude: string,
    env: Readonly<Record<string, string>>,
  ) => Promise<ReadonlySet<string>>;
  readonly #tmp: string;
  readonly #timing: TerminalTiming;
  readonly #home: string;
  readonly #usage: ((backend: UsageBackend, windows: UsageWindows) => void) | undefined;
  /** The server every session's hooks post to (it runs while any session does). */
  readonly #hooks = new HookServer();
  /** Which session starts first in each folder, until the folder is trusted. */
  readonly #firstRuns = new FirstRuns();

  constructor({
    spawn = spawnPty,
    findClaude = (env) => requireClaude(env),
    flags = claudeFlags(),
    tmp = tmpdir(),
    timing = {},
    home = homedir(),
    usage,
  }: TerminalConnectorOptions = {}) {
    this.#spawn = spawn;
    this.#findClaude = findClaude;
    this.#flags = flags;
    this.#tmp = tmp;
    this.#timing = { ...TIMING, ...timing };
    this.#home = home;
    this.#usage = usage;
  }

  async start(spec: SessionSpec, host: SessionHost): Promise<LiveSession> {
    const claude = await this.#findClaude(spec.env);
    // An effort it was given, if its claude takes --effort (an older one would not start with it).
    const effort =
      spec.effort != null && (await this.#flags(claude, spec.env)).has('--effort')
        ? spec.effort
        : null;
    // Claude Code trusts a folder by its real path.
    const folder = await realpath(spec.cwd).catch(() => spec.cwd);
    const session = new TerminalSession(spec, host, {
      executable: claude,
      cli: new ClaudeCode({ cwd: spec.cwd, home: this.#home, env: spec.env, effort }),
      spawn: this.#spawn,
      hooks: this.#hooks,
      tmp: this.#tmp,
      env: (token) => terminalEnvironment(spec.env, token),
      timing: this.#timing,
      usage: (windows) => this.#usage?.('Claude', windows),
      firstRun: this.#firstRuns.take(folder),
    });
    await session.launch();
    return session;
  }
}
