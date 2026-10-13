import type { CodexMode } from '../../../../shared/session';
import type { Connector, LiveSession, SessionSpec } from '../../connector';
import { requireCodex } from '../codex';

/*
 * The Codex Terminal connection: a Codex agent runs Codex's own interactive CLI (the user's
 * `codex`, with its login, config.toml, AGENTS.md and MCP servers) in a pseudo-terminal, in the
 * canvas's project folder, and its agent view shows that terminal, as a Claude agent's Terminal
 * connection does.
 *
 * Not built yet: starting one finds `codex`, then says so. It is to run on the shared terminal
 * plumbing (src/main/sessions/terminal/: TerminalSession with a TerminalCli of Codex's own, which
 * says how to launch and resume it, read its state from its window title and hooks, and type
 * into it), in this folder.
 */

export interface CodexTerminalConnectorOptions {
  /** Finds the `codex` to run, in the agents' environment. */
  findCodex?: (env: Readonly<Record<string, string>>) => Promise<string>;
}

export class CodexTerminalConnector implements Connector<CodexMode> {
  readonly #findCodex: (env: Readonly<Record<string, string>>) => Promise<string>;

  constructor({ findCodex = (env) => requireCodex(env) }: CodexTerminalConnectorOptions = {}) {
    this.#findCodex = findCodex;
  }

  async start(spec: SessionSpec<CodexMode>): Promise<LiveSession<CodexMode>> {
    await this.#findCodex(spec.env);
    throw new Error("corrallm can't run Codex in a terminal yet.");
  }
}
