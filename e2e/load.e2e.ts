import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { expect, test } from '@playwright/test';

import { toolName } from '../src/shared/api/registry';
import { keepCanvases } from '../src/main/core/store/test-store';

/*
 * Gate G2 of the core's database (Core Database §8; the Build Plan's load test, B11's, built here
 * first): the core's event loop stays within budget, p99 under 25 ms and max under 100 ms, under a
 * burst of messages, waits and run saves, with every commit on the drive before it resolves (its
 * log flushed off the loop, F_FULLFSYNC on macOS) and its log checkpointed when idle, and begun
 * anew, on a thread of its own (and at least every 30 s under load: the burst outlasts that). On a
 * quiet drive: while another program writes heavily to it, a commit's own writes into the log,
 * which run on the loop, can stall it past 100 ms (store.ts).
 * Until B11 the app's core process serves none of `message`, `wait` or `run.pause` (UNHOSTED; nor
 * MCP), so the core runs here as `corrallm serve` runs it, under plain Node (the CLI bundle the
 * global setup builds), its loop measured from inside (loop-delay.mjs), while outside orchestrators
 * (MCP clients in this test's process) send its agents messages, wait for their replies, and pause
 * and release an agent. Its agents run a fake `codex`.
 */

const projectDir = path.dirname(import.meta.dirname);
const BUNDLE = path.join(projectDir, 'dist-cli', 'corrallm.cjs');
const PROBE = path.join(projectDir, 'e2e', 'loop-delay.mjs');
const FAKE_CODEX = path.join(projectDir, 'src', 'main', 'sessions', 'codex', 'fake-codex.mjs');

const CANVAS = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4c01';
const AGENTS = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'];
/** The agent the run pauses and releases, which is sent nothing. */
const IDLE = 'idle';
const PARTIES = ['first', 'second', 'third', 'fourth'];
/** How long the burst lasts: past the longest the store goes without checkpointing its log. */
const BURST_MS = 35_000;
/** Each party's senders, each sending a message every SEND_EVERY_MS: 20 a second a party. */
const SENDERS = 4;
const SEND_EVERY_MS = 200;
const WAITERS = 2;
const TOGGLE_EVERY_MS = 100;

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let dir: string;
let serve: ChildProcess | undefined;

test.beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'corrallm-e2e-load-'));
});

test.afterEach(async () => {
  if (serve?.exitCode === null && serve.signalCode === null) serve.kill('SIGKILL');
  serve = undefined;
  await rm(dir, { recursive: true, force: true });
});

/** A profile keeping the canvas and its folder, as the app would, and a token for each party. */
async function profileOf(): Promise<{ profile: string; file: string; tokens: string[] }> {
  const profile = path.join(dir, 'profile');
  const project = path.join(dir, 'project');
  await mkdir(profile, { mode: 0o700 });
  await mkdir(project);
  const file = path.join(dir, 'load.corral');
  await writeFile(
    file,
    JSON.stringify({
      format: 'corrallm',
      version: 2,
      id: CANVAS,
      nodes: [...AGENTS, IDLE].map((id, i) => ({
        id,
        kind: 'agent',
        label: id,
        position: { x: 0, y: i * 100 },
        adapter: 'codex',
        connection: 'codex.app-server',
      })),
      links: [],
    }),
  );
  await keepCanvases(profile, { [CANVAS]: { file, project } });
  const tokens = PARTIES.map((name) => `known-load-token-of-${name}-0123456789abcdef`);
  const expires = Date.now() + 60 * 60 * 1000;
  await writeFile(
    path.join(profile, 'tokens.json'),
    JSON.stringify({
      version: 2,
      tokens: Object.fromEntries(
        tokens.map((token, i) => [
          sha256(token),
          { id: PARTIES[i], name: PARTIES[i], canvases: [CANVAS], access: 'write', expires },
        ]),
      ),
    }),
  );
  return { profile, file, tokens };
}

/** Starts `corrallm serve` with its loop measured: its URL, once it writes api.json. */
async function start(profile: string, file: string): Promise<string> {
  const codex = path.join(dir, 'codex');
  await writeFile(
    codex,
    `#!/bin/sh\nFAKE_CODEX_STATE="${path.join(dir, 'threads.json')}" exec "${process.execPath}" "${FAKE_CODEX}" "$@"\n`,
  );
  await chmod(codex, 0o755);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CORRALLM_CODEX_PATH: codex,
    CORRALLM_CLAUDE_PATH: path.join(dir, 'no-claude'),
    LOOP_DELAY_FILE: path.join(dir, 'loop.json'),
  };
  delete env.CORRALLM_URL;
  delete env.CORRALLM_OUTSIDE_TOKEN;
  const child = spawn(
    process.execPath,
    ['--import', PROBE, BUNDLE, 'serve', '--profile', profile, '--canvas', file, '--port', '0'],
    { env, stdio: ['ignore', 'ignore', 'pipe'] },
  );
  serve = child;
  let said = '';
  child.stderr.on('data', (chunk: Buffer) => {
    said += chunk.toString();
  });
  const api = path.join(profile, 'api.json');
  for (let tries = 0; tries < 600; tries++) {
    if (existsSync(api)) {
      try {
        return (JSON.parse(await readFile(api, 'utf8')) as { url: string }).url;
      } catch {
        // Being written.
      }
    }
    if (child.exitCode !== null) throw new Error(`serve exited: ${said}`);
    await sleep(50);
  }
  throw new Error(`serve never wrote api.json: ${said}`);
}

async function connect(url: string, token: string): Promise<Client> {
  const client = new Client({ name: 'load', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }) as Transport,
  );
  return client;
}

/** Calls a tool: its structured result, or undefined if it was refused (its sentence in `refusals`). */
async function call<T>(
  client: Client,
  name: string,
  args: Record<string, unknown>,
  refusals: string[],
): Promise<T | undefined> {
  const result = (await client.callTool({ name: toolName(name), arguments: args }, undefined, {
    timeout: 60_000,
  })) as CallToolResult;
  if (result.isError === true) {
    const [said] = result.content as { text: string }[];
    refusals.push(said?.text ?? '');
    return undefined;
  }
  return result.structuredContent as T;
}

/** The core's loop delay over the burst, in ms, as loop-delay.mjs measured it. */
async function measured(): Promise<{ p50: number; p99: number; max: number; samples: number }> {
  const file = path.join(dir, 'loop.json');
  for (let tries = 0; tries < 100 && !existsSync(file); tries++) await sleep(20);
  return JSON.parse(await readFile(file, 'utf8')) as {
    p50: number;
    p99: number;
    max: number;
    samples: number;
  };
}

test('keeps the core’s event loop within budget under a burst of messages, waits and run saves', async () => {
  test.setTimeout(180_000);
  const { profile, file, tokens } = await profileOf();
  const url = await start(profile, file);
  const clients = await Promise.all(tokens.map((token) => connect(url, token)));
  const refusals: string[] = [];
  const done = { sent: 0, replies: 0, toggles: 0 };

  // Every agent's session started, outside the burst.
  const [first] = clients;
  if (!first) throw new Error('No client');
  await Promise.all(
    AGENTS.map((to) => call(first, 'message', { canvas: CANVAS, to, body: 'Warm up' }, refusals)),
  );
  for (let replies = 0; replies < AGENTS.length;) {
    const got = await call<{ messages: { kind: string }[] }>(
      first,
      'wait',
      { timeoutSeconds: 30 },
      refusals,
    );
    replies += got?.messages.filter(({ kind }) => kind === 'text').length ?? 0;
  }

  serve?.kill('SIGUSR2');
  const end = Date.now() + BURST_MS;
  const body = (n: number) => `Load ${String(n)}: ${'x'.repeat(200 + ((n * 997) % 3800))}`;
  const work: Promise<void>[] = [];
  for (const [p, client] of clients.entries()) {
    for (let s = 0; s < SENDERS; s++) {
      work.push(
        (async () => {
          for (let n = s; Date.now() < end; n += SENDERS) {
            const to = AGENTS[(p + n) % AGENTS.length];
            const sent = await call(
              client,
              'message',
              { canvas: CANVAS, to, body: body(n) },
              refusals,
            );
            if (sent) done.sent += 1;
            await sleep(SEND_EVERY_MS);
          }
        })(),
      );
    }
    for (let w = 0; w < WAITERS; w++) {
      work.push(
        (async () => {
          while (Date.now() < end) {
            const got = await call<{ messages: { kind: string }[] }>(
              client,
              'wait',
              { timeoutSeconds: 1 },
              refusals,
            );
            done.replies += got?.messages.filter(({ kind }) => kind === 'text').length ?? 0;
          }
        })(),
      );
    }
  }
  work.push(
    (async () => {
      for (let paused = false; Date.now() < end; paused = !paused) {
        const op = paused ? 'run.unpause' : 'run.pause';
        if (await call(first, op, { canvas: CANVAS, target: { agent: IDLE } }, refusals)) {
          done.toggles += 1;
        }
        await sleep(TOGGLE_EVERY_MS);
      }
    })(),
  );
  await sleep(BURST_MS);
  serve?.kill('SIGUSR2');
  await Promise.all(work);
  const delay = await measured();
  for (const client of clients) await client.close();

  console.log(
    `G2: loop delay p50 ${delay.p50.toFixed(2)} ms, p99 ${delay.p99.toFixed(2)} ms, max ${delay.max.toFixed(2)} ms over ${String(delay.samples)} samples; ${String(done.sent)} messages sent, ${String(done.replies)} replies waited for, ${String(done.toggles)} pauses and releases, ${String(refusals.length)} calls refused`,
  );
  // The burst was one: every party's messages went, and came back.
  expect(done.sent).toBeGreaterThan(1000);
  expect(done.replies).toBeGreaterThan(1000);
  expect(done.toggles).toBeGreaterThan(100);
  expect(delay.p99).toBeLessThan(25);
  expect(delay.max).toBeLessThan(100);

  const exited = new Promise((resolve) => serve?.once('exit', resolve));
  serve?.kill('SIGTERM');
  expect(await exited).toBe(0);
});
