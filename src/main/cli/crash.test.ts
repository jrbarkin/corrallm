import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { toolName } from '../../shared/api/registry';
import type { Message } from '../../shared/model/messages';
import { keepCanvases, readOnDisk } from '../core/store/test-store';
import { TestChildren } from './test-children';
import type { TestChild } from './test-children';
import { cleanupCrash } from './test-crash-cleanup';

/*
 * Gate G3 of the core's database (Core Database §8): `corrallm serve` (the CLI bundle, which the
 * vitest `main` project's global setup builds) killed with SIGKILL, again and again, while outside
 * orchestrators send its agents messages and wait for their replies, keeps every invariant of its
 * messages across each crash: no message is sent to an agent twice, none acknowledged is lost, a
 * party's read position never goes back (so no wait returns a message twice), and a message that
 * was being delivered, or whose turn went on, as it was killed is unresolved, never sent again.
 * Its agents run a fake `codex`, which logs every request it gets: what each was sent.
 */

const BUNDLE = path.resolve('dist-cli/corrallm.cjs');
const FAKE_CODEX = path.resolve('src/main/sessions/codex/fake-codex.mjs');
const CANVAS = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4d01';
const AGENTS = ['b1', 'b2', 'b3'];
const PARTIES = ['first', 'second'];
const TOKENS = PARTIES.map((name) => `known-crash-token-of-${name}-0123456789abcdef`);
const CRASHES = 6;

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(process.platform === 'win32')('corrallm serve, killed again and again', () => {
  let dir: string;
  let profile: string;
  let file: string;
  let codexLog: string;
  let serve: TestChild | undefined;
  let children: TestChildren;

  beforeEach(async () => {
    children = new TestChildren();
    dir = await mkdtemp(path.join(tmpdir(), 'corrallm-crash-'));
    profile = path.join(dir, 'profile');
    const project = path.join(dir, 'project');
    await mkdir(profile, { mode: 0o700 });
    await mkdir(project);
    file = path.join(dir, 'crash.corral');
    await writeFile(
      file,
      JSON.stringify({
        format: 'corrallm',
        version: 2,
        id: CANVAS,
        nodes: AGENTS.map((id, i) => ({
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
    const expires = Date.now() + 60 * 60 * 1000;
    await writeFile(
      path.join(profile, 'tokens.json'),
      JSON.stringify({
        version: 2,
        tokens: Object.fromEntries(
          TOKENS.map((token, i) => [
            sha256(token),
            { id: PARTIES[i], name: PARTIES[i], canvases: [CANVAS], access: 'write', expires },
          ]),
        ),
      }),
    );
    codexLog = path.join(dir, 'codex.log');
    await writeFile(
      path.join(dir, 'codex'),
      `#!/bin/sh\nFAKE_CODEX_STATE="${path.join(dir, 'threads.json')}" FAKE_CODEX_LOG="${codexLog}" exec "${process.execPath}" "${FAKE_CODEX}" "$@"\n`,
    );
    await chmod(path.join(dir, 'codex'), 0o755);
  });

  afterEach(async () => {
    await cleanupCrash(dir, profile, children);
    serve = undefined;
  }, 30_000);

  /** Starts `corrallm serve`: its URL, once it writes api.json. */
  async function start(): Promise<string> {
    await rm(path.join(profile, 'api.json'), { force: true });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CORRALLM_AGENT_PATHS: JSON.stringify({
        codex: path.join(dir, 'codex'),
        'claude-code': path.join(dir, 'no-claude'),
      }),
    };
    delete env.CORRALLM_URL;
    delete env.CORRALLM_OUTSIDE_TOKEN;
    const child = children.spawn(
      process.execPath,
      [BUNDLE, 'serve', '--profile', profile, '--canvas', file, '--port', '0'],
      env,
    );
    serve = child;
    child.stdout.resume();
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
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(`serve exited: ${said}`);
      await sleep(50);
    }
    throw new Error(`serve never wrote api.json: ${said}`);
  }

  /** Kills `corrallm serve` at once, as a crash or a power cut would. */
  async function kill(): Promise<void> {
    const child = serve;
    serve = undefined;
    if (child?.exitCode !== null || child.signalCode !== null) return;
    const exited = children.exited(child);
    child.kill('SIGKILL');
    await exited;
  }

  async function connect(url: string, token: string): Promise<Client> {
    const client = new Client({ name: 'crash', version: '1' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }) as Transport,
    );
    return client;
  }

  /** Calls a tool: its result, or undefined if it failed or the server went. */
  async function call<T>(
    client: Client,
    name: string,
    args: Record<string, unknown>,
  ): Promise<T | undefined> {
    try {
      const result = (await client.callTool({ name: toolName(name), arguments: args }, undefined, {
        timeout: 30_000,
      })) as CallToolResult;
      return result.isError === true ? undefined : (result.structuredContent as T);
    } catch {
      return undefined;
    }
  }

  /** Every message of the canvas on disk, by id: its state and who it is from and to. */
  function onDisk(): Map<string, { state: string; from: string; to: string; kind: string }> {
    const rows = readOnDisk(profile, (disk) =>
      disk
        .prepare('SELECT id, state, from_party, to_party, kind FROM message WHERE canvas_id = ?')
        .all(CANVAS),
    );
    return new Map(
      rows.map((row) => [
        String(row.id),
        {
          state: String(row.state),
          from: String(row.from_party),
          to: String(row.to_party),
          kind: String(row.kind),
        },
      ]),
    );
  }

  /** Each party's read position on disk. */
  function positions(): Record<string, number> {
    const rows = readOnDisk(profile, (disk) =>
      disk.prepare('SELECT party, seq FROM read_position WHERE canvas_id = ?').all(CANVAS),
    );
    return Object.fromEntries(rows.map(({ party, seq }) => [String(party), Number(seq)]));
  }

  /** How many times each message reached an agent: the turns the fake codex was asked for. */
  async function turns(): Promise<Map<string, number>> {
    const log = existsSync(codexLog) ? await readFile(codexLog, 'utf8') : '';
    const counted = new Map<string, number>();
    for (const line of log.split('\n').filter(Boolean)) {
      const { method, params } = JSON.parse(line) as {
        method: string;
        params?: { input?: { type: string; text?: string }[] };
      };
      if (method !== 'turn/start') continue;
      const text = params?.input?.map((part) => part.text ?? '').join('') ?? '';
      const id = /; message ([0-9a-f-]{36})\)/.exec(text)?.[1];
      if (id !== undefined) counted.set(id, (counted.get(id) ?? 0) + 1);
    }
    return counted;
  }

  it('keeps every message’s invariants through each SIGKILL', { timeout: 240_000 }, async () => {
    /** Every message a `message` call acknowledged, by id. */
    const acknowledged = new Set<string>();
    /** What each party's waits returned, without a cursor, over every run. */
    const waited = PARTIES.map(() => [] as string[]);
    let before: Record<string, number> = {};
    /** The messages being delivered, or whose turn went on, as the core was last killed. */
    let inFlight: string[] = [];
    /** Every message cut off so. */
    const cutOff = new Set<string>();
    const slow = new Set<string>();

    for (let crash = 0; crash <= CRASHES; crash++) {
      const seenBefore = await turns();
      const url = await start();
      // Unresolved as the canvas opens again, never sent again.
      await vi.waitFor(() => {
        const kept = onDisk();
        for (const id of inFlight) expect(kept.get(id)?.state, id).toBe('unresolved');
      });
      const clients = await Promise.all(TOKENS.map((token) => connect(url, token)));
      const stop = { now: false };
      const release = Promise.withResolvers<undefined>();
      const sendBatch = async (client: Client, p: number, from: number, to: number) => {
        for (let n = from; !stop.now && n < to; n++) {
          const waiting = (crash + n) % 3 === 0;
          const sent = await call<{ id: string }>(client, 'message', {
            canvas: CANVAS,
            to: AGENTS[(p + n) % AGENTS.length],
            body: `${waiting ? 'slow ' : ''}crash ${String(crash)} party ${String(p)} message ${String(n)}`,
          });
          if (sent) {
            acknowledged.add(sent.id);
            if (waiting) slow.add(sent.id);
          } else if (from === 0) throw new Error('A message failed before the crash.');
        }
      };
      const traffic = clients.map(async (client, p) => {
        while (!stop.now) {
          const got = await call<{ messages: Message[] }>(client, 'wait', { timeoutSeconds: 1 });
          if (got === undefined) return;
          waited[p]?.push(...got.messages.map(({ id }) => id));
        }
      });
      try {
        // Six acknowledged messages per round guarantee the original >30 coverage on a slow host.
        await Promise.all(clients.map((client, p) => sendBatch(client, p, 0, 3)));
        // Crash at two or three actual native receipts, with a slow turn still in flight. Old
        // queued work can supply those receipts after a restart, before this round's work goes.
        await vi.waitFor(
          async () => {
            const counted = await turns();
            const added = [...counted].filter(([id, count]) => count > (seenBefore.get(id) ?? 0));
            expect(added.length).toBeGreaterThanOrEqual(2 + (crash % 2));
            const kept = onDisk();
            expect(
              [...kept].some(
                ([id, message]) =>
                  slow.has(id) &&
                  counted.has(id) &&
                  ['delivering', 'delivered'].includes(message.state),
              ),
            ).toBe(true);
            expect(waited.flat().length).toBeGreaterThan(0);
          },
          { timeout: 30_000, interval: 25 },
        );
        // More writes race the SIGKILL, just as they did in the timed version.
        traffic.push(
          ...clients.map(async (client, p) => {
            await release.promise;
            await sendBatch(client, p, 3, 5);
          }),
        );
        release.resolve(undefined);
        await Promise.resolve();
        stop.now = true;
        await kill();
      } finally {
        stop.now = true;
        release.resolve(undefined);
        // What they were asking the server that went is cut off.
        for (const client of clients) await client.close().catch(() => undefined);
        await Promise.all(traffic);
      }

      // Nothing acknowledged is lost; no read position goes back.
      const kept = onDisk();
      for (const id of acknowledged) expect(kept.has(id), id).toBe(true);
      inFlight = [...kept].flatMap(([id, { state, to, kind }]) =>
        kind === 'text' && to.startsWith('agent:') && ['delivering', 'delivered'].includes(state)
          ? [id]
          : [],
      );
      for (const id of inFlight) cutOff.add(id);
      const now = positions();
      for (const [party, seq] of Object.entries(before)) {
        expect(now[party] ?? 0, party).toBeGreaterThanOrEqual(seq);
      }
      before = now;
    }

    // One last run, to let what waited go: every message went to its agent at most once, and
    // what was cut off by a crash never went again.
    const beforeLast = await turns();
    const pending = new Set(
      [...onDisk().values()].filter((message) => message.state === 'pending').map(({ to }) => to),
    );
    await start();
    await vi.waitFor(() => {
      const kept = onDisk();
      for (const id of inFlight) expect(kept.get(id)?.state, id).toBe('unresolved');
    });
    await vi.waitFor(
      async () => {
        const kept = onDisk();
        const counted = await turns();
        const recipients = new Set(
          [...counted].flatMap(([id, count]) => {
            const message = kept.get(id);
            return count > (beforeLast.get(id) ?? 0) && message ? [message.to] : [];
          }),
        );
        for (const agent of pending) expect(recipients.has(agent), agent).toBe(true);
      },
      { timeout: 30_000, interval: 25 },
    );
    await kill();
    const counted = await turns();
    expect(acknowledged.size).toBeGreaterThan(30);
    expect(cutOff.size).toBeGreaterThan(0);
    for (const id of acknowledged) expect(counted.get(id) ?? 0, id).toBeLessThanOrEqual(1);
    expect([...acknowledged].filter((id) => counted.get(id) === 1).length).toBeGreaterThan(10);
    const kept = onDisk();
    for (const id of cutOff) expect(kept.get(id)?.state, id).toBe('unresolved');
    console.log(
      `G3: ${String(acknowledged.size)} messages acknowledged, ${String(cutOff.size)} cut off by a crash, ${String([...acknowledged].filter((id) => counted.get(id) === 1).length)} sent once, none twice; ${String(waited.flat().length)} read by waits, none twice`,
    );
    // No wait read a message twice, across every crash.
    for (const ids of waited) expect(new Set(ids).size).toBe(ids.length);
    expect(waited.flat().length).toBeGreaterThan(0);
  });
});
