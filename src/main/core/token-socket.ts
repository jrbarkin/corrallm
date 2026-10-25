import { lstatSync, rmSync } from 'node:fs';
import { chmod, lstat, rm } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import type { Socket } from 'node:net';
import path from 'node:path';

import { z } from 'zod';

import { ID_PATTERN } from '../../shared/adapter';
import { MAX_TOKEN_CANVASES, MAX_TOKEN_HOURS } from '../../shared/api/limits';
import { isCanvasId } from '../../shared/canvas';
import { privateTokenProfile } from './token-profile';

/*
 * The token socket (Build Plan B30; Core Server §6.7, D7): how `corrallm token new|renew|revoke`
 * asks whichever corrallm owns a profile (the app's core, or `corrallm serve`: core.lock says
 * which) to make, renew or revoke an outside token while it runs, never over MCP, which tokens
 * call. It is a Unix domain socket, <profile>/token.sock, that only the profile's user can open:
 * the owner binds it under a umask that leaves it the user's alone, sets it 0600 and checks it is,
 * in a profile folder that is the user's and no one else may write to (so no one else can put
 * something in its place), and the OS checks write permission on it at every connect (Linux and
 * macOS both do). Node can't read a socket peer's credentials, so that permission is the check: a
 * local process of the same user can open it, as it could read the profile; no token is ever
 * asked for or accepted on it, so it is no token's path. A socket left behind by an owner that
 * died is replaced by the next (which holds core.lock); anything else in its place is left alone,
 * and the socket isn't served. The client asks only a socket that is its user's alone, in such a
 * folder, never a link, so another user can't stand in for the owner.
 *
 * One request a connection: the client writes one line of JSON (a TokenRequest, at most
 * MAX_LINE bytes), the owner answers one line (a TokenAnswer) and ends it. Canvases are named by
 * their files, absolute, which the owner looks up in canvas memory as `serve --canvas` does: no
 * path is trusted for it. Windows, whose equivalent would be a named pipe only the user can open,
 * is held with Windows: neither side tries one there yet, and both say so.
 */

export const TOKEN_SOCKET = 'token.sock';
/** The most bytes a request or an answer holds, as a line. */
const MAX_LINE = 64 * 1024;
/** How long a client may take to send its request. */
const REQUEST_MS = 10 * 1000;
/** How long a client waits for its answer, by default. */
const ANSWER_MS = 60 * 1000;
/** The longest socket path each platform binds, in bytes, its terminating NUL left out. */
const MAX_PATH_BYTES = (platform: NodeJS.Platform) => (platform === 'linux' ? 107 : 103);
/** Permission bits for anyone but the user, and for writing by anyone but the user. */
const OTHERS = 0o077;

const WINDOWS =
  'corrallm token can’t reach the profile’s owner on Windows yet: that needs a named pipe only you can open, which is held with Windows.';

const Name = z.string().regex(ID_PATTERN);
const Hours = z.number().int().min(1).max(MAX_TOKEN_HOURS);
const Access = z.enum(['read', 'write']);
/** A canvas file, as the client resolved it: absolute, with no NUL. */
const CanvasFile = z
  .string()
  .min(1)
  .max(4096)
  .refine((file) => path.isAbsolute(file) && !file.includes('\0'));

const TokenRequestSchema = z.discriminatedUnion('op', [
  z.strictObject({
    version: z.literal(1),
    op: z.literal('new'),
    name: Name,
    hours: Hours,
    access: Access,
    canvases: z.array(CanvasFile).min(1).max(MAX_TOKEN_CANVASES),
  }),
  z.strictObject({ version: z.literal(1), op: z.literal('renew'), name: Name, hours: Hours }),
  z.strictObject({ version: z.literal(1), op: z.literal('revoke'), name: Name }),
]);

const Owner = z.enum(['app', 'serve', 'none']);

const TokenAnswerSchema = z.union([
  z.strictObject({
    ok: z.literal(true),
    owner: Owner,
    op: z.enum(['new', 'renew']),
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    name: Name,
    access: Access,
    expires: z.number().int(),
    canvases: z
      .array(
        z.strictObject({
          id: z.string().refine(isCanvasId),
          file: z.string().max(4096).optional(),
        }),
      )
      .min(1)
      .max(MAX_TOKEN_CANVASES),
    url: z.string().max(2048).nullable(),
    /** Why the owner's MCP server doesn't listen (its port taken), with no URL. */
    unserved: z.string().min(1).max(1000).optional(),
  }),
  z.strictObject({ ok: z.literal(true), owner: Owner, op: z.literal('revoke'), name: Name }),
  z.strictObject({ ok: z.literal(false), sentence: z.string().max(4000) }),
]);

/** What `corrallm token` asks the profile's owner. */
export type TokenRequest = z.infer<typeof TokenRequestSchema>;
/** What the owner answers: a token made or renewed, one revoked, or why not. */
export type TokenAnswer = z.infer<typeof TokenAnswerSchema>;
/** Who answered: the app's core, `corrallm serve`, or none (`corrallm token` itself). */
export type TokenOwner = z.infer<typeof Owner>;

/** The socket can't be served, or asked, here: why. */
export class TokenSocketUnavailable extends Error {
  constructor(sentence: string) {
    super(sentence);
    this.name = 'TokenSocketUnavailable';
  }
}

/** The owner's end of the socket, until it closes. */
export interface TokenSocket {
  readonly path: string;
  /** Stops serving, removing the socket. */
  close(): Promise<void>;
  /** Removes the socket, if it is still this one: synchronous, as the process exits. */
  removeSync(): void;
}

/** Where the socket of `profile` is, if it can be one: rejects with why not. */
function socketPath(profile: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') throw new TokenSocketUnavailable(WINDOWS);
  const at = path.join(path.resolve(profile), TOKEN_SOCKET);
  const most = MAX_PATH_BYTES(platform);
  if (Buffer.byteLength(at) > most) {
    throw new TokenSocketUnavailable(
      `The profile’s path is too long for its token socket (${at} is over ${String(most)} bytes): use a profile with a shorter path.`,
    );
  }
  return at;
}

/** Checks the profile folder is the user's, and no one else may write to it: rejects with why. */
async function checkFolder(profile: string): Promise<string> {
  try {
    return await privateTokenProfile(profile);
  } catch (error) {
    // Keep missing-path codes: a client then knows there is no owner to ask.
    if (isCode(error, 'ENOENT') || isCode(error, 'ENOTDIR')) throw error;
    throw new TokenSocketUnavailable(error instanceof Error ? error.message : String(error));
  }
}

/** Whether `stats` is a socket only this user may open. */
function usersAlone(stats: Stats): boolean {
  return stats.isSocket() && stats.uid === process.getuid?.() && (stats.mode & OTHERS) === 0;
}

/**
 * Serves `profile`'s token socket, answering each request with `answer` (its owner: the app's
 * core or `corrallm serve`, which holds core.lock). Rejects with TokenSocketUnavailable if it
 * can't be served safely here (on Windows, a path too long, a folder others may write to,
 * something other than a socket in its place), saying why.
 */
export async function serveTokenSocket({
  profile,
  answer,
  platform = process.platform,
}: {
  profile: string;
  answer: (request: TokenRequest) => Promise<TokenAnswer>;
  platform?: NodeJS.Platform;
}): Promise<TokenSocket> {
  const at = socketPath(await checkFolder(path.dirname(socketPath(profile, platform))), platform);
  const found = await lstat(at).catch((error: unknown) => {
    if (isCode(error, 'ENOENT')) return undefined;
    throw error;
  });
  if (found !== undefined) {
    // Holding core.lock, no live owner serves it: a socket there was left behind.
    if (!found.isSocket()) {
      throw new TokenSocketUnavailable(
        `${at} is in the way of corrallm’s token socket, and isn’t one: remove it.`,
      );
    }
    await rm(at, { force: true });
  }

  /** Each connection open, and whether its request is being answered. */
  const connections = new Map<Socket, { busy: boolean }>();
  const server = createServer((socket) => {
    const state = { busy: false };
    connections.set(socket, state);
    socket.once('close', () => {
      connections.delete(socket);
    });
    serveOne(socket, answer, state);
  });
  server.maxConnections = 8;
  const listening = new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', () => {
      server.off('error', reject);
      resolve();
    });
  });
  // Bound under this umask (listen binds before it returns), the socket is the user's alone from
  // the moment it exists. Files made meanwhile elsewhere in the process are only more private.
  const umask = process.umask(OTHERS);
  try {
    server.listen(at);
  } finally {
    process.umask(umask);
  }
  await listening;
  let ino: number | undefined;
  try {
    await chmod(at, 0o600);
    const bound = await lstat(at);
    if (!usersAlone(bound)) {
      throw new TokenSocketUnavailable(
        `corrallm’s token socket ${at} could not be made yours alone.`,
      );
    }
    ino = bound.ino;
  } catch (error) {
    await new Promise((resolve) => server.close(resolve));
    throw error;
  }
  server.on('error', (error) => {
    console.error('corrallm’s token socket:', error);
  });
  let closing: Promise<void> | undefined;
  return {
    path: at,
    close: () =>
      (closing ??= new Promise<void>((resolve) => {
        // Closing removes the socket, unless it went already (removeSync).
        server.close(() => {
          resolve();
        });
        // A request being answered is answered (a token it makes is then seen); the rest go now.
        for (const [socket, state] of connections) {
          if (!state.busy) socket.destroy();
        }
      })),
    removeSync: () => {
      try {
        if (lstatSync(at).ino === ino) rmSync(at, { force: true });
      } catch {
        // Gone already.
      }
    },
  };
}

/**
 * Answers one connection's request, then ends it; `state.busy` while it is answered. One idle for
 * REQUEST_MS, before its request or after its answer, is dropped.
 */
function serveOne(
  socket: Socket,
  answer: (request: TokenRequest) => Promise<TokenAnswer>,
  state: { busy: boolean },
): void {
  let received = Buffer.alloc(0);
  let answered = false;
  const reply = (value: TokenAnswer) => {
    let text = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(text) > MAX_LINE && value.ok && value.op !== 'revoke') {
      // File labels are optional. Never lose a minted token, or clip the grant, just because
      // long/non-ASCII file names make its presentation exceed the wire budget.
      text = `${JSON.stringify({ ...value, canvases: value.canvases.map(({ id }) => ({ id })) })}\n`;
    }
    if (Buffer.byteLength(text) > MAX_LINE) {
      text = `${JSON.stringify({ ok: false, sentence: 'The token socket’s answer is too long.' })}\n`;
    }
    if (socket.writable) socket.end(text);
  };
  const refuse = (sentence: string) => {
    reply({ ok: false, sentence });
  };
  socket.setTimeout(REQUEST_MS, () => {
    if (!state.busy) socket.destroy();
  });
  socket.on('error', () => undefined);
  socket.on('data', (chunk: Buffer) => {
    if (answered) return;
    received = Buffer.concat([received, chunk]);
    const end = received.indexOf(0x0a);
    if ((end === -1 ? received.length : end + 1) > MAX_LINE) {
      answered = true;
      refuse('That request is too long to be one of corrallm token’s.');
      return;
    }
    if (end === -1) {
      return;
    }
    answered = true;
    const request = parseRequest(received.subarray(0, end).toString('utf8'));
    if (request === undefined) {
      refuse(
        'That isn’t a request corrallm token makes: is it a corrallm token of another version?',
      );
      return;
    }
    state.busy = true;
    answer(request)
      .then(reply, (error: unknown) => {
        refuse(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        state.busy = false;
      });
  });
}

function parseRequest(line: string): TokenRequest | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  const parsed = TokenRequestSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Asks the corrallm that owns `profile` for `request`, over its token socket: its answer, or
 * undefined if none listens there (no socket, or one left behind). Rejects with
 * TokenSocketUnavailable if the socket can't be asked safely (on Windows, a path too long, a
 * socket or folder that isn't the user's alone), and with an Error if its owner doesn't answer, or
 * answers what isn't an answer, within `timeoutMs`.
 */
export async function askTokenOwner(
  profile: string,
  request: TokenRequest,
  {
    platform = process.platform,
    timeoutMs = ANSWER_MS,
  }: { platform?: NodeJS.Platform; timeoutMs?: number } = {},
): Promise<TokenAnswer | undefined> {
  let folder: string;
  try {
    folder = await checkFolder(path.dirname(socketPath(profile, platform)));
  } catch (error) {
    if (isCode(error, 'ENOENT') || isCode(error, 'ENOTDIR')) return undefined;
    throw error;
  }
  const at = socketPath(folder, platform);
  const found = await lstat(at).catch((error: unknown) => {
    if (isCode(error, 'ENOENT') || isCode(error, 'ENOTDIR')) return undefined;
    throw error;
  });
  if (found === undefined) return undefined;
  if (!usersAlone(found)) {
    throw new TokenSocketUnavailable(
      `${at} isn’t a socket only you can open, so it may not be corrallm’s: corrallm token won’t ask it. Remove it, and start the profile’s corrallm again.`,
    );
  }
  const sent = `${JSON.stringify(request)}\n`;
  if (Buffer.byteLength(sent) > MAX_LINE) {
    throw new Error('That request is too long to be one of corrallm token’s.');
  }
  return new Promise<TokenAnswer | undefined>((resolve, reject) => {
    const socket = createConnection(at);
    let received = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('The corrallm that owns the profile didn’t answer corrallm token in time.'));
    }, timeoutMs);
    const done = () => {
      clearTimeout(timer);
    };
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket.write(sent);
    });
    socket.on('data', (chunk: string) => {
      received += chunk;
      if (Buffer.byteLength(received) > MAX_LINE) {
        done();
        socket.destroy();
        reject(new Error('The profile’s owner answered what corrallm token doesn’t understand.'));
      }
    });
    socket.on('end', () => {
      done();
      const line = received.split('\n')[0] ?? '';
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        value = undefined;
      }
      const parsed = TokenAnswerSchema.safeParse(value);
      if (parsed.success) resolve(parsed.data);
      else
        reject(new Error('The profile’s owner answered what corrallm token doesn’t understand.'));
    });
    socket.on('error', (error) => {
      done();
      // Nothing listens there: a socket left behind by an owner that died.
      if (isCode(error, 'ECONNREFUSED') || isCode(error, 'ENOENT')) resolve(undefined);
      else reject(error);
    });
  });
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}
