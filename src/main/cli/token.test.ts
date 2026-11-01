import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TOKEN_REPLACED } from '../../shared/api/errors';
import { toolName } from '../../shared/api/registry';
import { keepCanvases } from '../core/store/test-store';
import { TestChildren } from './test-children';
import type { TestChild } from './test-children';

/*
 * `corrallm token new|renew|revoke` (Build Plan B30), as a person runs them: the CLI bundle
 * (dist-cli/corrallm.cjs, which the vitest `main` project's global setup builds) on a terminal
 * (script(1): a pty), against a running `corrallm serve` on a profile of its own (entry.test.ts
 * runs it against the app's core), or with nothing owning the profile. A token works, or stops
 * working, at once, with no restart; it is shown once, or only written to a 0600 file the person
 * names, and never appears in an argument, a log or a result.
 */

const BUNDLE = path.resolve('dist-cli/corrallm.cjs');
const FAKE_CODEX = path.resolve('src/main/sessions/codex/fake-codex.mjs');
const FAKE_CLAUDE = path.resolve('e2e/fake-claude.mjs');
const CANVAS = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b01';
const TOKEN_LINE = /^ {2}([A-Za-z0-9_-]{43})$/m;
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const execute = promisify(execFile);

describe.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'corrallm token',
  () => {
    let dir: string;
    let profile: string;
    let file: string;
    let children: TestChildren;
    let clients: Client[];
    /** Every token made: none may be in a child's arguments, serve's log or a tool's result. */
    let made: string[];
    let results: string[];

    beforeEach(async () => {
      children = new TestChildren();
      clients = [];
      made = [];
      results = [];
      dir = await mkdtemp(path.join(tmpdir(), 'corrallm-token-'));
      profile = path.join(dir, 'profile');
      await mkdir(profile, { mode: 0o700 });
      const project = path.join(dir, 'project');
      await mkdir(project);
      file = path.join(dir, 'm1.corral');
      await writeFile(
        file,
        JSON.stringify({
          format: 'corrallm',
          version: 2,
          id: CANVAS,
          nodes: [
            {
              id: 'builder',
              kind: 'agent',
              label: 'Builder',
              position: { x: 0, y: 0 },
              adapter: 'codex',
              connection: 'codex.app-server',
            },
          ],
          links: [],
        }),
      );
      await keepCanvases(profile, { [CANVAS]: { file, project } });
      const codex = path.join(dir, 'codex');
      await writeFile(
        codex,
        `#!/bin/sh\nFAKE_CODEX_STATE="${path.join(dir, 'threads.json')}" exec "${process.execPath}" "${FAKE_CODEX}" "$@"\n`,
      );
      await chmod(codex, 0o755);
    });

    afterEach(async () => {
      await children.close();
      for (const client of clients) await client.close().catch(() => undefined);
      for (const result of results) {
        for (const token of made) expect(result).not.toContain(token);
      }
      await rm(dir, { recursive: true, force: true });
    }, 15_000);

    /** The environment the CLI runs in: the fake `codex` and `claude`, no token, and `extra`. */
    function cliEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
      const env: NodeJS.ProcessEnv = { ...process.env };
      delete env.CORRALLM_URL;
      // This fixture runs the outside orchestrator, not one of corrallm's agents.
      delete env.CORRALLM_AGENT_SESSION;
      delete env.CORRALLM_OUTSIDE_TOKEN;
      delete env.CORRALLM_OUTSIDE_TOKEN_FILE;
      return {
        ...env,
        CORRALLM_AGENT_PATHS: JSON.stringify({
          codex: path.join(dir, 'codex'),
          'claude-code': FAKE_CLAUDE,
        }),
        ...extra,
      };
    }

    /** `corrallm token <args>` on the profile, on a terminal: what it printed, and its exit. */
    async function token(args: string[]): Promise<{ code: number | null; printed: string }> {
      const { printed, exited } = children.terminal(
        [process.execPath, BUNDLE, 'token', ...args, '--profile', profile],
        cliEnv(),
      );
      const code = await exited;
      return { code, printed: printed() };
    }

    /** `corrallm token new` on a terminal, expecting a token shown: it. */
    async function newToken(args: string[] = []): Promise<{ token: string; printed: string }> {
      const { code, printed } = await token(['new', '--canvas', file, '--name', 'bot', ...args]);
      expect(code, printed).toBe(0);
      const value = TOKEN_LINE.exec(printed)?.[1] ?? '';
      expect(value).not.toBe('');
      made.push(value);
      return { token: value, printed };
    }

    interface Serve {
      child: TestChild;
      url: string;
      pid: number;
      stderr: () => string;
    }

    /** Starts `corrallm serve` on the profile (no token of its own), once it serves. */
    async function serve(): Promise<Serve> {
      const child = children.spawn(
        process.execPath,
        [BUNDLE, 'serve', '--profile', profile, '--canvas', file, '--port', '0'],
        cliEnv(),
      );
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      await vi.waitFor(
        () => {
          expect(stderr).toContain('corrallm serve: serving ');
        },
        { timeout: 20_000, interval: 50 },
      );
      const api = JSON.parse(await readFile(path.join(profile, 'api.json'), 'utf8')) as {
        url: string;
        pid: number;
      };
      return { child, url: api.url, pid: api.pid, stderr: () => stderr };
    }

    async function connect(url: string, value: string): Promise<Client> {
      const client = new Client({ name: 'orchestrator', version: '1' });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(url), {
          requestInit: { headers: { Authorization: `Bearer ${value}` } },
        }),
      );
      clients.push(client);
      return client;
    }

    async function agents(client: Client): Promise<unknown[]> {
      const result = (await client.callTool({
        name: toolName('agents'),
        arguments: {},
      })) as CallToolResult;
      results.push(JSON.stringify(result));
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      return (result.structuredContent as { agents: unknown[] }).agents;
    }

    /** A raw tools/list as `value`: the status and body it is answered with. */
    function list(url: string, value: string): Promise<{ status: number; body: string }> {
      return new Promise((resolve, reject) => {
        const sent = request(
          url,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${value}`,
              'Content-Type': 'application/json',
              Accept: 'application/json, text/event-stream',
            },
          },
          (response) => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk: string) => {
              body += chunk;
            });
            response.on('end', () => {
              resolve({ status: response.statusCode ?? 0, body });
            });
          },
        );
        sent.once('error', reject);
        sent.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
      });
    }

    const kept = async () =>
      JSON.parse(await readFile(path.join(profile, 'tokens.json'), 'utf8')) as {
        tokens: Record<string, { name: string; canvases: string[]; access: string }>;
      };

    /** Every running process's arguments, as `ps` sees them. */
    async function everyonesArguments(): Promise<string> {
      return (await execute('ps', ['-A', '-o', 'args='], { maxBuffer: 16 * 1024 * 1024 })).stdout;
    }

    it('refuses to make, renew or revoke a token without a terminal, making nothing', async () => {
      const before = existsSync(path.join(profile, 'tokens.json'))
        ? await readFile(path.join(profile, 'tokens.json'), 'utf8')
        : undefined;
      for (const args of [
        ['new', '--canvas', file],
        ['renew', '--name', 'bot'],
        ['revoke', '--name', 'bot'],
      ]) {
        const child = children.spawn(
          process.execPath,
          [BUNDLE, 'token', ...args, '--profile', profile],
          cliEnv(),
        );
        let stderr = '';
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        expect(await children.exited(child)).toBe(1);
        expect(stderr).toMatch(/only on a terminal/);
      }
      const after = existsSync(path.join(profile, 'tokens.json'))
        ? await readFile(path.join(profile, 'tokens.json'), 'utf8')
        : undefined;
      expect(after).toBe(before);
      expect(existsSync(path.join(profile, 'core.lock'))).toBe(false);
    }, 30_000);

    it('makes a token against a running serve, which takes it at once: shown once, kept as its hash, in no argument or log', async () => {
      const server = await serve();
      const { token: value, printed } = await newToken(['--hours', '2']);
      expect(printed.split(value)).toHaveLength(2);
      expect(printed).toContain('corrallm serve, which owns the profile');
      expect(printed).toContain(`reaching m1.corral (${CANVAS})`);
      expect(printed).toContain(
        `claude mcp add --transport http corrallm-server ${server.url} --header 'Authorization: Bearer \${CORRALLM_OUTSIDE_TOKEN}'`,
      );
      expect(printed).toContain(
        `codex mcp add corrallm-server --url ${server.url} --bearer-token-env-var CORRALLM_OUTSIDE_TOKEN`,
      );
      const store = await kept();
      expect(JSON.stringify(store)).not.toContain(value);
      expect(store.tokens[sha256(value)]).toMatchObject({
        name: 'bot',
        canvases: [CANVAS],
        access: 'write',
      });

      // The same serve, never restarted, takes it.
      expect(await agents(await connect(server.url, value))).toHaveLength(1);
      expect(JSON.parse(await readFile(path.join(profile, 'api.json'), 'utf8'))).toMatchObject({
        pid: server.pid,
      });
      await vi.waitFor(() => {
        expect(server.stderr()).toContain('corrallm token made a token for "bot"');
      });
      expect(server.stderr()).not.toContain(value);
      expect(await everyonesArguments()).not.toContain(value);
    }, 60_000);

    it('renews a token against serve at once: a wait the old one has going ends, its next call is refused with TOKEN_REPLACED, and the new one works', async () => {
      const server = await serve();
      const { token: old } = await newToken();
      const client = await connect(server.url, old);
      const going = client.callTool(
        { name: toolName('wait'), arguments: { timeoutSeconds: 60 } },
        undefined,
        { timeout: 90_000 },
      ) as Promise<CallToolResult>;

      const { code, printed } = await token(['renew', '--name', 'bot', '--hours', '3']);
      expect(code, printed).toBe(0);
      const renewed = TOKEN_LINE.exec(printed)?.[1] ?? '';
      made.push(renewed);
      expect(printed).toContain('a renewed token for "bot" (read-write, for 3 hours');

      const ended = await going;
      results.push(JSON.stringify(ended));
      expect(ended.isError).toBe(true);
      expect((ended.content as { text: string }[])[0]?.text).toBe(TOKEN_REPLACED);
      expect(await list(server.url, old)).toEqual({
        status: 401,
        body: JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32001, message: TOKEN_REPLACED },
          id: null,
        }),
      });
      // corrallm wait says so too, exiting 2 as for any token refused.
      const waited = await execute(process.execPath, [BUNDLE, 'wait', '--timeout', '0'], {
        env: cliEnv({ CORRALLM_URL: server.url, CORRALLM_OUTSIDE_TOKEN: old }),
      }).catch((error: unknown) => error as { code: number; stdout: string });
      expect(waited).toMatchObject({ code: 2 });
      expect(JSON.parse((waited as { stdout: string }).stdout)).toEqual({
        error: { code: 'refused', sentence: TOKEN_REPLACED },
      });
      expect(await agents(await connect(server.url, renewed))).toHaveLength(1);
      expect(JSON.parse(await readFile(path.join(profile, 'api.json'), 'utf8'))).toMatchObject({
        pid: server.pid,
      });
      expect(server.stderr()).not.toContain(renewed);
    }, 90_000);

    it('revokes a token against serve at once, and says there is none to revoke after', async () => {
      const server = await serve();
      const { token: value } = await newToken();
      expect(await agents(await connect(server.url, value))).toHaveLength(1);
      const revoked = await token(['revoke', '--name', 'bot']);
      expect(revoked.code, revoked.printed).toBe(0);
      expect(revoked.printed).toContain('the token "bot" is revoked');
      expect((await list(server.url, value)).status).toBe(401);
      expect(Object.keys((await kept()).tokens)).not.toContain(sha256(value));
      const again = await token(['revoke', '--name', 'bot']);
      expect(again.code).toBe(1);
      expect(again.printed).toContain('No live token is named “bot”');
    }, 60_000);

    it('writes a token only into a 0600 file with --into, never showing it, and its headers helper reads the current one across a renewal', async () => {
      const server = await serve();
      const into = path.join(dir, 'My Tokens', 'corrallm');
      await mkdir(path.dirname(into));
      const first = await token(['new', '--canvas', file, '--name', 'bot', '--into', into]);
      expect(first.code, first.printed).toBe(0);
      expect(first.printed).not.toMatch(TOKEN_LINE);
      expect((await stat(into)).mode & 0o777).toBe(0o600);
      const value = (await readFile(into, 'utf8')).trim();
      made.push(value);
      expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(first.printed).not.toContain(value);
      expect(first.printed).toContain(`It is written only to ${into}`);
      expect(first.printed).toContain(
        `claude mcp add-json corrallm-server '{"type":"http","url":"${server.url}","headersHelper":"corrallm token header --from \\"${into}\\""}'`,
      );
      // Codex reads its token from a variable as it starts: from the file, then.
      expect(first.printed).toContain(
        `codex mcp add corrallm-server --url ${server.url} --bearer-token-env-var CORRALLM_OUTSIDE_TOKEN`,
      );

      /** What the helper a client runs at each connect prints: the current token's header. */
      const helper = async () => {
        const { stdout, stderr } = await execute(
          process.execPath,
          [BUNDLE, 'token', 'header', '--from', into],
          { env: cliEnv() },
        );
        expect(stderr).toBe('');
        return JSON.parse(stdout) as { Authorization: string };
      };
      /** A client that reads its header from the helper each time it connects. */
      const connectWithHelper = async () => {
        const { Authorization } = await helper();
        return connect(server.url, Authorization.replace(/^Bearer /, ''));
      };
      expect(await helper()).toEqual({ Authorization: `Bearer ${value}` });
      expect(await agents(await connectWithHelper())).toHaveLength(1);

      const second = await token(['renew', '--name', 'bot', '--into', into]);
      expect(second.code, second.printed).toBe(0);
      const renewed = (await readFile(into, 'utf8')).trim();
      made.push(renewed);
      expect(renewed).not.toBe(value);
      expect(second.printed).not.toContain(renewed);
      expect((await stat(into)).mode & 0o777).toBe(0o600);
      expect((await list(server.url, value)).status).toBe(401);
      // Reconnecting, the client's helper gives the renewed token: nothing to restart.
      expect(await agents(await connectWithHelper())).toHaveLength(1);
      // corrallm wait reads the file afresh too.
      const waited = await execute(process.execPath, [BUNDLE, 'wait', '--timeout', '0'], {
        env: cliEnv({ CORRALLM_URL: server.url, CORRALLM_OUTSIDE_TOKEN_FILE: into }),
      }).catch((error: unknown) => error as { code: number });
      expect((waited as { code?: number }).code).toBe(1);

      // A file others may read gives no header.
      await chmod(into, 0o644);
      const refused = await execute(process.execPath, [BUNDLE, 'token', 'header', '--from', into], {
        env: cliEnv(),
      }).catch((error: unknown) => error as { code: number; stdout: string; stderr: string });
      expect(refused).toMatchObject({ code: 1, stdout: '' });
      expect((refused as { stderr: string }).stderr).toMatch(/yours alone/);
      expect(server.stderr()).not.toContain(value);
      expect(server.stderr()).not.toContain(renewed);
    }, 90_000);

    it('with nothing owning the profile, writes tokens.json itself under core.lock, and the next serve takes it', async () => {
      const { token: value, printed } = await newToken();
      expect(printed).toContain('corrallm token itself, as nothing owns the profile');
      expect(existsSync(path.join(profile, 'core.lock'))).toBe(false);
      expect(existsSync(path.join(profile, 'token.sock'))).toBe(false);
      expect((await kept()).tokens[sha256(value)]).toMatchObject({ name: 'bot' });
      const server = await serve();
      expect(await agents(await connect(server.url, value))).toHaveLength(1);
    }, 60_000);

    it('makes a --no-merge token, said as read-write with no merge, and renews it as one', async () => {
      const { token: value, printed } = await newToken(['--no-merge']);
      expect(printed).toContain('a new token for "bot" (read-write, no merge, for 1 hour');
      expect((await kept()).tokens[sha256(value)]).toMatchObject({ access: 'write-no-merge' });
      const renewal = await token(['renew', '--name', 'bot']);
      expect(renewal.code, renewal.printed).toBe(0);
      made.push(TOKEN_LINE.exec(renewal.printed)?.[1] ?? '');
      expect(renewal.printed).toContain(
        'a renewed token for "bot" (read-write, no merge, for 1 hour',
      );
      expect(Object.values((await kept()).tokens)).toEqual([
        expect.objectContaining({ name: 'bot', access: 'write-no-merge' }),
      ]);
    }, 60_000);

    it('refuses a canvas corrallm doesn’t keep in that file, making nothing', async () => {
      const server = await serve();
      const copy = path.join(dir, 'copy.corral');
      await copyFile(file, copy);
      const { code, printed } = await token(['new', '--canvas', copy]);
      expect(code).toBe(1);
      expect(printed).toContain('copy.corral is a copy of a canvas corrallm keeps');
      expect(printed).not.toMatch(TOKEN_LINE);
      expect(existsSync(path.join(profile, 'tokens.json'))).toBe(false);
      expect(server.stderr()).toContain('corrallm token was refused');
    }, 60_000);
  },
);
