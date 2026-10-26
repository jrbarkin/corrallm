import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { expect, test } from '@playwright/test';

import { TOKEN_WRITES_PER_SECOND } from '../src/shared/api/limits';
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
 * The core runs here as `corrallm serve` runs it, under plain Node (the CLI bundle the
 * global setup builds), its loop measured from inside (loop-delay.mjs), while outside orchestrators
 * (MCP clients in this test's process) send its agents messages, wait for their replies, and pause
 * and release an agent; and, part way through, another sends 200 doc ops (Core Server §7.4, B9
 * Design §11), whose commits on the canvas serialize at its log's flush (B9 Design §3). Its agents
 * run a fake `codex`.
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
/** The outside party that edits the canvas, on a token of its own. */
const BUILDER = 'builder';
/** How many doc ops it sends, and when, into the burst. */
const DOC_OPS = 200;
const DOC_OPS_AT = 10_000;
/**
 * How it paces them, as an orchestrator under its token's limits would (throttle.ts): sent back to
 * back, they would pass TOKEN_WRITES_PER_SECOND within a second and be refused. So they go in LANES
 * of work, each one op at a time, one op from each lane every WAVE_EVERY_MS: LANES in flight at
 * once (within TOKEN_IN_FLIGHT), queued at the canvas's commits, and a wave's worth of writes a
 * second under the limit (24 a second).
 */
const LANES = 6;
const WAVE_EVERY_MS = (LANES * 1000) / (TOKEN_WRITES_PER_SECOND - LANES);

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

/**
 * A profile keeping the canvas and its folder, as the app would, and a token for each party: those
 * sending messages, then the builder.
 */
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
  const names = [...PARTIES, BUILDER];
  const tokens = names.map((name) => `known-load-token-of-${name}-0123456789abcdef`);
  const expires = Date.now() + 60 * 60 * 1000;
  await writeFile(
    path.join(profile, 'tokens.json'),
    JSON.stringify({
      version: 2,
      tokens: Object.fromEntries(
        tokens.map((token, i) => [
          sha256(token),
          { id: names[i], name: names[i], canvases: [CANVAS], access: 'write', expires },
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
    CORRALLM_AGENT_PATHS: JSON.stringify({
      codex: codex,
      'claude-code': path.join(dir, 'no-claude'),
    }),
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
    }),
  );
  return client;
}

/** A canvas as canvas.get gives it, as far as the test reads it. */
interface CanvasState {
  arrange: boolean;
  nodes: {
    id: string;
    data: { label: string; queue?: ({ id: string } & Record<string, unknown>)[] };
  }[];
  links: { source: string; target: string }[];
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

interface Delay {
  p50: number;
  p99: number;
  max: number;
  samples: number;
}

/**
 * The core's loop delay over the burst, in ms, as loop-delay.mjs measured it: the whole, and each
 * of its `spans` (between two SIGUSR2s), once it has written them all.
 */
async function measured(spans: number): Promise<Delay & { spans: Delay[] }> {
  const file = path.join(dir, 'loop.json');
  for (let tries = 0; tries < 100; tries++) {
    if (existsSync(file)) {
      const delay = JSON.parse(await readFile(file, 'utf8')) as Delay & { spans: Delay[] };
      if (delay.spans.length === spans) return delay;
    }
    await sleep(20);
  }
  throw new Error('loop-delay.mjs never wrote what it measured');
}

/** The `p`th percentile of `values`, by nearest rank. */
function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] ?? NaN;
}

/** What one lane of the builder's doc ops left on the canvas, as it expects to find it. */
interface Built {
  /** The agent it made, its name, and the queue items it added there, in their order. */
  agent: string;
  label: string;
  items: { id: string; message?: string; seconds?: number }[];
  /** The agent already there it named and added items to, and what it named it. */
  other: string;
  otherLabel?: string;
  queued: string[];
}

/**
 * The builder's DOC_OPS doc ops, in LANES: each makes an agent (half with canvas.addAgent, half
 * spawned linked from another lane's, so the token links only agents it made: R13), then names
 * and moves it, adds, changes, moves and removes items in its queue, and adds to the queue of an
 * agent already there; the first lane also turns Arrange on and off. Nothing a rule would refuse
 * or make a proposal (no deletes, R4; no links between agents that were there, R13; within R11's
 * cap of agents made). What each lane left, how long each op took, from its call to its result,
 * how long they took together, and why any failed.
 */
async function build(client: Client): Promise<{
  lanes: Built[];
  arrange: boolean | undefined;
  latencies: number[];
  took: number;
  failed: string[];
}> {
  const latencies: number[] = [];
  const failed: string[] = [];
  const start = Date.now();
  let arrange: boolean | undefined;
  const made = Array.from({ length: LANES }, () => {
    let resolve: (agent: string) => void = () => undefined;
    const agent = new Promise<string>((done) => (resolve = done));
    return { agent, resolve };
  });
  const lane = async (i: number, built: Built): Promise<void> => {
    const count = Math.floor(DOC_OPS / LANES) + (i < DOC_OPS % LANES ? 1 : 0);
    let sent = 0;
    let wave = 0;
    /** One doc op, in the lane's next wave: its result, or it throws, saying why it failed. */
    const send = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
      wave = Math.max(wave, Math.ceil((Date.now() - start) / WAVE_EVERY_MS));
      await sleep(start + wave * WAVE_EVERY_MS - Date.now());
      wave += 1;
      sent += 1;
      const began = performance.now();
      const result = (await client.callTool(
        { name: toolName(name), arguments: { canvas: CANVAS, request: randomUUID(), ...args } },
        undefined,
        { timeout: 60_000 },
      )) as CallToolResult;
      latencies.push(performance.now() - began);
      const content = result.structuredContent;
      if (result.isError === true || content === undefined || 'proposed' in content) {
        const [said] = result.content as { text?: string }[];
        throw new Error(`${name}: ${said?.text ?? JSON.stringify(content)}`);
      }
      return content as T;
    };
    const newest = (has: 'message' | 'seconds') => built.items.findLast((item) => has in item);
    if (i < LANES / 2) {
      const { id } = await send<{ id: string }>('canvas.addAgent', {
        at: { x: 1000 + i * 400, y: 0 },
        adapter: 'codex',
      });
      built.agent = id;
    } else {
      built.otherLabel = `Worker ${built.other}`;
      await send('canvas.rename', { node: built.other, label: built.otherLabel });
      const from = await made[i - LANES / 2]?.agent;
      const { id } = await send<{ id: string }>('canvas.spawnAgent', { from, relation: 'linked' });
      built.agent = id;
    }
    made[i]?.resolve(built.agent);
    const partner = await made[(i + LANES / 2) % LANES]?.agent;
    for (let step = 0; sent < count; step++) {
      const [first] = built.items;
      const last = built.items.at(-1);
      switch (step % 10) {
        case 0: {
          const message = `Task ${String(i)}.${String(step)}`;
          const { id } = await send<{ id: string }>('queue.add', {
            agent: built.agent,
            entry: { message },
          });
          built.items.push({ id, message });
          break;
        }
        case 1: {
          const seconds = 60 + step;
          const { id } = await send<{ id: string }>('queue.add', {
            agent: built.agent,
            entry: { delay: { seconds } },
          });
          built.items.push({ id, seconds });
          break;
        }
        case 2:
          built.label = `Worker ${String(i)}.${String(step)}`;
          await send('canvas.rename', { node: built.agent, label: built.label });
          break;
        case 3: {
          const item = newest('message');
          if (!item) throw new Error('No message to change');
          item.message = `${String(item.message)}, revised`;
          await send('queue.update', {
            agent: built.agent,
            item: item.id,
            change: { kind: 'message', message: item.message },
          });
          break;
        }
        case 4:
          await send('canvas.move', {
            moves: [{ node: built.agent, position: { x: 1000 + i * 400, y: 300 + step * 10 } }],
          });
          break;
        case 5: {
          const { id } = await send<{ id: string }>('queue.add', {
            agent: built.agent,
            entry: { waitFor: [{ agent: partner }] },
          });
          built.items.push({ id });
          break;
        }
        case 6:
          if (!first || !last) throw new Error('No items to move');
          await send('queue.move', { agent: built.agent, item: last.id, before: first.id });
          built.items = [last, ...built.items.slice(0, -1)];
          break;
        case 7: {
          const item = newest('seconds');
          if (!item) throw new Error('No delay to change');
          item.seconds = 300 + step;
          await send('queue.update', {
            agent: built.agent,
            item: item.id,
            change: { kind: 'time', time: { seconds: item.seconds } },
          });
          break;
        }
        case 8:
          if (i === 0) {
            arrange = !(arrange ?? false);
            await send('canvas.setArrange', { on: arrange });
          } else {
            const { id } = await send<{ id: string }>('queue.add', {
              agent: built.other,
              entry: { message: `For ${built.other}, from lane ${String(i)}` },
            });
            built.queued.push(id);
          }
          break;
        case 9:
          if (!first) throw new Error('No item to remove');
          await send('queue.remove', { agent: built.agent, item: first.id });
          built.items = built.items.slice(1);
          break;
      }
    }
  };
  const lanes = Array.from({ length: LANES }, (_, i): Built => ({
    agent: '',
    label: '',
    items: [],
    other: AGENTS[i] ?? '',
    queued: [],
  }));
  await Promise.all(
    lanes.map((built, i) =>
      lane(i, built).catch((error: unknown) => {
        failed.push(`lane ${String(i)}: ${String(error)}`);
        // A lane that stopped never makes the agent another waits for.
        for (const one of made) one.resolve('');
      }),
    ),
  );
  return { lanes, arrange, latencies, took: Date.now() - start, failed };
}

test('keeps the core’s event loop within budget under a burst of messages, waits, run saves and doc ops', async () => {
  test.setTimeout(180_000);
  const { profile, file, tokens } = await profileOf();
  const url = await start(profile, file);
  const clients = await Promise.all(tokens.map((token) => connect(url, token)));
  const builder = clients.pop();
  const refusals: string[] = [];
  const done = { sent: 0, replies: 0, toggles: 0 };

  // Every agent's session started, and the canvas read, outside the burst.
  const [first] = clients;
  if (!first || !builder) throw new Error('No client');
  const before = await call<CanvasState>(builder, 'canvas.get', { canvas: CANVAS }, refusals);
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
  // The doc ops, part way through, their span measured apart: before, during and after them.
  const docs = sleep(DOC_OPS_AT).then(async () => {
    serve?.kill('SIGUSR2');
    const built = await build(builder);
    serve?.kill('SIGUSR2');
    return built;
  });
  const [built] = await Promise.all([docs, sleep(BURST_MS)]);
  serve?.kill('SIGUSR2');
  await Promise.all(work);
  const delay = await measured(3);
  const after = await call<CanvasState>(builder, 'canvas.get', { canvas: CANVAS }, refusals);
  for (const client of [...clients, builder]) await client.close();

  const ms = (n: number | undefined) => `${(n ?? NaN).toFixed(2)} ms`;
  const spans = ['before the doc ops', 'during them', 'after them'].map(
    (when, i) => `${when} p99 ${ms(delay.spans[i]?.p99)}, max ${ms(delay.spans[i]?.max)}`,
  );
  console.log(
    `G2: loop delay p50 ${ms(delay.p50)}, p99 ${ms(delay.p99)}, max ${ms(delay.max)} over ${String(delay.samples)} samples (${spans.join('; ')}); ${String(done.sent)} messages sent, ${String(done.replies)} replies waited for, ${String(done.toggles)} pauses and releases, ${String(refusals.length)} calls refused; ${String(built.latencies.length)} doc ops in ${String(built.took)} ms (${String(LANES)} in flight, a wave every ${String(WAVE_EVERY_MS)} ms), each p50 ${ms(percentile(built.latencies, 50))}, p99 ${ms(percentile(built.latencies, 99))}, max ${ms(percentile(built.latencies, 100))}`,
  );
  // The burst was one: every party's messages went, and came back, and every doc op was made.
  expect(done.sent).toBeGreaterThan(1000);
  expect(done.replies).toBeGreaterThan(1000);
  expect(done.toggles).toBeGreaterThan(100);
  expect(built.failed).toEqual([]);
  expect(built.latencies).toHaveLength(DOC_OPS);
  expect(delay.p99).toBeLessThan(25);
  expect(delay.max).toBeLessThan(100);

  // The canvas is as the doc ops left it: each lane's agent, named last as it named it, linked to
  // the one it spawned or was spawned from, its queue items in the order it left them (beside the
  // fresh one an agent is made with), as it last changed them; and the items it added to the agent
  // already there after those it had.
  if (!before || !after) throw new Error('No canvas');
  const nodes = new Map(after.nodes.map((node) => [node.id, node]));
  expect(after.nodes).toHaveLength(before.nodes.length + LANES);
  expect(after.arrange).toBe(built.arrange);
  expect(after.links.map(({ source, target }) => [source, target]).sort()).toEqual(
    built.lanes
      .slice(0, LANES / 2)
      .map(({ agent }, i) => [agent, built.lanes[i + LANES / 2]?.agent])
      .sort(),
  );
  for (const lane of built.lanes) {
    const agent = nodes.get(lane.agent);
    expect(agent?.data.label).toBe(lane.label);
    const queue = agent?.data.queue ?? [];
    expect(queue).toHaveLength(lane.items.length + 1);
    expect(queue.slice(1)).toEqual(
      lane.items.map(({ id, message, seconds }) =>
        expect.objectContaining({
          id,
          ...(message === undefined ? {} : { message }),
          ...(seconds === undefined ? {} : { delay: { seconds } }),
        }),
      ),
    );
    const other = nodes.get(lane.other);
    const was = before.nodes.find(({ id }) => id === lane.other);
    expect(other?.data.label).toBe(lane.otherLabel ?? was?.data.label);
    expect((other?.data.queue ?? []).map(({ id }) => id)).toEqual([
      ...(was?.data.queue?.map(({ id }) => id) ?? []),
      ...lane.queued,
    ]);
  }

  const exited = new Promise((resolve) => serve?.once('exit', resolve));
  serve?.kill('SIGTERM');
  expect(await exited).toBe(0);
});
