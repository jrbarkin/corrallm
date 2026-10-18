import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import type { CodexMode } from '../../../../shared/session';
import type { UsageBackendId } from '../../../../shared/adapter';
import type { UsageWindows } from '../../../../shared/usage';
import { CODEX_USAGE } from '../adapter';
import type { Connector, LiveSession, SessionHost, SessionSpec } from '../../connector';
import { HOOK_TOKEN, HookServer } from '../../terminal/hooks';
import { spawnPty } from '../../terminal/pty';
import type { SpawnPty } from '../../terminal/pty';
import { TerminalSession, TIMING } from '../../terminal/session';
import type { TerminalTiming } from '../../terminal/session';
import { appendRole } from '../app-server/instructions';
import { checkVersion, codexVersion, requireCodex } from '../codex';
import { nativeDeveloperInstructions } from './instructions';
import type { InstructionsContext } from './instructions';
import { HookTruster } from './trust';
import { CodexTui } from './tui';
import { UsageReader } from './usage';

/*
 * The Codex Terminal connection: a Codex agent runs Codex's own interactive CLI (the user's
 * `codex`, with its login, config.toml, AGENTS.md, skills and MCP servers) in a pseudo-terminal,
 * in the canvas's project folder, and its agent view shows that terminal, as a Claude agent's
 * Terminal connection does: the shared Terminal session (sessions/terminal/session.ts) with
 * Codex's TerminalCli (tui.ts). Everything Codex does is there, as the user knows it; corrallm
 * follows its turns by its window title and hooks, and types the queue's messages into it. Its
 * usage limits are read apart from it, from a private app server (usage.ts), as it starts and
 * after each turn.
 */

/** Variables a terminal sets for the programs in it (Codex reads no TERM_PROGRAM of its own). */
const TERMINAL = { TERM: 'xterm-256color', COLORTERM: 'truecolor' };
/**
 * What Codex sets for the commands it runs, which a Codex in corrallm's terminal must not take
 * for its own (it would take itself for a command another Codex runs).
 */
const CODEX_COMMAND_VARIABLES = [
  'CODEX_THREAD_ID',
  'CODEX_SANDBOX',
  'CODEX_SANDBOX_NETWORK_DISABLED',
];

/**
 * How long things take for Codex (session.ts's TerminalTiming): Enter a while after a paste (its
 * composer takes keys that come right after one as part of it), and more time to show its
 * composer at first (it loads its config, then its MCP servers) before a message waiting for it
 * waits on the user.
 */
export const CODEX_TIMING: Partial<TerminalTiming> = { enter: 200, startup: 8000 };

/**
 * The environment Codex runs in, in corrallm's terminal: the agents' (the user's login shell's),
 * as a terminal sets it up, with its hooks' token (hooks.ts).
 */
export function codexEnvironment(
  env: Readonly<Record<string, string>>,
  token: string,
): Record<string, string> {
  const rest = Object.fromEntries(
    Object.entries(env).filter(([name]) => !CODEX_COMMAND_VARIABLES.includes(name)),
  );
  return {
    ...rest,
    ...TERMINAL,
    // Codex draws with Unicode: a terminal without a locale gets a UTF-8 one.
    ...(rest.LANG === undefined && rest.LC_ALL === undefined ? { LANG: 'en_US.UTF-8' } : {}),
    [HOOK_TOKEN]: token,
  };
}

export interface CodexTerminalConnectorOptions {
  /** Starts the pseudo-terminal (node-pty; a fake in tests). */
  spawn?: SpawnPty;
  /** Finds the `codex` to run, in the agents' environment. */
  findCodex?: (env: Readonly<Record<string, string>>) => Promise<string>;
  /** Says which version a `codex` is. */
  version?: (codex: string, env: Readonly<Record<string, string>>) => Promise<string>;
  /** Trusts sessions' hooks (asking Codex itself once per version). */
  truster?: HookTruster;
  /** Reads Codex's usage limits for its sessions (a private app server). */
  reader?: UsageReader;
  /** Takes the usage readings its sessions report (main's UsageReadings). */
  usage?: (backend: UsageBackendId, windows: UsageWindows) => void;
  /** Reads effective native developer instructions without starting a thread. */
  readInstructions?: (context: InstructionsContext) => Promise<string | undefined>;
  /** Where sessions' own folders go. */
  tmp?: string;
  timing?: Partial<TerminalTiming>;
  platform?: NodeJS.Platform;
}

export class CodexTerminalConnector implements Connector<CodexMode> {
  readonly #spawn: SpawnPty;
  readonly #findCodex: (env: Readonly<Record<string, string>>) => Promise<string>;
  readonly #version: (codex: string, env: Readonly<Record<string, string>>) => Promise<string>;
  readonly #truster: HookTruster;
  readonly #reader: UsageReader;
  readonly #usage: ((backend: UsageBackendId, windows: UsageWindows) => void) | undefined;
  readonly #readInstructions: (context: InstructionsContext) => Promise<string | undefined>;
  readonly #tmp: string;
  readonly #timing: TerminalTiming;
  readonly #platform: NodeJS.Platform;
  /** The server every session's hooks post to (it runs while any session does). */
  readonly #hooks = new HookServer();

  constructor({
    spawn = spawnPty,
    findCodex = (env) => requireCodex(env),
    version = codexVersion,
    truster = new HookTruster(),
    reader = new UsageReader(),
    usage,
    readInstructions = nativeDeveloperInstructions,
    tmp = tmpdir(),
    timing = {},
    platform = process.platform,
  }: CodexTerminalConnectorOptions = {}) {
    this.#spawn = spawn;
    this.#findCodex = findCodex;
    this.#version = version;
    this.#truster = truster;
    this.#reader = reader;
    this.#usage = usage;
    this.#readInstructions = readInstructions;
    this.#tmp = tmp;
    this.#timing = { ...TIMING, ...CODEX_TIMING, ...timing };
    this.#platform = platform;
  }

  async start(spec: SessionSpec<CodexMode>, host: SessionHost): Promise<LiveSession<CodexMode>> {
    const codex = await this.#findCodex(spec.env);
    const version = await this.#version(codex, spec.env);
    const old = checkVersion(version);
    if (old !== undefined) throw new Error(old);
    // The folder as Codex resolves it, so that the folder it trusts is the one it works in.
    const cwd = await realpath(spec.cwd).catch(() => spec.cwd);
    // Native resume can retain old model-visible role context in Codex 0.162.1:
    // https://github.com/openai/codex/issues/19045 (role edits need a new conversation).
    const developerInstructions =
      spec.role !== undefined || (spec.resume !== null && spec.roleChanged === true)
        ? appendRole(await this.#readInstructions({ codex, cwd, env: spec.env }), spec.role)
        : undefined;
    const usage = this.#usage;
    const session = new TerminalSession<CodexMode>({ ...spec, cwd }, host, {
      executable: codex,
      cli: new CodexTui({
        trust: (hooks) => this.#truster.trust(hooks, { codex, version, cwd, env: spec.env }),
        effort: spec.effort ?? null,
        ...(developerInstructions === undefined ? {} : { developerInstructions }),
        platform: this.#platform,
        usage: () => this.#reader.read({ codex, cwd, env: spec.env }),
      }),
      spawn: this.#spawn,
      hooks: this.#hooks,
      tmp: this.#tmp,
      env: (token) => codexEnvironment(spec.env, token),
      timing: this.#timing,
      ...(usage === undefined
        ? {}
        : {
            usage: (windows: UsageWindows) => {
              usage(CODEX_USAGE, windows);
            },
          }),
    });
    await session.launch();
    return session;
  }
}
