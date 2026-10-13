import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/*
 * Claude Code's hooks, reporting to corrallm. A Terminal session's CLI is started with settings
 * (`hookSettings`) that add HTTP hooks to the user's own: on the events corrallm follows, Claude
 * Code posts the event (JSON) to a server main runs on 127.0.0.1, with a bearer token only that
 * session's process has (in its environment, HOOK_TOKEN). The hooks tell what the screen does not:
 * the session's id (which changes with /clear), the prompts typed into the terminal, the last
 * reply, why a turn failed, the permission mode and the model. corrallm only listens: it answers
 * every hook with no decision, so the CLI behaves as it would without them.
 */

/** The variable in a session's environment that holds its hooks' token. */
export const HOOK_TOKEN = 'CORRALLM_HOOK_TOKEN';
/** The events corrallm hears. (HTTP hooks cannot run on SessionStart.) */
export const HOOK_EVENTS = [
  'UserPromptSubmit',
  'Stop',
  'StopFailure',
  'SessionEnd',
  'PostModelSwitch',
] as const;
/** The largest hook event read, in bytes: a prompt or a reply can be long. */
const MAX_BODY = 4 * 1024 * 1024;
/** How long Claude Code waits for corrallm's answer, in seconds; it answers at once. */
const TIMEOUT_S = 5;

/** A hook event, as Claude Code posts it: JSON, untrusted (never act on it beyond reading). */
export type HookEvent = Readonly<Record<string, unknown>>;

/**
 * The settings (for `claude --settings <file>`) that add corrallm's hooks: each event posted to
 * `url`, with the token from the session's environment. Claude Code merges them with the user's
 * and the project's hooks.
 */
export function hookSettings(url: string): { hooks: Record<string, unknown[]> } {
  const hook = {
    type: 'http',
    url,
    headers: { Authorization: `Bearer $${HOOK_TOKEN}` },
    allowedEnvVars: [HOOK_TOKEN],
    timeout: TIMEOUT_S,
  };
  return { hooks: Object.fromEntries(HOOK_EVENTS.map((name) => [name, [{ hooks: [hook] }]])) };
}

/** A session's place on the server: where its hooks post, and with what token. */
export interface HookRegistration {
  url: string;
  /** Where its status line posts its input (statusline.ts), with the same token. */
  statusUrl: string;
  token: string;
  /** Stops hearing its hooks. */
  release(): void;
}

/**
 * The server hooks post to, shared by every Terminal session: it runs while any session is
 * registered, and routes each event to the session whose token it carries.
 */
export class HookServer {
  readonly #listeners = new Map<string, (event: HookEvent) => void>();
  /** What hears each session's status line input (at /status), by token. */
  readonly #statusListeners = new Map<string, (input: HookEvent) => void>();
  #server: Promise<{ server: Server; url: string }> | undefined;

  /**
   * Starts hearing a session's hooks: `listener` hears each event its CLI posts, and `status` (if
   * given) each status line input its CLI's status line posts (statusline.ts).
   */
  async register(
    listener: (event: HookEvent) => void,
    status?: (input: HookEvent) => void,
  ): Promise<HookRegistration> {
    const token = randomBytes(24).toString('hex');
    this.#listeners.set(token, listener);
    if (status) this.#statusListeners.set(token, status);
    const forget = () => {
      this.#listeners.delete(token);
      this.#statusListeners.delete(token);
    };
    try {
      const { url } = await (this.#server ??= this.#listen());
      return {
        url,
        statusUrl: url.replace(/\/hook$/, '/status'),
        token,
        release: () => {
          forget();
          if (this.#listeners.size === 0) this.#close();
        },
      };
    } catch (error) {
      forget();
      throw error;
    }
  }

  #listen(): Promise<{ server: Server; url: string }> {
    const server = createServer((request, response) => {
      this.#receive(request, response);
    });
    const listening = new Promise<{ server: Server; url: string }>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as AddressInfo;
        resolve({ server, url: `http://127.0.0.1:${String(port)}/hook` });
      });
    });
    listening.catch(() => {
      this.#server = undefined;
    });
    return listening;
  }

  #close(): void {
    const closing = this.#server;
    this.#server = undefined;
    void closing?.then(({ server }) => {
      server.close();
      server.closeAllConnections();
    });
  }

  #receive(request: IncomingMessage, response: ServerResponse): void {
    const reply = (status: number) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(status === 200 ? '{}' : '');
    };
    const token = /^Bearer ([0-9a-f]+)$/.exec(request.headers.authorization ?? '')?.[1];
    const known = token !== undefined && this.#listeners.has(token);
    const route = request.url === '/hook' || request.url === '/status' ? request.url : undefined;
    // A session's status line input goes to its status listener, if it has one; else nowhere.
    const listener =
      token === undefined
        ? undefined
        : route === '/status'
          ? (this.#statusListeners.get(token) ?? (() => undefined))
          : this.#listeners.get(token);
    if (request.method !== 'POST' || route === undefined || !known || listener === undefined) {
      request.resume();
      reply(request.method === 'POST' && route !== undefined ? 401 : 404);
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reply(413);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (size > MAX_BODY) return;
      // Answered first: Claude Code waits for the answer before it goes on.
      reply(200);
      let event: unknown;
      try {
        event = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return;
      }
      if (typeof event === 'object' && event !== null && !Array.isArray(event)) {
        listener(event as HookEvent);
      }
    });
  }
}
