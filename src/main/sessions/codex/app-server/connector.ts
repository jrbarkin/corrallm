import type { CodexMode } from '../../../../shared/session';
import type { Connector, LiveSession, SessionSpec } from '../../connector';
import { requireCodex } from '../codex';

/*
 * The App Server connection: a Codex agent runs as a real Codex thread, through `codex app-server`
 * (JSON-RPC over stdio; ../rpc.ts), shown in corrallm's own transcript and composer, as a Claude
 * agent's Agent SDK connection is.
 *
 * Not built yet: starting one finds `codex`, then says so. It is to start the user's own `codex`
 * (../codex.ts) as an app server (../rpc.ts: startAppServer) in the project folder, refuse a
 * ChatGPT login (../login.ts: appServerRefusal), and turn its threads' notifications into session
 * events, in this folder.
 */

export interface AppServerConnectorDeps {
  /** What Codex is told runs it ("corrallm/0.1.0"). */
  clientApp: string;
  /** Finds the `codex` to run, in the agents' environment. */
  findCodex?: (env: Readonly<Record<string, string>>) => Promise<string>;
}

export class AppServerConnector implements Connector<CodexMode> {
  readonly #findCodex: (env: Readonly<Record<string, string>>) => Promise<string>;

  constructor({ findCodex = (env) => requireCodex(env) }: AppServerConnectorDeps) {
    this.#findCodex = findCodex;
  }

  async start(spec: SessionSpec<CodexMode>): Promise<LiveSession<CodexMode>> {
    await this.#findCodex(spec.env);
    throw new Error("corrallm can't run Codex through its app server yet.");
  }
}
