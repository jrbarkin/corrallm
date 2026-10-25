import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CanvasId } from '../../shared/canvas';
import { askTokenOwner, serveTokenSocket, TokenSocketUnavailable } from './token-socket';
import type { TokenAnswer, TokenRequest, TokenSocket } from './token-socket';

/*
 * The token socket (Build Plan B30): how `corrallm token new|renew|revoke` asks whichever corrallm
 * owns a profile (the app's core or `corrallm serve`) for a token, never over MCP. Only the
 * profile's user can open it: a Unix socket, 0600, in a profile folder no one else may write to,
 * which the OS checks on every connect. Its client asks only a socket that is its user's alone.
 */

const CANVAS = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b01' as CanvasId;
const NEW: TokenRequest = {
  version: 1,
  op: 'new',
  name: 'orchestrator',
  hours: 2,
  access: 'write',
  canvases: ['/work/m1.corral'],
};
/** Whether file permissions can keep a process out: not as root, who passes them all. */
const AS_USER = process.getuid?.() !== 0;

function made(request: TokenRequest): TokenAnswer {
  return {
    ok: true,
    owner: 'serve',
    op: request.op === 'renew' ? 'renew' : 'new',
    token: 'A'.repeat(43),
    name: request.name,
    access: 'write',
    expires: 1,
    canvases: [{ id: CANVAS, file: '/work/m1.corral' }],
    url: 'http://127.0.0.1:47000/mcp',
  };
}

let dir: string;
let profile: string;
let sockets: TokenSocket[];
let servers: Server[];

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'corrallm-socket-'));
  await mkdir(path.join(dir, 'profile'), { mode: 0o700 });
  profile = await realpath(path.join(dir, 'profile'));
  sockets = [];
  servers = [];
});

afterEach(async () => {
  for (const socket of sockets) await socket.close();
  for (const server of servers) await new Promise((resolve) => server.close(resolve));
  await chmod(profile, 0o700).catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
});

async function serve(
  answer: (request: TokenRequest) => Promise<TokenAnswer> = (request) =>
    Promise.resolve(made(request)),
): Promise<TokenSocket> {
  const socket = await serveTokenSocket({ profile, answer });
  sockets.push(socket);
  return socket;
}

/**
 * A plain socket server at `at`, 0600, doing `handle` with each connection, whose input it reads
 * (so that it hears each client go, and closes).
 */
async function plain(at: string, handle: (socket: Socket) => void) {
  const server = createServer((connection) => {
    connection.on('error', () => undefined); // A client refusing an answer closes mid-write.
    connection.resume();
    handle(connection);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(at, resolve));
  await chmod(at, 0o600);
  return server;
}

/** Sends `text` raw on the profile's socket: what comes back before it ends. */
function raw(text: string | Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path.join(profile, 'token.sock'));
    let answer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      answer += chunk;
    });
    socket.on('end', () => {
      resolve(answer);
    });
    socket.on('error', reject);
    socket.write(text);
  });
}

describe.skipIf(process.platform === 'win32')('the token socket', () => {
  it('serves at <profile>/token.sock, a socket only its user can open, one request a connection', async () => {
    const asked: TokenRequest[] = [];
    const socket = await serve((request) => {
      asked.push(request);
      return Promise.resolve(made(request));
    });
    expect(socket.path).toBe(path.join(profile, 'token.sock'));
    const stats = await lstat(socket.path);
    expect(stats.isSocket()).toBe(true);
    expect(stats.mode & 0o777).toBe(0o600);
    expect(stats.uid).toBe(process.getuid?.());

    expect(await askTokenOwner(profile, NEW)).toEqual(made(NEW));
    const renew: TokenRequest = { version: 1, op: 'renew', name: 'orchestrator', hours: 12 };
    expect(await askTokenOwner(profile, renew)).toEqual(made(renew));
    expect(asked).toEqual([NEW, renew]);

    // Closed, it is gone, and nothing owns the profile for its client.
    await socket.close();
    expect(existsSync(socket.path)).toBe(false);
    expect(await askTokenOwner(profile, NEW)).toBeUndefined();
  });

  it.skipIf(!AS_USER)(
    'is opened only with write permission on it, which the OS checks on every connect',
    async () => {
      const socket = await serve();
      const connects = () =>
        new Promise<string>((resolve) => {
          const client = createConnection(socket.path);
          client.on('connect', () => {
            client.destroy();
            resolve('connected');
          });
          client.on('error', (error: NodeJS.ErrnoException) => {
            resolve(error.code ?? 'error');
          });
        });
      // Its own user, without write permission on it, is refused, as everyone else is at 0600.
      await chmod(socket.path, 0o500);
      expect(await connects()).toBe('EACCES');
      await chmod(socket.path, 0o600);
      expect(await connects()).toBe('connected');
    },
  );

  it('takes over a socket left behind, and refuses to serve over anything else there', async () => {
    const at = path.join(profile, 'token.sock');
    // A socket an owner served (0600) before it was killed: nothing listens on it any more.
    const child = spawn(process.execPath, [
      '-e',
      `const at = ${JSON.stringify(at)};
       require('node:net').createServer().listen(at, () => {
         require('node:fs').chmodSync(at, 0o600);
         console.log('up');
       });`,
    ]);
    await new Promise((resolve) => child.stdout.once('data', resolve));
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
    expect((await lstat(at)).isSocket()).toBe(true);
    expect(await askTokenOwner(profile, NEW)).toBeUndefined();
    const socket = await serve();
    expect(await askTokenOwner(profile, NEW)).toEqual(made(NEW));
    await socket.close();

    await writeFile(at, 'not a socket');
    await expect(
      serveTokenSocket({ profile, answer: () => Promise.reject(new Error('never')) }),
    ).rejects.toThrow(TokenSocketUnavailable);
    expect(await readFile(at, 'utf8')).toBe('not a socket');
  });

  it('refuses to serve in a profile folder others may write to', async () => {
    await chmod(profile, 0o777);
    await expect(
      serveTokenSocket({ profile, answer: () => Promise.reject(new Error('never')) }),
    ).rejects.toThrow(/others/);
    expect(existsSync(path.join(profile, 'token.sock'))).toBe(false);
  });

  it('refuses a private profile under an ancestor another user can replace', async () => {
    // A 0700 profile is still replaceable by renaming its entry in this non-sticky parent.
    await chmod(dir, 0o777);
    await expect(serve()).rejects.toThrow(/folder|ancestor/);
  });

  it('rechecks the ancestors before asking, and binds profile aliases at their canonical path', async () => {
    const alias = path.join(dir, 'alias');
    await symlink(profile, alias);
    const socket = await serveTokenSocket({
      profile: alias,
      answer: (request) => Promise.resolve(made(request)),
    });
    sockets.push(socket);
    expect(socket.path).toBe(path.join(profile, 'token.sock'));
    expect(await askTokenOwner(alias, NEW)).toEqual(made(NEW));
    // Someone has made a parent writable since bind: don't connect through that namespace.
    await chmod(dir, 0o777);
    await expect(askTokenOwner(alias, NEW)).rejects.toThrow(/folder|ancestor/);
  });

  it('asks only a socket that is its user’s alone: never one others can open, or a link to one', async () => {
    const socket = await serve();
    await chmod(socket.path, 0o666);
    await expect(askTokenOwner(profile, NEW)).rejects.toThrow(TokenSocketUnavailable);
    await chmod(socket.path, 0o600);
    // Nor in a profile folder others may write to, where another could have put it.
    await chmod(profile, 0o777);
    await expect(askTokenOwner(profile, NEW)).rejects.toThrow(/others/);
    await chmod(profile, 0o700);
    await socket.close();

    const elsewhere = path.join(dir, 'elsewhere.sock');
    await plain(elsewhere, (connection) => connection.end(`${JSON.stringify(made(NEW))}\n`));
    await symlink(elsewhere, path.join(profile, 'token.sock'));
    await expect(askTokenOwner(profile, NEW)).rejects.toThrow(TokenSocketUnavailable);
  });

  it('refuses what isn’t a request, saying why, without asking its owner', async () => {
    let asked = 0;
    await serve((request) => {
      asked++;
      return Promise.resolve(made(request));
    });
    const refused = async (text: string) => {
      const answer = JSON.parse(await raw(text)) as TokenAnswer;
      expect(answer).toMatchObject({ ok: false, sentence: expect.any(String) as string });
      return answer;
    };
    await refused('not json\n');
    await refused(`${JSON.stringify({ ...NEW, op: 'widen' })}\n`);
    await refused(`${JSON.stringify({ ...NEW, version: 2 })}\n`);
    await refused(`${JSON.stringify({ ...NEW, name: 'two words' })}\n`);
    await refused(`${JSON.stringify({ ...NEW, hours: 13 })}\n`);
    await refused(`${JSON.stringify({ ...NEW, hours: 1.5 })}\n`);
    await refused(`${JSON.stringify({ ...NEW, access: 'admin' })}\n`);
    await refused(`${JSON.stringify({ ...NEW, canvases: [] })}\n`);
    await refused(`${JSON.stringify({ ...NEW, canvases: ['relative.corral'] })}\n`);
    await refused(`${JSON.stringify({ ...NEW, canvases: Array(33).fill('/a.corral') })}\n`);
    await refused(`${JSON.stringify({ ...NEW, token: 'mine' })}\n`);
    await refused(`${JSON.stringify({ version: 1, op: 'revoke', name: 'x', hours: 1 })}\n`);
    // A request too long to be one is answered before it is all read, and the connection ends.
    expect(await refused('x'.repeat(70 * 1024))).toMatchObject({
      sentence: expect.stringMatching(/long/) as string,
    });
    expect(asked).toBe(0);
  });

  it('answers a refusal its owner gives, and the sentence of what failed', async () => {
    await serve((request) =>
      request.op === 'revoke'
        ? Promise.resolve({ ok: false, sentence: 'No live token is named “x”.' })
        : Promise.reject(new Error('m1.corral isn’t a canvas corrallm keeps.')),
    );
    expect(await askTokenOwner(profile, { version: 1, op: 'revoke', name: 'x' })).toEqual({
      ok: false,
      sentence: 'No live token is named “x”.',
    });
    expect(await askTokenOwner(profile, NEW)).toEqual({
      ok: false,
      sentence: 'm1.corral isn’t a canvas corrallm keeps.',
    });
  });

  it('refuses an oversized request even when its newline arrives with it', async () => {
    let asked = 0;
    await serve((request) => {
      asked++;
      return Promise.resolve(made(request));
    });
    const answer = JSON.parse(
      await raw(`${' '.repeat(64 * 1024)}${JSON.stringify(NEW)}\n`),
    ) as TokenAnswer;
    expect(answer).toMatchObject({ ok: false });
    expect(asked).toBe(0);
  });

  it('bounds answers in UTF-8 bytes, preserving a minted token and its full grant', async () => {
    const answer = made(NEW);
    if (!answer.ok || answer.op === 'revoke') throw new Error('No token.');
    answer.canvases = Array.from({ length: 8 }, () => ({
      id: CANVAS,
      file: `/${'界'.repeat(4000)}`,
    }));
    await serve(() => Promise.resolve(answer));
    const text = await raw(`${JSON.stringify(NEW)}\n`);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(64 * 1024);
    expect(JSON.parse(text)).toMatchObject({
      ok: true,
      token: answer.token,
      canvases: answer.canvases.map(({ id }) => ({ id })),
    });
  });

  it('refuses an oversized answer from another owner in bytes rather than characters', async () => {
    const answer = made(NEW);
    if (!answer.ok || answer.op === 'revoke') throw new Error('No token.');
    answer.canvases = Array.from({ length: 8 }, () => ({
      id: CANVAS,
      file: `/${'界'.repeat(4000)}`,
    }));
    await plain(path.join(profile, 'token.sock'), (socket) => {
      socket.end(`${JSON.stringify(answer)}\n`);
    });
    await expect(askTokenOwner(profile, NEW)).rejects.toThrow(/understand/);
  });

  it('gives up on an owner that never answers, or answers what isn’t an answer', async () => {
    const at = path.join(profile, 'token.sock');
    // Reads what it is sent, and never answers.
    const silent = await plain(at, () => undefined);
    await expect(askTokenOwner(profile, NEW, { timeoutMs: 200 })).rejects.toThrow(/answer/);
    await new Promise((resolve) => silent.close(resolve));
    servers = [];
    await plain(at, (connection) => connection.end('{"ok":true,"token":"x"}\n'));
    await expect(askTokenOwner(profile, NEW)).rejects.toThrow(/understand/);
  });

  it('removes its socket at once as the process exits', async () => {
    const socket = await serve();
    socket.removeSync();
    expect(existsSync(socket.path)).toBe(false);
  });

  it('refuses a profile whose path is too long for a socket', async () => {
    const long = path.join(dir, 'x'.repeat(110));
    await mkdir(long, { mode: 0o700 });
    await expect(
      serveTokenSocket({ profile: long, answer: () => Promise.reject(new Error('never')) }),
    ).rejects.toThrow(/too long/);
    await expect(askTokenOwner(long, NEW)).rejects.toThrow(/too long/);
  });
});

describe('the token socket on Windows', () => {
  it('is not built yet: neither the owner nor its client tries one', async () => {
    await expect(
      serveTokenSocket({
        profile: 'C:\\profile',
        answer: () => Promise.reject(new Error('never')),
        platform: 'win32',
      }),
    ).rejects.toThrow(/Windows/);
    await expect(askTokenOwner('C:\\profile', NEW, { platform: 'win32' })).rejects.toThrow(
      /Windows/,
    );
  });
});
