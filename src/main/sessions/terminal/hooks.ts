import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { MAX_CANVAS_PROMPTS, MAX_SESSION_PROMPTS } from '../../../shared/api/limits';
import { foreignRequest, isJson } from '../../loopback';

/*
 * The local server terminal CLIs' hooks report to: JSON events, routed by the session's bearer
 * token (read from its private header file). A foreign Host or any Origin is refused before the
 * token (loopback.ts), and so is any media type but application/json (415): the recordings
 * (`hook-holds.jsonl` beside each adapter's fixtures) show both CLIs' hooks send it.
 *
 * It answers every event with no decision (`{}`, which both CLIs read as none) except one its
 * session holds (B23 C1): the body is parsed first, and a session that asks to hold the event is
 * handed a one-shot `HookHold` bound to that very request. The reply is written only by its
 * `answer`, its `release`, or the server's own deadline (`HELD_MS`); a request the CLI closes
 * ends the hold. A decision reaches the connection that raised it and no other; no body field
 * routes one, and nothing of a hold or its decision is logged. /status is never held.
 */

/** The old secret variable: stripped from every Terminal child's environment. */
export const HOOK_TOKEN = 'CORRALLM_HOOK_TOKEN';
/** Only this non-secret path is inherited by a CLI and the commands its hooks run. */
export const HOOK_HEADER = 'CORRALLM_HOOK_HEADER';
/** The largest hook event read, in bytes: a prompt or a reply can be long. */
const MAX_BODY = 4 * 1024 * 1024;
/**
 * How long the server holds a request before it releases it with no decision, in ms (B23 C3):
 * 10 s under the timeout each CLI is told, so a decision is never written as the CLI cuts it.
 */
export const HELD_MS = 20_000;
/** A hook event, as a CLI posts it: JSON, untrusted (never act on it beyond reading). */
export type HookEvent = Readonly<Record<string, unknown>>;

/** How a held request ended: the first of these to happen. */
export type HoldEnd = 'answered' | 'released' | 'deadline' | 'closed';

/**
 * A request a session holds, bound to its connection. Each of `answer` and `release` returns
 * false, writing nothing, once the request ended (answered, released, past its deadline, or closed
 * by the CLI).
 */
export interface HookHold {
  /** Writes 200 `application/json` with this body, and ends the request. */
  answer(body: unknown): boolean;
  /** Writes `{}` (no decision), and ends the request. */
  release(): boolean;
  /** How it ended, once it has. */
  readonly ended: HoldEnd | undefined;
  /** When it arrived, and when the server releases it, in epoch ms. */
  readonly received: number;
  readonly deadline: number;
  /** Calls `listener` once, with how it ended, when it does (at once if it already has). */
  onEnd(listener: (how: HoldEnd) => void): void;
}

/** What hears a session's hooks: each event, with the hold on its request where it asked for one. */
export type HookListener = (event: HookEvent, hold?: HookHold) => void;

/** A session's place on the server: where its hooks post, and with what token. */
export interface HookRegistration {
  url: string;
  /** Where its status line posts its input, with the same token. */
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
  readonly #listeners = new Map<string, HookListener>();
  /** Which events each session holds, by token. */
  readonly #holders = new Map<string, (event: HookEvent) => boolean>();
  /** The requests held now, by token. */
  readonly #held = new Map<string, Set<Hold>>();
  readonly #heldMs: number;
  /** What hears each session's status line input (at /status), by token. */
  readonly #statusListeners = new Map<string, (input: HookEvent) => void>();
  #server: Promise<{ server: Server; url: string }> | undefined;

  constructor(options: { heldMs?: number } = {}) {
    this.#heldMs = options.heldMs ?? HELD_MS;
  }

  /**
   * Starts hearing a session's hooks: `listener` hears each event its CLI posts, and `status` (if
   * given) each status line input its CLI's status line posts. `holds`, if given, says
   * synchronously from the event alone whether to hold its request: the listener is then handed
   * the hold, and nothing is written until it answers or releases it (or its deadline).
   */
  async register(
    listener: HookListener,
    status?: (input: HookEvent) => void,
    holds?: (event: HookEvent) => boolean,
  ): Promise<HookRegistration> {
    const token = randomBytes(24).toString('hex');
    this.#listeners.set(token, listener);
    if (status) this.#statusListeners.set(token, status);
    if (holds) this.#holders.set(token, holds);
    const forget = () => {
      // Everything it holds is released first, so no CLI waits on a session that is gone.
      for (const hold of [...(this.#held.get(token) ?? [])]) hold.release();
      this.#held.delete(token);
      this.#listeners.delete(token);
      this.#statusListeners.delete(token);
      this.#holders.delete(token);
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
    // Before the token: a page in a browser is refused as such (loopback.ts).
    if (foreignRequest(request) !== undefined) {
      request.resume();
      reply(403);
      return;
    }
    const route = request.url === '/hook' || request.url === '/status' ? request.url : undefined;
    if (request.method !== 'POST' || route === undefined) {
      request.resume();
      reply(404);
      return;
    }
    // Before the token too (B23 C6): only JSON is a hook's body.
    if (!isJson(request.headers['content-type'])) {
      request.resume();
      reply(415);
      return;
    }
    const token = /^Bearer ([0-9a-f]+)$/.exec(request.headers.authorization ?? '')?.[1];
    const known = token !== undefined && this.#listeners.has(token);
    // A session's status line input goes to its status listener, if it has one; else nowhere.
    const listener = !known
      ? undefined
      : route === '/status'
        ? (this.#statusListeners.get(token) ?? (() => undefined))
        : this.#listeners.get(token);
    if (!known || listener === undefined) {
      request.resume();
      reply(401);
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
      let event: unknown;
      try {
        event = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        reply(200);
        return;
      }
      if (typeof event !== 'object' || event === null || Array.isArray(event)) {
        reply(200);
        return;
      }
      const heard = event as HookEvent;
      const hold = route === '/hook' ? this.#hold(token, heard, response) : undefined;
      if (hold === undefined) {
        // Answered first: a CLI may wait for the answer before it goes on.
        reply(200);
        listener(heard);
      } else listener(heard, hold);
    });
  }

  /** Holds the request `response` answers, if its session asks to and the caps allow. */
  #hold(token: string, event: HookEvent, response: ServerResponse): HookHold | undefined {
    if (this.#holders.get(token)?.(event) !== true) return undefined;
    const mine = this.#held.get(token) ?? new Set<Hold>();
    let all = 0;
    for (const holds of this.#held.values()) all += holds.size;
    if (mine.size >= MAX_SESSION_PROMPTS || all >= MAX_CANVAS_PROMPTS) return undefined;
    const hold = new Hold(response, this.#heldMs, () => {
      mine.delete(hold);
      if (mine.size === 0) this.#held.delete(token);
    });
    mine.add(hold);
    this.#held.set(token, mine);
    return hold;
  }
}

/** One held request: written at most once, by whichever of the session, the deadline or the CLI comes first. */
class Hold implements HookHold {
  readonly received = Date.now();
  readonly deadline: number;
  #ended: HoldEnd | undefined;
  readonly #listeners: ((how: HoldEnd) => void)[] = [];
  readonly #response: ServerResponse;
  readonly #timer: ReturnType<typeof setTimeout>;
  readonly #done: () => void;

  constructor(response: ServerResponse, ms: number, done: () => void) {
    this.#response = response;
    this.#done = done;
    this.deadline = this.received + ms;
    this.#timer = setTimeout(() => {
      this.#write('deadline', '{}');
    }, ms);
    // The CLI closed the request (Esc, an interrupt, exiting) before anything was written.
    response.on('close', () => {
      if (this.#ended === undefined) this.#finish('closed');
    });
  }

  get ended(): HoldEnd | undefined {
    return this.#ended;
  }

  answer(body: unknown): boolean {
    let text: string | undefined;
    try {
      text = JSON.stringify(body);
    } catch {
      text = undefined;
    }
    return text === undefined ? false : this.#write('answered', text);
  }

  release(): boolean {
    return this.#write('released', '{}');
  }

  onEnd(listener: (how: HoldEnd) => void): void {
    if (this.#ended === undefined) this.#listeners.push(listener);
    else listener(this.#ended);
  }

  #write(how: HoldEnd, text: string): boolean {
    if (this.#ended !== undefined) return false;
    this.#finish(how);
    try {
      this.#response.writeHead(200, { 'Content-Type': 'application/json' });
      this.#response.end(text);
    } catch {
      /* The connection is gone: nothing to write. */
    }
    return true;
  }

  #finish(how: HoldEnd): void {
    this.#ended = how;
    clearTimeout(this.#timer);
    this.#done();
    for (const listener of this.#listeners.splice(0)) listener(how);
  }
}

/** Posts a native hook’s JSON stdin, never interpolating it into shell text. Quiet, bounded, no decision. */
export function postHookCommand(url: string, shell: 'posix' | 'cmd' = 'posix'): string {
  if (shell === 'cmd') {
    return (
      `curl.exe -s -o NUL --max-time 5 -X POST ` +
      `-H "@%${HOOK_HEADER}%" -H "Content-Type: application/json" ` +
      `--data-binary @- ${url} >NUL 2>&1 & exit /b 0`
    );
  }
  const post =
    `curl -s -o /dev/null --max-time 5 -X POST ` +
    `-H "@$${HOOK_HEADER}" -H "Content-Type: application/json" ` +
    `--data-binary @- ${url}`;
  return `/bin/sh -c 'if command -v curl >/dev/null 2>&1; then ${post}; else cat >/dev/null; fi; exit 0' >/dev/null 2>&1`;
}
