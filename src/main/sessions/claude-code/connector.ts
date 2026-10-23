import { realpath } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';

import type { UsageBackendId } from '../../../shared/adapter';
import type { UsageWindows } from '../../../shared/usage';
import { CLAUDE_USAGE } from './adapter';
import { claudeFlags } from './claude';
import type { Connector, LiveSession, SessionHost, SessionSpec } from '../connector';
import { ClaudeCode } from './claude-code';
import { FirstRuns } from './first-run';
import { HookServer } from '../terminal/hooks';
import { spawnPty } from '../terminal/pty';
import type { SpawnPty } from '../terminal/pty';
import { TerminalSession, TIMING } from '../terminal/session';
import type { TerminalTiming } from '../terminal/session';

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
 * shell's), as a terminal sets it up. Claude Code reports its
 * status to the terminal unless told not to (CLAUDE_CODE_DISABLE_TERMINAL_TITLE); corrallm needs it.
 */
export function terminalEnvironment(env: Readonly<Record<string, string>>): Record<string, string> {
  const rest = Object.fromEntries(
    Object.entries(env).filter(([name]) => name !== 'CLAUDE_CODE_DISABLE_TERMINAL_TITLE'),
  );
  return {
    ...rest,
    ...TERMINAL,
    // Claude Code draws with Unicode: a terminal without a locale gets a UTF-8 one.
    ...(rest.LANG === undefined && rest.LC_ALL === undefined ? { LANG: 'en_US.UTF-8' } : {}),
  };
}

export interface TerminalConnectorOptions {
  /** Starts the pseudo-terminal (node-pty; a fake in tests). */
  spawn?: SpawnPty;
  /** Finds the `claude` to run, in the agents' environment. */
  findClaude: (env: Readonly<Record<string, string>>) => Promise<string>;
  /** The flags that `claude` takes (its --help's: claude.ts). */
  flags?: (claude: string, env: Readonly<Record<string, string>>) => Promise<ReadonlySet<string>>;
  /** Where sessions' settings files go. */
  tmp?: string;
  timing?: Partial<TerminalTiming>;
  /** The user's home folder. */
  home?: string;
  /** Takes the usage readings its sessions' status lines report (main's UsageReadings). */
  usage?: (backend: UsageBackendId, windows: UsageWindows) => void;
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
  readonly #usage: ((backend: UsageBackendId, windows: UsageWindows) => void) | undefined;
  /** The server every session's hooks post to (it runs while any session does). */
  readonly #hooks = new HookServer();
  /** Which session starts first in each folder, until the folder is trusted. */
  readonly #firstRuns = new FirstRuns();

  constructor({
    spawn = spawnPty,
    findClaude,
    flags = claudeFlags(),
    tmp = tmpdir(),
    timing = {},
    home = homedir(),
    usage,
  }: TerminalConnectorOptions) {
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
    // Older CLIs predate prompt snapshots; never give them a flag they cannot parse.
    const roleChanged = spec.resume !== null && spec.roleChanged === true;
    const needsPromptOptions = spec.role !== undefined || roleChanged;
    const flags =
      needsPromptOptions || spec.effort != null
        ? await this.#flags(claude, spec.env)
        : new Set<string>();
    if (needsPromptOptions && flags.size === 0) {
      throw new Error('Could not read Claude Code options; retry or update Claude Code.');
    }
    if (spec.role !== undefined && !flags.has('--append-system-prompt')) {
      throw new Error('Update Claude Code to use an agent role.');
    }
    const effort = spec.effort != null && flags.has('--effort') ? spec.effort : null;
    // Claude Code trusts a folder by its real path.
    const folder = await realpath(spec.cwd).catch(() => spec.cwd);
    const session = new TerminalSession(spec, host, {
      executable: claude,
      cli: new ClaudeCode({
        cwd: spec.cwd,
        home: this.#home,
        env: spec.env,
        effort,
        resetPromptSnapshot: roleChanged && flags.has('--system-prompt-snapshot'),
      }),
      spawn: this.#spawn,
      hooks: this.#hooks,
      tmp: this.#tmp,
      env: () => terminalEnvironment(spec.env),
      timing: this.#timing,
      usage: (windows) => this.#usage?.(CLAUDE_USAGE, windows),
      firstRun: this.#firstRuns.take(folder),
    });
    await session.launch();
    return session;
  }
}
