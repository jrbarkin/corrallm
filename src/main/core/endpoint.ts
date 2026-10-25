import type { ApiStatus } from '../../shared/api/ops/settings';
import { startApiServer } from '../api/mcp';
import type { ApiServer } from '../api/mcp';
import type { Settings } from '../settings';
import { removeOwnApiFile, writeApiFile } from './api-file';
import type { ApiFile } from './api-file';
import type { Dispatcher } from './call';
import type { TokenCaller } from './caller';
import { processStart } from './lock';
import type { ProcessStart } from './process-identity';

/*
 * The profile's outside endpoint (B11 Design §9, §16.6), for whichever process owns the profile:
 * the app's core, in its utility process beside its dispatcher (core/entry.ts), or `corrallm
 * serve` (cli/serve.ts). It is corrallm's MCP server on 127.0.0.1 (api/mcp.ts, with every check of
 * its own: Host, Origin, the body's type and size, a token on every request, read again once its
 * body has come, and everything else through core.call: audience, reach, rules) and its discovery
 * file, api.json (api-file.ts).
 *
 * It listens on the port it is given (kept for later starts, unless 0), else on the port the
 * profile keeps, else on one chosen free once and kept, so a core started again (after a crash,
 * a new process) listens where orchestrators registered it. A port taken is said, as its status
 * (EADDRINUSE), never swapped for another, which would take tokens at an address no one
 * registered. Once its owner admits it (everything that may refuse its start passed), it publishes
 * api.json, naming this process by its pid and verified start (the core's utility process, never
 * main), replacing whatever was there whole; it removes only the record it wrote, so an old owner's
 * late cleanup leaves a newer one's. Closing it ends every request going on, a long `wait`
 * included, before api.json goes. It makes no token and holds none (a person makes them, at a
 * terminal: `serve --new-token`, `corrallm token`), and nothing of it but its status reaches the
 * core's topics or HostServices.
 */

export interface EndpointDeps {
  /** The profile folder, where api.json is. */
  profile: string;
  /** The operations it serves. */
  core: Dispatcher;
  /** Who a bearer token belongs to: an agent's session or an outside token, or undefined. */
  clientOf: (token: string) => TokenCaller | undefined;
  /** Whether a token it doesn't take is one its store made that no longer works. */
  stale: (token: string) => boolean;
  /** Where the profile keeps its port. */
  settings: Pick<Settings, 'apiPort' | 'keepApiPort'>;
  /** Hears each change of its status. */
  changed?: (status: ApiStatus) => void;
  /** For tests: the process api.json names, instead of this one. */
  identity?: () => { pid: number; started: ProcessStart };
}

const CLOSED = 'corrallm’s MCP server has closed.';

/** The status said when the port corrallm keeps is another program's. */
export function portTaken(port: number): string {
  return `Port ${String(port)} is taken by another program, so corrallm’s MCP server isn’t listening: stop that program, then quit corrallm and open it again.`;
}

export class Endpoint {
  readonly #deps: EndpointDeps;
  #status: ApiStatus = { state: 'stopped', port: null };
  #server: ApiServer | undefined;
  #listening: Promise<ApiStatus> | undefined;
  /** api.json as it wrote it, until removed. */
  #published: ApiFile | undefined;
  #publishing: Promise<void> | undefined;
  #closing: Promise<void> | undefined;

  constructor(deps: EndpointDeps) {
    this.#deps = deps;
  }

  /** Whether it listens, and where, or why not. */
  get status(): ApiStatus {
    return this.#status;
  }

  /** Where it listens, if it does. */
  get url(): string | undefined {
    return this.#status.state === 'listening' ? this.#status.url : undefined;
  }

  /**
   * Listens on 127.0.0.1: on `port` if given (kept for later starts unless 0), else on the port
   * the profile keeps, else on one chosen free and kept. Resolves with its status: listening, or,
   * for a port another program has, unavailable (never another port). Rejects for any other
   * failure, still stopped. Once only.
   */
  listen(port?: number): Promise<ApiStatus> {
    if (this.#closing) return Promise.reject(new Error(CLOSED));
    this.#listening ??= this.#listen(port);
    return this.#listening;
  }

  async #listen(given: number | undefined): Promise<ApiStatus> {
    const { settings } = this.#deps;
    const kept = given === undefined ? await settings.apiPort() : undefined;
    const port = given ?? kept ?? 0;
    let server: ApiServer;
    try {
      server = await startApiServer({
        core: this.#deps.core,
        clientOf: this.#deps.clientOf,
        stale: this.#deps.stale,
        port,
      });
    } catch (error) {
      if ((error as { code?: unknown }).code !== 'EADDRINUSE') throw error;
      this.#set({ state: 'unavailable', port, sentence: portTaken(port) });
      return this.#status;
    }
    this.#server = server;
    if (this.#closing) {
      await server.close();
      throw new Error(CLOSED);
    }
    // A port given is kept, so a start without one (after a crash, say) listens there again.
    if (given === undefined ? kept === undefined : given !== 0) {
      await settings.keepApiPort(server.port);
    }
    this.#set({ state: 'listening', port: server.port, url: server.url });
    return this.#status;
  }

  /** It can't serve, for a reason of the owner's: said as its status. */
  refused(sentence: string): ApiStatus {
    if (this.#status.state !== 'listening') {
      this.#set({ state: 'unavailable', port: this.#status.port, sentence });
    }
    return this.#status;
  }

  /**
   * Publishes where it listens: api.json, 0600, naming this process, written whole. Rejects if it
   * isn't listening, has closed, or the file can't be written.
   */
  publish(): Promise<void> {
    const publishing = this.#publish();
    this.#publishing = publishing.catch(() => undefined);
    return publishing;
  }

  async #publish(): Promise<void> {
    if (this.#closing) throw new Error(CLOSED);
    const server = this.#server;
    if (!server) throw new Error('corrallm’s MCP server isn’t listening.');
    const { pid, started } = this.#deps.identity?.() ?? {
      pid: process.pid,
      started: processStart(),
    };
    const record: ApiFile = { url: server.url, port: server.port, pid, started };
    await writeApiFile(this.#deps.profile, record);
    this.#published = record;
  }

  /**
   * Closes: every request going on ends (a long wait included), the listener closes, and api.json
   * goes, if it is still the record it wrote (one being written goes once it is). Idempotent.
   */
  close(): Promise<void> {
    this.#closing ??= (async () => {
      try {
        await this.#listening?.catch(() => undefined);
        await this.#server?.close();
      } finally {
        await this.#publishing;
        this.removeSync();
        this.#set({ state: 'stopped', port: this.#status.port });
      }
    })();
    return this.#closing;
  }

  /** Removes api.json if it is still the record it wrote: synchronous, as the process exits. */
  removeSync(): void {
    const published = this.#published;
    if (published === undefined) return;
    this.#published = undefined;
    removeOwnApiFile(this.#deps.profile, published);
  }

  #set(status: ApiStatus): void {
    this.#status = status;
    try {
      this.#deps.changed?.(status);
    } catch (error) {
      console.error('Could not say how corrallm’s MCP server is:', error);
    }
  }
}
