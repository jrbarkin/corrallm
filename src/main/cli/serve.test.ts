import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { opsFor, toolName } from '../../shared/api/registry';
import { SURFACE } from '../../shared/api/surface';
import type { Message } from '../../shared/model/messages';

/*
 * `corrallm serve` and `corrallm wait` (Build Plan B7; API Spec §8.6), as a person runs them: the
 * CLI bundle (dist-cli/corrallm.cjs, which the vitest `main` project's global setup builds) in a
 * child process, on a profile of its own whose canvases.json keeps a canvas and its project folder,
 * as the app would once the canvas was opened and its folder picked there. Its agents run a fake
 * `codex` (sessions/codex/fake-codex.mjs): Builder on the App Server, and Shell on the Terminal,
 * which no test ever starts. tokens.json holds known tokens' hashes; an MCP client (the SDK's
 * Client) calls with them, as an outside orchestrator would.
 */

const BUNDLE = path.resolve('dist-cli/corrallm.cjs');
const FAKE_CODEX = path.resolve('src/main/sessions/codex/fake-codex.mjs');
const FAKE_CLAUDE = path.resolve('e2e/fake-claude.mjs');

const CANVAS = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b01';
const SECOND = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b02';
/** A token for the canvas, read-write; one read-only; one expired; one for the second canvas only. */
const TOKEN = 'known-token-of-the-orchestrator-0123456789abcdef';
const READ_ONLY = 'known-read-only-token-0123456789abcdef';
const EXPIRED = 'known-expired-token-0123456789abcdef';
const SECOND_ONLY = 'known-second-canvas-token-0123456789abcdef';
const HOUR = 60 * 60 * 1000;

const execFileAsync = promisify(execFile);
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

describe.skipIf(process.platform === 'win32')('corrallm serve', () => {
  let dir: string;
  let profile: string;
  let file: string;
  let codex: string;
  let codexLog: string;
  let running: Serve[];
  let clients: Client[];
  /** Every tool result an MCP client got, as JSON: none may hold a token. */
  let results: string[];

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'corrallm-serve-'));
    profile = path.join(dir, 'profile');
    await mkdir(profile);
    const project = path.join(dir, 'project');
    await mkdir(project);
    file = await canvasFile('m1.corral', CANVAS);
    const second = await canvasFile('second.corral', SECOND);
    await writeFile(
      path.join(profile, 'canvases.json'),
      JSON.stringify({
        version: 2,
        canvases: {
          [CANVAS]: { file, project, conversations: {} },
          [SECOND]: { file: second, project, conversations: {} },
        },
      }),
    );
    const now = Date.now();
    const token = (id: string, canvases: string[], access: string, expires: number) => ({
      id,
      name: id,
      canvases,
      access,
      expires,
    });
    await writeFile(
      path.join(profile, 'tokens.json'),
      JSON.stringify({
        version: 2,
        tokens: {
          [sha256(TOKEN)]: { ...token('orchestrator', [CANVAS], 'write', now + HOUR) },
          [sha256(READ_ONLY)]: token('watcher', [CANVAS], 'read', now + HOUR),
          [sha256(EXPIRED)]: token('late', [CANVAS], 'write', now - 1),
          [sha256(SECOND_ONLY)]: token('elsewhere', [SECOND], 'write', now + HOUR),
        },
      }),
    );
    codex = path.join(dir, 'codex');
    codexLog = path.join(dir, 'codex.log');
    await writeFile(
      codex,
      `#!/bin/sh\nFAKE_CODEX_STATE="${path.join(dir, 'threads.json')}" FAKE_CODEX_LOG="${codexLog}" exec "${process.execPath}" "${FAKE_CODEX}" "$@"\n`,
    );
    await chmod(codex, 0o755);
    running = [];
    clients = [];
    results = [];
  });

  afterEach(async () => {
    for (const client of clients) await client.close().catch(() => undefined);
    for (const serve of running) await serve.stop().catch(() => undefined);
    for (const result of results) {
      for (const token of [TOKEN, READ_ONLY, EXPIRED, SECOND_ONLY])
        expect(result).not.toContain(token);
    }
    await rm(dir, { recursive: true, force: true });
  });

  /** A canvas file: Builder on Codex's App Server, Shell on its Terminal. */
  async function canvasFile(name: string, id: string): Promise<string> {
    const at = path.join(dir, name);
    await writeFile(
      at,
      JSON.stringify({
        format: 'corrallm',
        version: 2,
        id,
        nodes: [
          {
            id: 'builder',
            kind: 'agent',
            label: 'Builder',
            position: { x: 0, y: 0 },
            adapter: 'codex',
            connection: 'codex.app-server',
          },
          {
            id: 'shell',
            kind: 'agent',
            label: 'Shell',
            position: { x: 0, y: 100 },
            adapter: 'codex',
            connection: 'codex.terminal',
          },
        ],
        links: [],
      }),
    );
    return at;
  }

  /** The environment the CLI runs in: the fake `codex`, and no `claude`. */
  function cliEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CORRALLM_CODEX_PATH: codex,
      CORRALLM_CLAUDE_PATH: path.join(dir, 'no-claude'),
      ...extra,
    };
    delete env.CORRALLM_URL;
    delete env.CORRALLM_OUTSIDE_TOKEN;
    return env;
  }

  interface Serve {
    child: ChildProcess;
    url: string;
    pid: number;
    stderr(): string;
    exited: Promise<number | null>;
    stop(): Promise<number | null>;
  }

  /** Starts `corrallm serve` on the profile, serving the canvas on a free port. */
  async function serve(args: string[] = [], extra: Record<string, string> = {}): Promise<Serve> {
    const child = spawn(
      process.execPath,
      [BUNDLE, 'serve', '--profile', profile, '--canvas', file, '--port', '0', ...args],
      { env: cliEnv(extra), stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
    const api = await apiFile(exited, () => stderr);
    const started: Serve = {
      child,
      url: api.url,
      pid: api.pid,
      stderr: () => stderr,
      exited,
      stop: async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        return exited;
      },
    };
    running.push(started);
    return started;
  }

  /** api.json, once `serve` writes it; rejects, with what it said, if it exits first. */
  async function apiFile(
    exited: Promise<number | null>,
    said: () => string,
  ): Promise<{ url: string; port: number; pid: number }> {
    const state = { gone: false };
    void exited.then(() => {
      state.gone = true;
    });
    const at = path.join(profile, 'api.json');
    for (let tries = 0; tries < 600; tries++) {
      if (existsSync(at)) {
        try {
          return JSON.parse(await readFile(at, 'utf8')) as {
            url: string;
            port: number;
            pid: number;
          };
        } catch {
          // Being written.
        }
      }
      if (state.gone) throw new Error(`serve exited: ${said()}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`serve never wrote api.json: ${said()}`);
  }

  /** Runs `corrallm serve` expecting it to refuse: its exit code and what it said. */
  async function refused(args: string[]): Promise<{ code: number | null; stderr: string }> {
    const child = spawn(
      process.execPath,
      [BUNDLE, 'serve', '--profile', profile, '--port', '0', ...args],
      {
        env: cliEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
    return { code, stderr };
  }

  async function connect(url: string, token = TOKEN): Promise<Client> {
    const client = new Client({ name: 'orchestrator', version: '1' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }) as Transport,
    );
    clients.push(client);
    return client;
  }

  /** Calls a tool: its structured result, or throws its error's sentence. */
  async function call<T = Record<string, unknown>>(
    client: Client,
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<T> {
    const result = (await client.callTool({ name: toolName(name), arguments: args }, undefined, {
      timeout: 120_000,
    })) as CallToolResult;
    results.push(JSON.stringify(result));
    if (result.isError === true) {
      const [, error] = result.content as { text: string }[];
      throw new Error(error?.text);
    }
    return result.structuredContent as T;
  }

  /** A tool's error, as `{ code, sentence }`. */
  async function failure(
    client: Client,
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ code: string; sentence: string }> {
    const result = (await client.callTool({
      name: toolName(name),
      arguments: args,
    })) as CallToolResult;
    results.push(JSON.stringify(result));
    expect(result.isError).toBe(true);
    const [, error] = result.content as { text: string }[];
    return (JSON.parse(error?.text ?? '{}') as { error: { code: string; sentence: string } }).error;
  }

  /** Waits (over MCP, for up to 30 s at a time) until a message comes that `found` picks. */
  async function waitFor(client: Client, found: (message: Message) => boolean): Promise<Message> {
    for (let tries = 0; tries < 10; tries++) {
      const { messages } = await call<{ messages: Message[] }>(client, 'wait', {
        timeoutSeconds: 30,
      });
      const hit = messages.find(found);
      if (hit) return hit;
    }
    throw new Error('Nothing came');
  }

  /** A raw POST to the server: its status. */
  function post(url: string, headers: Record<string, string>, body: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const sent = request(url, { method: 'POST', headers }, (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      sent.once('error', reject);
      sent.end(body);
    });
  }

  const LIST = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const HEADERS = {
    Authorization: `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };

  it('serves an outside token its tools: a message, and its reply through wait with its TurnResult', async () => {
    const server = await serve();
    const client = await connect(server.url);
    const { tools } = await client.listTools();
    expect(tools.map(({ name }) => name).sort()).toEqual(
      opsFor(SURFACE, 'outside-write').map(toolName).sort(),
    );
    expect(tools.map(({ name }) => name)).toContain('wait');

    const { id } = await call<{ id: string }>(client, 'message', { to: 'builder', body: 'Hello' });
    const reply = await waitFor(client, (message) => message.replyTo === id);
    expect(reply).toMatchObject({
      from: 'agent:builder',
      to: 'outside:orchestrator',
      kind: 'text',
      turn: { status: 'completed', reason: 'completed' },
    });
    // Framed: Builder was told who the message is from.
    expect(reply.body).toBe(
      `You said: [corrallm] Message from "orchestrator" (an orchestrator outside corrallm, not the user; message ${id}):\nHello`,
    );
    // One line each on stderr: the message, and its reply.
    await vi.waitFor(() => {
      expect(server.stderr()).toMatch(new RegExp(`message ${id}`));
      expect(server.stderr()).toMatch(new RegExp(`reply to ${id}`));
    });
  });

  it('wakes the orchestrator when its message’s turn waits for you, lists it without choices, and an interrupt withdraws it', async () => {
    const server = await serve();
    const client = await connect(server.url);
    const { id } = await call<{ id: string }>(client, 'message', { to: 'builder', body: 'ask me' });
    const notice = await waitFor(client, (message) => message.kind === 'notice');
    expect(notice).toMatchObject({ from: 'corrallm', replyTo: id });
    expect(notice.body).toMatch(/^Builder is waiting for you: \S/);
    const { items } = await call<{ items: { kind: string; agent: string; choices: unknown[] }[] }>(
      client,
      'needs',
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'prompt', agent: 'builder', choices: [] });
    await vi.waitFor(() => {
      expect(server.stderr()).toMatch(/need on Builder: \S/);
    });

    await call(client, 'session.interrupt', { agent: 'builder' });
    const reply = await waitFor(
      client,
      (message) => message.replyTo === id && message.kind === 'text',
    );
    expect(reply.turn).toMatchObject({ status: 'cancelled', reason: 'interrupted' });
    expect((await call<{ items: unknown[] }>(client, 'needs')).items).toEqual([]);
  });

  it('refuses a token’s shell text to a Terminal agent at once, and delivers it framed to the App Server', async () => {
    const server = await serve();
    const client = await connect(server.url);
    const refusal = await failure(client, 'message', { to: 'shell', body: '!ls' });
    expect(refusal.code).toBe('refused');
    expect(refusal.sentence).toContain('!');

    const { id } = await call<{ id: string }>(client, 'message', { to: 'builder', body: '!ls' });
    const reply = await waitFor(client, (message) => message.replyTo === id);
    expect(reply.body).toContain(
      `(an orchestrator outside corrallm, not the user; message ${id}):\n!ls`,
    );
  });

  it('runs a canvas only from the file canvases.json keeps for it, in the folder picked in the app', async () => {
    const unknown = await canvasFile('unknown.corral', '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b03');
    const copy = path.join(dir, 'copy of m1.corral');
    await copyFile(file, copy);
    const memory = JSON.parse(await readFile(path.join(profile, 'canvases.json'), 'utf8')) as {
      canvases: Record<string, { project?: string }>;
    };
    delete memory.canvases[SECOND]?.project;
    await writeFile(path.join(profile, 'canvases.json'), JSON.stringify(memory));
    const second = path.join(dir, 'second.corral');

    for (const [canvas, why] of [
      [unknown, /isn’t a canvas corrallm keeps: open unknown\.corral in corrallm/],
      [copy, /copy/],
      [second, /project folder/],
    ] as const) {
      const { code, stderr } = await refused(['--canvas', canvas]);
      expect(code, stderr).toBe(1);
      expect(stderr).toMatch(why);
      expect(stderr).toMatch(/in corrallm/);
    }
    // Nothing was left behind: no server, and the profile free.
    expect(existsSync(path.join(profile, 'api.json'))).toBe(false);
    expect(existsSync(path.join(profile, 'core.lock'))).toBe(false);
  });

  it('refuses a new token with stderr on a pipe, so a person sees it when it is made', async () => {
    const before = await readFile(path.join(profile, 'tokens.json'), 'utf8');
    const { code, stderr } = await refused(['--canvas', file, '--new-token']);
    expect(code).toBe(1);
    expect(stderr).toMatch(/terminal/);
    expect(await readFile(path.join(profile, 'tokens.json'), 'utf8')).toBe(before);
  });

  /**
   * Runs `corrallm serve --new-token` on a terminal (script(1): a pty), until it serves: what it
   * printed there, and the server.
   */
  async function serveOnTerminal(
    args: string[],
  ): Promise<{ printed: () => string; server: Serve }> {
    const command = [
      process.execPath,
      BUNDLE,
      'serve',
      '--profile',
      profile,
      '--canvas',
      file,
      '--port',
      '0',
      '--new-token',
      ...args,
    ];
    const quote = (part: string) => `'${part.replaceAll("'", `'\\''`)}'`;
    const child =
      process.platform === 'darwin'
        ? spawn('script', ['-q', '/dev/null', ...command], {
            env: cliEnv({ CORRALLM_CLAUDE_PATH: FAKE_CLAUDE }),
            // Its input no terminal (macOS's script reads the terminal's settings from it).
            stdio: ['ignore', 'pipe', 'pipe'],
          })
        : spawn('script', ['-qec', command.map(quote).join(' '), '/dev/null'], {
            env: cliEnv({ CORRALLM_CLAUDE_PATH: FAKE_CLAUDE }),
            stdio: ['ignore', 'pipe', 'pipe'],
          });
    let printed = '';
    child.stdout.on('data', (chunk: Buffer) => {
      printed += chunk.toString();
    });
    const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
    const api = await apiFile(exited, () => printed);
    const server: Serve = {
      child,
      url: api.url,
      pid: api.pid,
      stderr: () => printed,
      exited,
      stop: async () => {
        try {
          process.kill(api.pid, 'SIGTERM');
        } catch {
          // Gone already.
        }
        return exited;
      },
    };
    running.push(server);
    return { printed: () => printed.replaceAll('\r\n', '\n'), server };
  }

  it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
    'makes a token on a terminal: printed once, kept as its hash, with each adapter’s registration',
    async () => {
      const { printed, server } = await serveOnTerminal(['--name', 'builder-bot', '--hours', '2']);
      await vi.waitFor(() => {
        expect(printed()).toMatch(/codex mcp add/);
      });
      const token = /^ {2}([A-Za-z0-9_-]{43})$/m.exec(printed())?.[1];
      expect(token).toBeDefined();
      expect(printed().split(token ?? '')).toHaveLength(2);
      const kept = await readFile(path.join(profile, 'tokens.json'), 'utf8');
      expect(kept).not.toContain(token);
      expect(
        (JSON.parse(kept) as { tokens: Record<string, unknown> }).tokens[sha256(token ?? '')],
      ).toMatchObject({
        name: 'builder-bot',
        canvases: [CANVAS],
        access: 'write',
      });
      expect(printed()).toContain(server.url);
      expect(printed()).toContain(
        `claude mcp add --transport http corrallm-outside ${server.url} --header 'Authorization: Bearer \${CORRALLM_OUTSIDE_TOKEN}'`,
      );
      expect(printed()).toContain(
        `codex mcp add corrallm-outside --url ${server.url} --bearer-token-env-var CORRALLM_OUTSIDE_TOKEN`,
      );
      // It works.
      const client = await connect(server.url, token);
      expect((await call<{ agents: unknown[] }>(client, 'agents')).agents).toHaveLength(2);
    },
  );

  it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
    'renews a token by name across a restart: the new one reads what the old hadn’t, and the old gets 401',
    async () => {
      const first = await serve();
      const old = await connect(first.url);
      const { id } = await call<{ id: string }>(old, 'message', { to: 'builder', body: 'Hello' });
      // The reply comes back while the orchestrator reads nothing.
      await vi.waitFor(async () => {
        const { items } = await call<{ items: Message[] }>(old, 'messages');
        expect(items.some((message) => message.replyTo === id && message.kind === 'text')).toBe(
          true,
        );
      });
      await first.stop();

      const { printed, server } = await serveOnTerminal(['--name', 'orchestrator']);
      const token = /^ {2}([A-Za-z0-9_-]{43})$/m.exec(printed())?.[1] ?? '';
      const renewed = await connect(server.url, token);
      const { messages } = await call<{ messages: Message[] }>(renewed, 'wait', {
        timeoutSeconds: 0,
      });
      expect(messages.map(({ replyTo, kind }) => [replyTo, kind])).toEqual([[id, 'text']]);
      expect(await post(server.url, HEADERS, LIST)).toBe(401);
    },
  );

  it('keeps the port it chose, and exits naming a port that is taken', async () => {
    const first = spawn(
      process.execPath,
      [BUNDLE, 'serve', '--profile', profile, '--canvas', file],
      {
        env: cliEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let said = '';
    first.stderr.on('data', (chunk: Buffer) => {
      said += chunk.toString();
    });
    const exited = new Promise<number | null>((resolve) => first.once('exit', resolve));
    const api = await apiFile(exited, () => said);
    const settings = JSON.parse(await readFile(path.join(profile, 'settings.json'), 'utf8')) as {
      api?: { port?: number };
    };
    expect(settings.api?.port).toBe(api.port);
    first.kill('SIGTERM');
    expect(await exited).toBe(0);

    // Taken by another server meanwhile: it says so, naming the port.
    const { createServer } = await import('node:net');
    const squatter = createServer();
    await new Promise<void>((resolve) => squatter.listen(api.port, '127.0.0.1', resolve));
    try {
      const child = spawn(
        process.execPath,
        [BUNDLE, 'serve', '--profile', profile, '--canvas', file],
        {
          env: cliEnv(),
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
      expect(code).toBe(1);
      expect(stderr).toContain(String(api.port));
      expect(existsSync(path.join(profile, 'core.lock'))).toBe(false);
    } finally {
      await new Promise((resolve) => squatter.close(resolve));
    }
  });

  /** Runs `corrallm wait`: its exit code, and the one line it printed. */
  async function cliWait(
    args: string[],
    env: Record<string, string>,
  ): Promise<{ code: number; line: string }> {
    const full = cliEnv();
    for (const [key, value] of Object.entries(env)) full[key] = value;
    try {
      const { stdout } = await execFileAsync(process.execPath, [BUNDLE, 'wait', ...args], {
        env: full,
      });
      return { code: 0, line: stdout };
    } catch (error) {
      const { code, stdout } = error as { code: number; stdout: string };
      return { code, line: stdout };
    }
  }

  it('waits from the command line, exiting 0 when something came, 1 at its time limit, 2 refused, 3 with no server', async () => {
    const server = await serve();
    const client = await connect(server.url);
    const env = { CORRALLM_URL: server.url, CORRALLM_OUTSIDE_TOKEN: TOKEN };

    const { id } = await call<{ id: string }>(client, 'message', { to: 'builder', body: 'Hello' });
    const came = await cliWait(['--timeout', '30', '--for', id], env);
    expect(came.code).toBe(0);
    expect(came.line.split('\n').filter(Boolean)).toHaveLength(1);
    const result = JSON.parse(came.line) as { messages: Message[]; next: string };
    expect(result.messages[0]).toMatchObject({ replyTo: id, kind: 'text' });
    expect(result.next).toEqual(expect.any(String));

    const nothing = await cliWait(['--timeout', '1', '--after', result.next], env);
    expect(nothing.code).toBe(1);
    expect(JSON.parse(nothing.line)).toEqual({ messages: [], next: result.next });

    expect(
      (await cliWait(['--timeout', '1'], { ...env, CORRALLM_OUTSIDE_TOKEN: 'wrong' })).code,
    ).toBe(2);
    expect((await cliWait(['--timeout', '1'], { CORRALLM_URL: server.url })).code).toBe(2);
    expect(
      (await cliWait(['--timeout', '1'], { ...env, CORRALLM_OUTSIDE_TOKEN: EXPIRED })).code,
    ).toBe(2);

    await server.stop();
    expect((await cliWait(['--timeout', '1'], env)).code).toBe(3);
  });

  it('finds the server from api.json in the app’s profile while its process lives', async () => {
    // The app's profile, under a home of the test's own.
    const home = path.join(dir, 'home');
    const appProfile =
      process.platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support', 'corrallm')
        : path.join(home, '.config', 'corrallm');
    const env = { HOME: home, CORRALLM_OUTSIDE_TOKEN: TOKEN, XDG_CONFIG_HOME: '' };
    expect((await cliWait(['--timeout', '0'], env)).code).toBe(3);

    await mkdir(path.dirname(appProfile), { recursive: true });
    await rm(appProfile, { recursive: true, force: true });
    await copyDir(profile, appProfile);
    profile = appProfile;
    const server = await serve();
    expect((await cliWait(['--timeout', '0'], env)).code).toBe(1);
    await server.stop();
    expect(existsSync(path.join(appProfile, 'api.json'))).toBe(false);

    // One left by a process that is gone finds nothing.
    await writeFile(
      path.join(appProfile, 'api.json'),
      JSON.stringify({ url: server.url, port: 1, pid: 999_999 }),
    );
    expect((await cliWait(['--timeout', '0'], env)).code).toBe(3);
  });

  async function copyDir(from: string, to: string): Promise<void> {
    await execFileAsync('cp', ['-R', from, to]);
  }

  it('owns the profile alone: it refuses while the app or another serve holds it, and takes over a lock left behind', async () => {
    await writeFile(
      path.join(profile, 'core.lock'),
      JSON.stringify({
        owner: 'app',
        pid: process.pid,
        started: Date.now() - process.uptime() * 1000,
      }),
    );
    const blocked = await refused(['--canvas', file]);
    expect(blocked.code).toBe(1);
    expect(blocked.stderr).toContain(
      `The corrallm app (process ${String(process.pid)}) is using this profile.`,
    );

    // A lock whose process is gone is taken over.
    await writeFile(
      path.join(profile, 'core.lock'),
      JSON.stringify({ owner: 'app', pid: 999_999, started: Date.now() }),
    );
    const server = await serve();
    const second = await refused(['--canvas', file]);
    expect(second.code).toBe(1);
    expect(second.stderr).toContain(
      `corrallm serve (process ${String(server.pid)}) is using this profile.`,
    );

    expect(await server.stop()).toBe(0);
    expect(existsSync(path.join(profile, 'core.lock'))).toBe(false);
    expect(existsSync(path.join(profile, 'api.json'))).toBe(false);
  });

  it('checks every request’s token, its canvases and access, and refuses a page’s request or a body that isn’t JSON', async () => {
    const server = await serve(['--canvas', path.join(dir, 'second.corral')]);
    expect(await post(server.url, HEADERS, LIST)).toBe(200);
    expect(await post(server.url, { ...HEADERS, Authorization: `Bearer ${EXPIRED}` }, LIST)).toBe(
      401,
    );
    expect(await post(server.url, { ...HEADERS, Authorization: 'Bearer wrong' }, LIST)).toBe(401);
    expect(await post(server.url, { ...HEADERS, Origin: 'https://example.com' }, LIST)).toBe(403);
    expect(await post(server.url, { ...HEADERS, 'Content-Type': 'text/plain' }, LIST)).toBe(415);

    const reader = await connect(server.url, READ_ONLY);
    expect(
      await failure(reader, 'message', { canvas: CANVAS, to: 'builder', body: 'Hi' }),
    ).toMatchObject({
      code: 'forbidden',
    });
    expect(await call(reader, 'wait', { timeoutSeconds: 0 })).toMatchObject({ messages: [] });

    // A canvas the token wasn't made for is no canvas it knows of, though corrallm serves it.
    const writer = await connect(server.url);
    expect(await failure(writer, 'agents', { canvas: SECOND })).toMatchObject({
      code: 'not-found',
    });
    const elsewhere = await connect(server.url, SECOND_ONLY);
    expect(await failure(elsewhere, 'agents', { canvas: CANVAS })).toMatchObject({
      code: 'not-found',
    });
    expect((await call<{ agents: unknown[] }>(elsewhere, 'agents')).agents).toHaveLength(2);
  });

  it('restarts with the same token: the thread resumes, a waiting message waits, one cut off is unresolved, and the token is in no child’s arguments', async () => {
    let server = await serve();
    let client = await connect(server.url);
    await call(client, 'message', { to: 'builder', body: 'Hello' });
    await waitFor(client, (message) => message.kind === 'text');

    const { id: slow } = await call<{ id: string }>(client, 'message', {
      to: 'builder',
      body: 'slow down',
    });
    await vi.waitFor(async () => {
      const { items } = await call<{ items: Message[] }>(client, 'messages');
      expect(items.find((message) => message.id === slow)?.state).toBe('delivered');
    });
    // Mid-turn: no process serve started holds a token in its arguments.
    const { stdout } = await execFileAsync('ps', ['-A', '-ww', '-o', 'pid=,ppid=,args=']);
    const rows = stdout
      .split('\n')
      .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
      .filter((row) => row !== null);
    const descendants = new Set([server.pid]);
    for (let grew = true; grew;) {
      grew = false;
      for (const [, pid, ppid] of rows) {
        if (descendants.has(Number(ppid)) && !descendants.has(Number(pid))) {
          descendants.add(Number(pid));
          grew = true;
        }
      }
    }
    const children = rows.filter(
      ([, pid]) => descendants.has(Number(pid)) && Number(pid) !== server.pid,
    );
    expect(children.some(([, , , args]) => args?.includes('fake-codex.mjs'))).toBe(true);
    for (const [, , , args] of children) expect(args).not.toContain(TOKEN);

    expect(await server.stop()).toBe(0);
    server = await serve();
    client = await connect(server.url);
    const { items } = await call<{ items: Message[] }>(client, 'messages');
    expect(items.find((message) => message.id === slow)?.state).toBe('unresolved');
    const cutOff = items.find((message) => message.kind === 'notice' && message.replyTo === slow);
    expect(cutOff?.body).toMatch(/cut off/);

    // The next message goes, though the run restored paused, and resumes Builder's thread.
    const { id: again } = await call<{ id: string }>(client, 'message', {
      to: 'builder',
      body: 'Again',
    });
    await waitFor(client, (message) => message.replyTo === again && message.kind === 'text');
    const log = (await readFile(codexLog, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });
    const started = log.find(({ method }) => method === 'thread/start');
    const resumed = log.find(({ method }) => method === 'thread/resume');
    expect(resumed?.params.threadId).toEqual(expect.any(String));
    expect(started).toBeDefined();
    // The message cut off was never sent again.
    const sentSlow = log.filter(
      ({ method, params }) =>
        method === 'turn/start' && JSON.stringify(params).includes('slow down'),
    );
    expect(sentSlow).toHaveLength(1);

    // A message waiting on a paused agent still waits after a restart.
    await call(client, 'run.pause', { target: { agent: 'builder' } });
    const { id: later } = await call<{ id: string }>(client, 'message', {
      to: 'builder',
      body: 'Later',
    });
    expect(await server.stop()).toBe(0);
    server = await serve();
    client = await connect(server.url);
    const after = await call<{ items: Message[] }>(client, 'messages');
    expect(after.items.find((message) => message.id === later)?.state).toBe('pending');
  });
});
