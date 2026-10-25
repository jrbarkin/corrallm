import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createServer as createHttpServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { opsFor, toolName } from '../../shared/api/registry';
import { SURFACE } from '../../shared/api/surface';
import type { CanvasId } from '../../shared/canvas';
import type { Message } from '../../shared/model/messages';
import { keepCanvases, keepMessages, readOnDisk, writeOnDisk } from '../core/store/test-store';
import { TestChildren } from './test-children';
import { startupShell } from './test-startup-shell';
import { waitForServing } from './test-serve-startup';
import type { TestChild } from './test-children';

/*
 * `corrallm serve` and `corrallm wait` (Build Plan B7; API Spec §8.6), as a person runs them: the
 * CLI bundle (dist-cli/corrallm.cjs, which the vitest `main` project's global setup builds) in a
 * child process, on a profile of its own whose database keeps a canvas and its project folder, as
 * the app would once the canvas was opened and its folder picked there. Its agents run a fake
 * `codex` (sessions/codex/fake-codex.mjs): Builder on the App Server, and Shell on the Terminal,
 * which no test ever starts. tokens.json holds known tokens' hashes; an MCP client (the SDK's
 * Client) calls with them, as an outside orchestrator would.
 */

const BUNDLE = path.resolve('dist-cli/corrallm.cjs');
const FAKE_CODEX = path.resolve('src/main/sessions/codex/fake-codex.mjs');
const FAKE_CLAUDE = path.resolve('e2e/fake-claude.mjs');

const CANVAS = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b01';
const SECOND = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b02';
/**
 * A token for the canvas, read-write; one read-only; one expired; one for the second canvas
 * only.
 */
const TOKEN = 'known-token-of-the-orchestrator-0123456789abcdef';
const READ_ONLY = 'known-read-only-token-0123456789abcdef';
const EXPIRED = 'known-expired-token-0123456789abcdef';
const SECOND_ONLY = 'known-second-canvas-token-0123456789abcdef';
const HOUR = 60 * 60 * 1000;

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

describe.skipIf(process.platform === 'win32')('corrallm serve', () => {
  let dir: string;
  let profile: string;
  let file: string;
  let codex: string;
  let codexLog: string;
  let children: TestChildren;
  let clients: Client[];
  /** Every tool result an MCP client got, as JSON: none may hold a token. */
  let results: string[];

  beforeEach(async () => {
    children = new TestChildren();
    clients = [];
    results = [];
    dir = await mkdtemp(path.join(tmpdir(), 'corrallm-serve-'));
    profile = path.join(dir, 'profile');
    await mkdir(profile);
    const project = path.join(dir, 'project');
    await mkdir(project);
    file = await canvasFile('m1.corral', CANVAS);
    const second = await canvasFile('second.corral', SECOND);
    await keepCanvases(profile, {
      [CANVAS]: { file, project },
      [SECOND]: { file: second, project },
    });
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
    await fakeCodex();
  });

  afterEach(async () => {
    // Stop even a child whose startup never finished, before removing any of its files.
    await children.close();
    for (const client of clients) await client.close().catch(() => undefined);
    for (const result of results) {
      for (const token of [TOKEN, READ_ONLY, EXPIRED, SECOND_ONLY])
        expect(result).not.toContain(token);
    }
    await rm(dir, { recursive: true, force: true });
  }, 30_000);

  /** The `codex` agents run: the fake, keeping its threads and log in `dir`, with `env` set. */
  async function fakeCodex(env: Record<string, string> = {}): Promise<void> {
    const set = Object.entries({
      FAKE_CODEX_STATE: path.join(dir, 'threads.json'),
      FAKE_CODEX_LOG: codexLog,
      ...env,
    })
      .map(([name, value]) => `${name}="${value}"`)
      .join(' ');
    await writeFile(codex, `#!/bin/sh\n${set} exec "${process.execPath}" "${FAKE_CODEX}" "$@"\n`);
    await chmod(codex, 0o755);
  }

  /** A canvas file: Builder (or `builder`) on Codex's App Server, Shell on its Terminal. */
  async function canvasFile(name: string, id: string, builder = 'Builder'): Promise<string> {
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
            label: builder,
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
      CORRALLM_AGENT_PATHS: JSON.stringify({
        codex: codex,
        'claude-code': path.join(dir, 'no-claude'),
      }),
      ...extra,
    };
    delete env.CORRALLM_URL;
    delete env.CORRALLM_OUTSIDE_TOKEN;
    return env;
  }

  interface Serve {
    child: TestChild;
    url: string;
    pid: number;
    stderr(): string;
    exited: Promise<number | null>;
    stop(): Promise<number | null>;
  }

  /** Starts `corrallm serve`, once discovery is readable and it has said it serves. */
  async function serve(args: string[] = [], extra: Record<string, string> = {}): Promise<Serve> {
    const child = children.spawn(
      process.execPath,
      [BUNDLE, 'serve', '--profile', profile, '--canvas', file, '--port', '0', ...args],
      cliEnv(extra),
    );
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const exited = children.exited(child);
    const api = await waitForServing(
      apiFile(exited, () => stderr),
      exited,
      child.stderr,
      () => stderr,
    );
    const started: Serve = {
      child,
      url: api.url,
      pid: api.pid,
      stderr: () => stderr,
      exited,
      stop: () => children.stop(child),
    };
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

  /**
   * Runs `corrallm serve` expecting it to refuse (on a free port, unless `args` name one): its exit
   * code and what it said.
   */
  async function refused(
    args: string[],
    at = profile,
  ): Promise<{ code: number | null; stderr: string }> {
    const port = args.includes('--port') ? [] : ['--port', '0'];
    const child = children.spawn(
      process.execPath,
      [BUNDLE, 'serve', '--profile', at, ...port, ...args],
      cliEnv(),
    );
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const code = await children.exited(child);
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

  /** Sends Builder a turn that runs until it is interrupted, once it is delivered: its id. */
  async function midTurn(client: Client): Promise<string> {
    const { id } = await call<{ id: string }>(client, 'message', {
      to: 'builder',
      body: 'slow down',
    });
    // Delivered once what Builder's codex defaults to is read (a private app server, which a fake
    // that lingers as it exits takes that much longer to close).
    await vi.waitFor(
      async () => {
        const { items } = await call<{ items: Message[] }>(client, 'messages');
        expect(items.find((message) => message.id === id)?.state).toBe('delivered');
      },
      { timeout: 10_000, interval: 50 },
    );
    return id;
  }

  /** What the canvas's messages are, as a restarted serve has them. */
  async function messagesAfterRestart(): Promise<Message[]> {
    const server = await serve();
    const client = await connect(server.url);
    return (await call<{ items: Message[] }>(client, 'messages')).items;
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
    // It said what it serves, by name and id, and how `corrallm wait` finds it on this profile.
    expect(server.stderr()).toContain(`serving m1.corral (${CANVAS}) at ${server.url}`);
    expect(server.stderr()).toContain(`export CORRALLM_URL=${server.url}`);
    // Only you may read where it listens, and what it keeps.
    expect((await stat(path.join(profile, 'api.json'))).mode & 0o777).toBe(0o600);
    expect((await stat(path.join(profile, 'core.db'))).mode & 0o777).toBe(0o600);
  }, 15_000);

  it('says nothing it is given as it came: no control character from a canvas or a prompt reaches its terminal', async () => {
    // A shared canvas's agent named to move the cursor, erase a line and ring the bell.
    await canvasFile('m1.corral', CANVAS, 'Builder\u001b[1A\u001b[2K\u0007\u009b');
    const server = await serve();
    const client = await connect(server.url);
    const { id } = await call<{ id: string }>(client, 'message', { to: 'builder', body: 'ask me' });
    await waitFor(client, (message) => message.kind === 'notice' && message.replyTo === id);
    await vi.waitFor(() => {
      expect(server.stderr()).toMatch(/need on Builder/);
      expect(server.stderr()).toMatch(/notice to outside:orchestrator about/);
    });
    expect(server.stderr()).toContain('Builder\\x1b[1A\\x1b[2K\\x07\\x9b');
    // No control character but the line breaks between its lines.
    expect(server.stderr().replaceAll('\n', '')).not.toMatch(/\p{Cc}/u);
  }, 15_000);

  it('wakes the orchestrator when its message’s turn waits for you, lists it without choices, and an interrupt withdraws it', async () => {
    const server = await serve();
    const client = await connect(server.url);
    const { id } = await call<{ id: string }>(client, 'message', { to: 'builder', body: 'ask me' });
    const notice = await waitFor(client, (message) => message.kind === 'notice');
    expect(notice).toMatchObject({ from: 'corrallm', replyTo: id });
    expect(notice.body).toMatch(/^Builder is waiting for the user: \S/);
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
  }, 15_000);

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
  }, 15_000);

  it('runs a canvas only from the file corrallm keeps for it, in the folder picked in the app', async () => {
    const unknown = await canvasFile('unknown.corral', '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b03');
    const copy = path.join(dir, 'copy of m1.corral');
    await copyFile(file, copy);
    const second = path.join(dir, 'second.corral');
    // A canvas whose project folder corrallm keeps is gone (a worktree removed).
    const gone = await canvasFile('gone.corral', '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b04');
    const removed = path.join(dir, 'removed');
    await keepCanvases(profile, {
      // Its folder not picked.
      [SECOND]: { file: second },
      '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b04': { file: gone, project: removed },
    });

    const sentences = {
      unknown: 'unknown.corral isn’t a canvas corrallm keeps: open unknown.corral in corrallm',
      copy: 'copy of m1.corral is a copy of a canvas corrallm keeps at ',
      second: 'second.corral has no project folder: open second.corral in corrallm',
      gone: `gone.corral has a project folder corrallm keeps at ${removed}, which isn’t there any more: open gone.corral in corrallm`,
    };
    for (const [canvas, which] of [
      [unknown, 'unknown'],
      [copy, 'copy'],
      [second, 'second'],
      [gone, 'gone'],
    ] as const) {
      const { code, stderr } = await refused(['--canvas', canvas]);
      expect(code, stderr).toBe(1);
      expect(stderr).toContain(sentences[which]);
      for (const [other, sentence] of Object.entries(sentences)) {
        if (other !== which) expect(stderr).not.toContain(sentence);
      }
    }
    // Nothing was left behind: no server, and the profile free.
    expect(existsSync(path.join(profile, 'api.json'))).toBe(false);
    expect(existsSync(path.join(profile, 'core.lock'))).toBe(false);

    // A profile it makes, though it then refuses, is the user's alone, as the app's is.
    const fresh = path.join(dir, 'profiles', 'orchestration');
    expect((await refused(['--canvas', file], fresh)).code).toBe(1);
    expect((await stat(fresh)).mode & 0o777).toBe(0o700);
  }, 30_000);

  it('sends nothing when it refuses to start after opening a canvas: a message waiting still waits', async () => {
    const first = await serve();
    const client = await connect(first.url);
    // Builder is mid-turn, and a second message waits behind it.
    await midTurn(client);
    const { id: behind } = await call<{ id: string }>(client, 'message', {
      to: 'builder',
      body: 'hello behind',
    });
    expect(await first.stop()).toBe(0);

    // Started again with a canvas it then refuses, and on a port that is taken: each refused.
    const unknown = await canvasFile('unknown.corral', '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b03');
    expect((await refused(['--canvas', file, '--canvas', unknown])).code).toBe(1);
    const squatter = createServer();
    await new Promise<void>((resolve) => squatter.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = squatter.address() as { port: number };
      expect((await refused(['--canvas', file, '--port', String(port)])).code).toBe(1);
    } finally {
      await new Promise((resolve) => squatter.close(resolve));
    }
    // Nothing reached Builder meanwhile.
    const sent = () =>
      readFile(codexLog, 'utf8').then((log) =>
        log
          .split('\n')
          .filter((line) => line.includes('"turn/start"') && line.includes('hello behind')),
      );
    expect(await sent()).toEqual([]);

    // The next start that serves delivers it, never told it was cut off.
    const server = await serve();
    const again = await connect(server.url);
    const reply = await waitFor(again, (message) => message.replyTo === behind);
    expect(reply).toMatchObject({ kind: 'text', turn: { status: 'completed' } });
    expect(await sent()).toHaveLength(1);
  }, 30_000);

  it('refuses an unwritable api.json without delivering a queued message or saying it serves', async () => {
    const id = 'b072b045-bd48-4f93-9226-cb2524298b87';
    await keepMessages(profile, CANVAS as CanvasId, [
      {
        message: {
          id,
          from: 'outside:orchestrator',
          to: 'agent:builder',
          kind: 'text',
          body: 'Wait until discovery is published',
          state: 'pending',
          at: Date.now(),
        },
      },
    ]);
    const api = path.join(profile, 'api.json');
    await mkdir(api);
    const { code, stderr } = await refused(['--canvas', file]);
    expect(code, stderr).toBe(1);
    expect(stderr).toContain('api.json');
    expect(stderr).not.toContain('corrallm serve: serving ');
    expect(existsSync(path.join(profile, 'core.lock'))).toBe(false);
    expect(
      readOnDisk(
        profile,
        (disk) => disk.prepare('SELECT state FROM message WHERE id = ?').get(id)?.state,
      ),
    ).toBe('pending');
    const sent = async () =>
      existsSync(codexLog)
        ? (await readFile(codexLog, 'utf8'))
            .split('\n')
            .filter((line) => line.includes('"turn/start"') && line.includes(id))
        : [];
    expect(await sent()).toEqual([]);

    await rm(api, { recursive: true });
    const server = await serve();
    const client = await connect(server.url);
    const reply = await waitFor(client, (message) => message.replyTo === id);
    expect(reply).toMatchObject({ turn: { status: 'completed' } });
    expect(await sent()).toHaveLength(1);
  }, 15_000);

  it('has readable api.json as soon as serving is printed', async () => {
    const child = children.spawn(
      process.execPath,
      [BUNDLE, 'serve', '--profile', profile, '--canvas', file, '--port', '0'],
      cliEnv(),
    );
    const printed = Promise.withResolvers<unknown>();
    let stderr = '';
    let heard = false;
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (!heard && stderr.includes('corrallm serve: serving ')) {
        heard = true;
        try {
          printed.resolve(
            JSON.parse(readFileSync(path.join(profile, 'api.json'), 'utf8')) as unknown,
          );
        } catch (error) {
          printed.reject(error);
        }
      }
    });
    try {
      const api = await Promise.race([
        printed.promise,
        children.exited(child).then((code) => {
          throw new Error(`serve exited ${String(code)} before serving: ${stderr}`);
        }),
      ]);
      expect(api).toMatchObject({
        url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:/) as string,
        pid: child.pid,
      });
    } finally {
      await children.stop(child);
    }
  }, 15_000);

  it('refuses a new token with stderr on a pipe, so a person sees it when it is made', async () => {
    const before = await readFile(path.join(profile, 'tokens.json'), 'utf8');
    const { code, stderr } = await refused(['--canvas', file, '--new-token']);
    expect(code).toBe(1);
    expect(stderr).toMatch(/terminal/);
    expect(await readFile(path.join(profile, 'tokens.json'), 'utf8')).toBe(before);
  }, 15_000);

  /**
   * Starts `corrallm serve --new-token` on a terminal (script(1): a pty), in its environment with
   * `extra`: script, what it printed there, and its exit.
   */
  function onTerminal(
    args: string[],
    extra: Record<string, string> = {},
  ): { child: TestChild; printed: () => string; exited: Promise<number | null> } {
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
    return children.terminal(
      command,
      cliEnv({
        CORRALLM_AGENT_PATHS: JSON.stringify({ codex, 'claude-code': FAKE_CLAUDE }),
        ...extra,
      }),
    );
  }

  /**
   * Runs `corrallm serve --new-token` on a terminal until it serves: what it printed there, and the
   * server.
   */
  async function serveOnTerminal(
    args: string[],
  ): Promise<{ printed: () => string; server: Serve }> {
    const { child, printed, exited } = onTerminal(args);
    const api = await apiFile(exited, printed);
    children.target(child, api.pid);
    // api.json is written as it serves, but the token it printed first comes through the terminal.
    await vi.waitFor(
      () => {
        expect(printed()).toMatch(/^ {2}[A-Za-z0-9_-]{43}$/m);
      },
      { timeout: 20_000, interval: 50 },
    );
    const server: Serve = {
      child,
      url: api.url,
      pid: api.pid,
      stderr: printed,
      exited,
      stop: async () => {
        await children.stop(child);
        return exited;
      },
    };
    return { printed, server };
  }

  it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux').each([false, true])(
    'prints the URL hint once on another profile (new token: %s)',
    async (newToken) => {
      const server = newToken ? (await serveOnTerminal([])).server : await serve();
      await vi.waitFor(() => {
        expect(server.stderr()).toContain('corrallm serve: serving ');
      });
      await server.stop();
      const printed = server.stderr();
      const hint = `corrallm wait finds this server only by its URL: export CORRALLM_URL=${server.url} where your orchestrator runs.`;
      expect(printed.split(hint)).toHaveLength(2);
      const serving = printed.indexOf('corrallm serve: serving ');
      if (newToken) expect(printed.indexOf(hint)).toBeLessThan(serving);
      else expect(printed.indexOf(hint)).toBeGreaterThan(serving);
    },
    30_000,
  );

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
      expect(printed()).toContain(`reaching m1.corral (${CANVAS})`);
      expect(printed()).toContain(`export CORRALLM_URL=${server.url}`);
      expect(printed()).toContain(
        `claude mcp add --transport http corrallm-server ${server.url} --header 'Authorization: Bearer \${CORRALLM_OUTSIDE_TOKEN}'`,
      );
      expect(printed()).toContain(
        `codex mcp add corrallm-server --url ${server.url} --bearer-token-env-var CORRALLM_OUTSIDE_TOKEN`,
      );
      // It works.
      const client = await connect(server.url, token);
      expect((await call<{ agents: unknown[] }>(client, 'agents')).agents).toHaveLength(2);
    },
    30_000,
  );

  it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
    'exits once its terminal is gone, having let the profile go',
    async () => {
      const { server } = await serveOnTerminal([]);
      const alive = () => {
        try {
          process.kill(server.pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      try {
        // script(1) killed: the terminal serve runs on hangs up, and nothing reads it any more.
        server.child.kill('SIGKILL');
        await vi.waitFor(
          () => {
            expect(alive()).toBe(false);
          },
          { timeout: 5000, interval: 50 },
        );
        expect(existsSync(path.join(profile, 'api.json'))).toBe(false);
        expect(existsSync(path.join(profile, 'core.lock'))).toBe(false);
      } finally {
        if (alive()) process.kill(server.pid, 'SIGKILL');
      }
    },
    30_000,
  );

  it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
    'renews a token by name across a restart: the new one reads what the old hadn’t, and the old gets 401',
    async () => {
      const first = await serve();
      const old = await connect(first.url);
      const { id } = await call<{ id: string }>(old, 'message', { to: 'builder', body: 'Hello' });
      // The reply comes back while the orchestrator reads nothing (as slow as delivery: see above).
      await vi.waitFor(
        async () => {
          const { items } = await call<{ items: Message[] }>(old, 'messages');
          expect(items.some((message) => message.replyTo === id && message.kind === 'text')).toBe(
            true,
          );
        },
        { timeout: 10_000, interval: 50 },
      );
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
    30_000,
  );

  it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
    'stops when told to as it starts, making no token and sending nothing: a message waiting still waits',
    async () => {
      // Builder is mid-turn, and a second message waits behind it.
      const first = await serve();
      const client = await connect(first.url);
      await midTurn(client);
      const { id: behind } = await call<{ id: string }>(client, 'message', {
        to: 'builder',
        body: 'hello behind',
      });
      expect(await first.stop()).toBe(0);
      const tokens = await readFile(path.join(profile, 'tokens.json'), 'utf8');

      // Started again to make a token, its login shell slow to say the environment CLIs run in.
      const shell = path.join(dir, 'slow-shell');
      const reading = path.join(dir, 'shell-reading');
      const release = path.join(dir, 'shell-release');
      // Linux script first invokes $SHELL -c to launch the wrapped command. Only serve's later
      // -ilc environment read may write this gate's parent pid or block startup.
      await writeFile(shell, startupShell(reading, release));
      await chmod(shell, 0o755);
      const { child, printed, exited } = onTerminal([], { SHELL: shell });
      // Told to stop while serve (the shell's parent) reads it.
      const pid = await vi.waitFor(
        async () => {
          const read = Number(await readFile(reading, 'utf8'));
          expect(read).toBeGreaterThan(0);
          return read;
        },
        { timeout: 20_000, interval: 50 },
      );
      // Keep the environment read blocked until serve has acknowledged shutdown. Repeated
      // signals are safe (and say 'stopping already'); no scheduler speed chooses the phase.
      const heard = Promise.withResolvers<undefined>();
      const listen = () => {
        if (printed().includes('stopping already:')) heard.resolve(undefined);
      };
      child.stdout.on('data', listen);
      const signal = () => {
        try {
          process.kill(pid, 'SIGTERM');
        } catch (error) {
          heard.reject(new Error('Could not signal startup shutdown.', { cause: error }));
        }
      };
      const repeatSignal = setInterval(signal, 25);
      try {
        signal();
        await Promise.race([
          heard.promise,
          exited.then(() => {
            throw new Error('serve exited before acknowledging startup shutdown.');
          }),
        ]);
      } finally {
        clearInterval(repeatSignal);
        child.stdout.off('data', listen);
        await writeFile(release, 'go');
      }
      expect(await exited).toBe(0);
      expect(printed()).toContain('stopping…');
      expect(printed()).not.toMatch(/^ {2}[A-Za-z0-9_-]{43}$/m);
      // The orchestrator's token wasn't replaced, and nothing was left behind or sent.
      expect(await readFile(path.join(profile, 'tokens.json'), 'utf8')).toBe(tokens);
      expect(existsSync(path.join(profile, 'api.json'))).toBe(false);
      expect(existsSync(path.join(profile, 'core.lock'))).toBe(false);
      const log = await readFile(codexLog, 'utf8');
      expect(log.split('\n').filter((line) => line.includes('hello behind'))).toEqual([]);

      // The next start that serves delivers it, never told it was cut off.
      const server = await serve();
      const again = await connect(server.url);
      const reply = await waitFor(again, (message) => message.replyTo === behind);
      expect(reply).toMatchObject({ kind: 'text', turn: { status: 'completed' } });
    },
    30_000,
  );

  it('keeps the port it chose, and exits naming a port that is taken', async () => {
    const first = children.spawn(
      process.execPath,
      [BUNDLE, 'serve', '--profile', profile, '--canvas', file],
      cliEnv(),
    );
    let said = '';
    first.stderr.on('data', (chunk: Buffer) => {
      said += chunk.toString();
    });
    const exited = children.exited(first);
    const api = await apiFile(exited, () => said);
    const settings = JSON.parse(await readFile(path.join(profile, 'settings.json'), 'utf8')) as {
      api?: { port?: number };
    };
    expect(settings.api?.port).toBe(api.port);
    first.kill('SIGTERM');
    expect(await exited).toBe(0);

    // Taken by another server meanwhile: it says so, naming the port.
    const squatter = createServer();
    await new Promise<void>((resolve) => squatter.listen(api.port, '127.0.0.1', resolve));
    try {
      const child = children.spawn(
        process.execPath,
        [BUNDLE, 'serve', '--profile', profile, '--canvas', file],
        cliEnv(),
      );
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const code = await children.exited(child);
      expect(code).toBe(1);
      expect(stderr).toContain(String(api.port));
      expect(stderr).toContain('--port');
      expect(existsSync(path.join(profile, 'core.lock'))).toBe(false);
    } finally {
      await new Promise((resolve) => squatter.close(resolve));
    }

    // A port given is kept in its place, so a start without one listens there again.
    const free = createServer();
    await new Promise<void>((resolve) => free.listen(0, '127.0.0.1', resolve));
    const { port } = free.address() as { port: number };
    await new Promise((resolve) => free.close(resolve));
    const given = await serve(['--port', String(port)]);
    expect(given.url).toBe(`http://127.0.0.1:${String(port)}/mcp`);
    expect(await given.stop()).toBe(0);
    const kept = children.spawn(
      process.execPath,
      [BUNDLE, 'serve', '--profile', profile, '--canvas', file],
      cliEnv(),
    );
    const keptExited = children.exited(kept);
    expect((await apiFile(keptExited, () => '')).port).toBe(port);
    kept.kill('SIGTERM');
    expect(await keptExited).toBe(0);
  }, 30_000);

  it.each([
    ['Ctrl-C (SIGINT)', 'SIGINT', false],
    ['its terminal closing (SIGHUP)', 'SIGHUP', false],
    ['SIGTERM, with no one reading what it says any more', 'SIGTERM', true],
  ] as const)(
    'stops cleanly on %s: the message cut off unresolved, its sender told, the profile let go',
    async (_how, signal, deaf) => {
      const server = await serve();
      const client = await connect(server.url);
      const slow = await midTurn(client);
      // Its stderr's reader gone (a pipe to `tee` stopped first), each line it says fails.
      if (deaf) server.child.stderr.destroy();
      server.child.kill(signal);
      expect(await server.exited).toBe(0);
      expect(existsSync(path.join(profile, 'api.json'))).toBe(false);
      expect(existsSync(path.join(profile, 'core.lock'))).toBe(false);
      if (!deaf) {
        // What it told the sender as it stopped is in its log too.
        expect(server.stderr()).toMatch(
          new RegExp(`notice to outside:orchestrator about ${slow}: .*cut off`),
        );
      }
      const items = await messagesAfterRestart();
      expect(items.find((message) => message.id === slow)?.state).toBe('unresolved');
      expect(
        items.find((message) => message.kind === 'notice' && message.replyTo === slow)?.body,
      ).toMatch(/cut off/);
    },
    15_000,
  );

  it('stops cleanly though told again as it stops: it says so, and still lets the profile go', async () => {
    // Builder's session takes a while to close.
    await fakeCodex({ FAKE_CODEX_LINGER: '1500' });
    const server = await serve();
    const client = await connect(server.url);
    const slow = await midTurn(client);
    server.child.kill('SIGINT');
    await vi.waitFor(() => {
      expect(server.stderr()).toContain('stopping…');
    });
    // A second Ctrl-C while it closes Builder's session: never Node's own, which would kill it.
    server.child.kill('SIGINT');
    expect(await server.exited).toBe(0);
    expect(server.child.signalCode).toBeNull();
    expect(server.stderr()).toContain('stopping already');
    expect(existsSync(path.join(profile, 'api.json'))).toBe(false);
    expect(existsSync(path.join(profile, 'core.lock'))).toBe(false);
    // It journaled the run and the message cut off, its sender told.
    const items = await messagesAfterRestart();
    expect(items.find((message) => message.id === slow)?.state).toBe('unresolved');
    expect(
      items.find((message) => message.kind === 'notice' && message.replyTo === slow)?.body,
    ).toMatch(/cut off/);
  }, 15_000);

  it('says, as it starts after a crash, what it cut off, and a run it discarded', async () => {
    const first = await serve();
    const client = await connect(first.url);
    const slow = await midTurn(client);
    first.child.kill('SIGKILL');
    await first.exited;
    await rm(path.join(profile, 'api.json'));
    // Its run, as an older corrallm wrote it.
    writeOnDisk(profile, `UPDATE run SET state = '{"version":1}'`);

    const server = await serve();
    await vi.waitFor(() => {
      expect(server.stderr()).toMatch(
        new RegExp(`\\[m1\\.corral\\] notice to outside:orchestrator about ${slow}: .*cut off`),
      );
    });
    expect(server.stderr()).toMatch(
      /\[m1\.corral\] The run progress could not be restored, so it was discarded \(/,
    );
  }, 30_000);

  it('sets a damaged database aside and serves on from its snapshot, saying so', async () => {
    const first = await serve();
    const client = await connect(first.url);
    const { id } = await call<{ id: string }>(client, 'message', { to: 'builder', body: 'Before' });
    await waitFor(client, (message) => message.replyTo === id);
    await client.close();
    await first.stop();
    // Its file overwritten, as a failing drive or another program might.
    await writeFile(path.join(profile, 'core.db'), 'This is not a database. '.repeat(500));

    const server = await serve();
    expect(server.stderr()).toMatch(
      /\[m1\.corral\] The core’s database was damaged \(file is not a database\), and was moved to .+core\.rejected-[0-9a-f-]{36}\.db\. It was restored from its snapshot of .+: what changed since then is lost\./,
    );
    const again = await connect(server.url);
    // What it kept is there, and it goes on.
    const { items } = await call<{ items: Message[] }>(again, 'messages');
    expect(items.map(({ id: kept }) => kept)).toContain(id);
    const next = await call<{ id: string }>(again, 'message', { to: 'builder', body: 'After' });
    await waitFor(again, (message) => message.replyTo === next.id);
  }, 30_000);

  /** Adds Ghost to the canvas: on a connection this build lacks, so what is sent it waits for you. */
  async function withGhost(): Promise<void> {
    const document = JSON.parse(await readFile(file, 'utf8')) as { nodes: unknown[] };
    document.nodes.push({
      id: 'ghost',
      kind: 'agent',
      label: 'Ghost',
      position: { x: 0, y: 200 },
      adapter: 'codex',
      connection: 'codex.retired',
    });
    await writeFile(file, JSON.stringify(document));
  }

  it('says a need a message makes: one waiting for an agent that can’t start', async () => {
    await withGhost();
    const server = await serve();
    const client = await connect(server.url);
    await call(client, 'message', { to: 'ghost', body: 'Hello' });
    await vi.waitFor(() => {
      expect(server.stderr()).toMatch(/\[m1\.corral\] need on Ghost: Ghost can’t start/);
    });
  }, 15_000);

  it('names its canvas by its file in what it says of a need there as it opens', async () => {
    await withGhost();
    const first = await serve();
    const client = await connect(first.url);
    const { id } = await call<{ id: string }>(client, 'message', { to: 'ghost', body: 'Hello' });
    expect(await first.stop()).toBe(0);

    // Started again, the message still waits for Ghost: said as the canvas opens, by its file.
    const server = await serve();
    expect(server.stderr()).toMatch(/\[m1\.corral\] need on Ghost: \S/);
    expect(server.stderr()).not.toContain(`[${CANVAS}]`);
    const again = await connect(server.url);
    const { items } = await call<{ items: Message[] }>(again, 'messages');
    expect(items.find((message) => message.id === id)?.state).toBe('pending');
  }, 15_000);

  it('watches its canvas’s file: one changed on disk is never read, but reviewed, a need for you', async () => {
    const server = await serve();
    const client = await connect(server.url);
    await withGhost();
    await vi.waitFor(
      () => {
        expect(server.stderr()).toMatch(/\[m1\.corral\] need: m1\.corral changed on disk/);
      },
      { timeout: 5000 },
    );
    const { agents } = await call<{ agents: { id: string }[] }>(client, 'agents');
    expect(agents.map(({ id }) => id)).not.toContain('ghost');
  }, 15_000);

  /** Runs `corrallm wait`: its exit code, and the one line it printed. */
  async function cliWait(
    args: string[],
    env: Record<string, string>,
  ): Promise<{ code: number; line: string }> {
    const full = cliEnv();
    for (const [key, value] of Object.entries(env)) full[key] = value;
    try {
      const { stdout } = await children.run(process.execPath, [BUNDLE, 'wait', ...args], full);
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

    const { id: first } = await call<{ id: string }>(client, 'message', {
      to: 'builder',
      body: 'Hello',
    });
    const { id } = await call<{ id: string }>(client, 'message', { to: 'builder', body: 'Again' });
    // --for waits for what concerns that message alone, and moves no read position.
    const came = await cliWait(['--timeout', '30', '--for', id], env);
    expect(came.code).toBe(0);
    expect(came.line.split('\n').filter(Boolean)).toHaveLength(1);
    const result = JSON.parse(came.line) as { messages: Message[]; next: string };
    expect(result.messages.map(({ replyTo, kind }) => [replyTo, kind])).toEqual([[id, 'text']]);
    expect(result.next).toEqual(expect.any(String));
    const all = await cliWait(['--timeout', '30'], env);
    expect(all.code).toBe(0);
    const everything = JSON.parse(all.line) as { messages: Message[]; next: string };
    expect(everything.messages.map(({ replyTo }) => replyTo)).toEqual([first, id]);

    const nothing = await cliWait(['--timeout', '1', '--after', everything.next], env);
    expect(nothing.code).toBe(1);
    expect(JSON.parse(nothing.line)).toEqual({ messages: [], next: everything.next });

    expect(
      (await cliWait(['--timeout', '1'], { ...env, CORRALLM_OUTSIDE_TOKEN: 'wrong' })).code,
    ).toBe(2);
    expect((await cliWait(['--timeout', '1'], { CORRALLM_URL: server.url })).code).toBe(2);
    expect(
      (await cliWait(['--timeout', '1'], { ...env, CORRALLM_OUTSIDE_TOKEN: EXPIRED })).code,
    ).toBe(2);

    // A wait the server refuses for what it asked is neither a bad token nor a time limit.
    const stale = await cliWait(['--timeout', '1', '--after', 'not-a-cursor'], env);
    expect(stale.code).toBe(5);
    expect(JSON.parse(stale.line)).toMatchObject({ error: { code: 'invalid' } });
    // Nor is a command line that can never work, which says why on stdout too.
    for (const args of [
      ['--timeout', '4000'],
      ['--for', 'abc'],
    ]) {
      const usage = await cliWait(args, env);
      expect(usage.code).toBe(64);
      expect(JSON.parse(usage.line)).toMatchObject({ error: { code: 'invalid' } });
    }

    // Its token goes only to corrallm's own server on this machine.
    for (const url of [
      'http://example.com/mcp',
      'https://127.0.0.1:1/mcp',
      `${server.url}?token=1`,
      server.url.replace('http://', 'http://user:pass@'),
    ]) {
      const elsewhere = await cliWait(['--timeout', '1'], { ...env, CORRALLM_URL: url });
      expect(elsewhere.code, url).toBe(3);
      expect(JSON.parse(elsewhere.line)).toMatchObject({ error: { code: 'unavailable' } });
    }

    await server.stop();
    expect((await cliWait(['--timeout', '1'], env)).code).toBe(3);
    // A dozen runs of the CLI, two of them waiting out a second: more than the default 5 s when
    // the machine is busy.
  }, 20_000);

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
    const server = await serve([], { HOME: home, XDG_CONFIG_HOME: '' });
    expect((await cliWait(['--timeout', '0'], env)).code).toBe(1);
    // On the app's profile, CORRALLM_URL isn't needed: it says nothing of it.
    expect(server.stderr()).not.toContain('CORRALLM_URL');
    await server.stop();
    expect(existsSync(path.join(appProfile, 'api.json'))).toBe(false);

    // One left by a process that is gone finds nothing, nor one whose pid another process has
    // since been given (this one, which started an hour after the server it names), though
    // something listens on its port now.
    const squatter = createHttpServer((_request, response) => {
      response.writeHead(401).end();
    });
    await new Promise<void>((resolve) => squatter.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = squatter.address() as { port: number };
      const url = `http://127.0.0.1:${String(port)}/mcp`;
      await writeFile(
        path.join(appProfile, 'api.json'),
        JSON.stringify({ url, port, pid: 999_999, started: Date.now() }),
      );
      expect((await cliWait(['--timeout', '0'], env)).code).toBe(3);
      const before = Date.now() - process.uptime() * 1000 - HOUR;
      await writeFile(
        path.join(appProfile, 'api.json'),
        JSON.stringify({ url, port, pid: process.pid, started: before }),
      );
      expect((await cliWait(['--timeout', '0'], env)).code).toBe(3);
    } finally {
      await new Promise((resolve) => squatter.close(resolve));
    }
  }, 30_000);

  async function copyDir(from: string, to: string): Promise<void> {
    await children.run('cp', ['-R', from, to]);
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
  }, 30_000);

  it('tells apart two canvases whose files share a name, by their ids', async () => {
    // The second canvas kept in a file named as the first's, in another folder.
    await mkdir(path.join(dir, 'other'));
    const twin = path.join(dir, 'other', 'm1.corral');
    await copyFile(path.join(dir, 'second.corral'), twin);
    await keepCanvases(profile, { [SECOND]: { file: twin, project: path.join(dir, 'project') } });
    const server = await serve(['--canvas', twin]);
    expect(server.stderr()).toContain(`serving m1.corral (${CANVAS}), m1.corral (${SECOND}) at`);
    const client = await connect(server.url, SECOND_ONLY);
    const { id } = await call<{ id: string }>(client, 'message', { to: 'builder', body: 'Hi' });
    await vi.waitFor(() => {
      expect(server.stderr()).toContain(`[m1.corral ${SECOND}] message ${id}`);
    });
  }, 15_000);

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
  }, 15_000);

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
    const { stdout } = await children.run('ps', ['-A', '-ww', '-o', 'pid=,ppid=,args=']);
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
    const descendantRows = rows.filter(
      ([, pid]) => descendants.has(Number(pid)) && Number(pid) !== server.pid,
    );
    expect(descendantRows.some(([, , , args]) => args?.includes('fake-codex.mjs'))).toBe(true);
    for (const [, , , args] of descendantRows) expect(args).not.toContain(TOKEN);

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
  }, 30_000);
});
