import { homedir, tmpdir } from 'node:os';

import { requireClaude } from '../claude';
import type { Connector, LiveSession, SessionHost, SessionSpec } from '../connector';
import { HOOK_TOKEN, HookServer } from './hooks';
import { spawnPty } from './pty';
import type { SpawnPty } from './pty';
import { TerminalSession, TIMING } from './session';
import type { TerminalTiming } from './session';

/*
 * The Terminal connection: a Claude agent runs Claude Code's own interactive CLI (the user's
 * `claude`, with their login, settings, hooks and MCP servers) in a pseudo-terminal, in the
 * canvas's project folder, and its agent view shows that terminal (session.ts).
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
  /** Where sessions' settings files go. */
  tmp?: string;
  timing?: Partial<TerminalTiming>;
  /** The user's home folder. */
  home?: string;
}

export class TerminalConnector implements Connector {
  readonly #spawn: SpawnPty;
  readonly #findClaude: (env: Readonly<Record<string, string>>) => Promise<string>;
  readonly #tmp: string;
  readonly #timing: TerminalTiming;
  readonly #home: string;
  /** The server every session's hooks post to (it runs while any session does). */
  readonly #hooks = new HookServer();

  constructor({
    spawn = spawnPty,
    findClaude = (env) => requireClaude(env),
    tmp = tmpdir(),
    timing = {},
    home = homedir(),
  }: TerminalConnectorOptions = {}) {
    this.#spawn = spawn;
    this.#findClaude = findClaude;
    this.#tmp = tmp;
    this.#timing = { ...TIMING, ...timing };
    this.#home = home;
  }

  async start(spec: SessionSpec, host: SessionHost): Promise<LiveSession> {
    const claude = await this.#findClaude(spec.env);
    const session = new TerminalSession(spec, host, {
      claude,
      spawn: this.#spawn,
      hooks: this.#hooks,
      tmp: this.#tmp,
      env: (token) => terminalEnvironment(spec.env, token),
      timing: this.#timing,
      home: this.#home,
    });
    await session.launch();
    return session;
  }
}
