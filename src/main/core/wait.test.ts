import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CanvasId } from '../../shared/canvas';
import type { Message } from '../../shared/model/messages';
import { callTool } from '../api/mcp';
import { FakeConnector } from '../sessions/fake';
import type { OutsideCaller } from './caller';
import { createCore } from './core';
import type { Core } from './core';
import { NO_DESKTOP } from './test-registry';

/*
 * `wait` (decision 20a; API Spec §7.7): one call that returns the next things addressed to an
 * outside party after a cursor, or waits for them. It never consumes; the party's read position,
 * which a `wait` without `for` moves forward, is kept in each canvas's record across restarts, and
 * is the party's, not its token's, so a token renewed by name reads on from it.
 */

const M1 = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a11' as CanvasId;
const WORKER = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a12' as CanvasId;

let profile: string;
let core: Core | undefined;
let connector: FakeConnector;

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-wait-'));
  connector = new FakeConnector({ adapter: 'codex' });
});

afterEach(async () => {
  await core?.close();
  core = undefined;
  await rm(profile, { recursive: true, force: true });
});

/** A canvas file with one App Server agent, Builder, as the app would keep it with its folder. */
async function canvasFile(id: CanvasId, name: string): Promise<{ file: string; project: string }> {
  const file = path.join(profile, `${name}.corral`);
  const project = path.join(profile, name);
  await mkdir(project, { recursive: true });
  await writeFile(
    file,
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
      ],
      links: [],
    }),
  );
  return { file, project };
}

/** A profile keeping m1 (and the worker canvas, with `both`). */
async function keep(both = false): Promise<void> {
  const canvases: Record<string, unknown> = {
    [M1]: { ...(await canvasFile(M1, 'm1')), conversations: {} },
  };
  if (both) canvases[WORKER] = { ...(await canvasFile(WORKER, 'worker')), conversations: {} };
  await writeFile(path.join(profile, 'canvases.json'), JSON.stringify({ version: 2, canvases }));
}

async function start(open: CanvasId[] = [M1]): Promise<Core> {
  core = await createCore(
    {
      profile,
      app: { name: 'corrallm', version: '1.0.0' },
      check: true,
      distribution: 'local',
      locale: 'en-GB',
      sessions: {
        connectors: { 'codex.app-server': connector, 'codex.terminal': connector },
        environment: () => Promise.resolve({}),
      },
    },
    NO_DESKTOP,
  );
  for (const canvas of open) await core.engines.open(canvas);
  return core;
}

/** The core started: the test's own. */
function current(): Core {
  if (!core) throw new Error('No core is started');
  return core;
}

/** The caller a token names: the test fails if it names none. */
function callerOf(made: string): OutsideCaller {
  const caller = current().tokens.clientOf(made);
  if (!caller) throw new Error('The token names no caller');
  return caller;
}

async function restart(open?: CanvasId[]): Promise<Core> {
  await core?.close();
  core = undefined;
  return start(open);
}

/** A token's caller, made as `corrallm serve --new-token` makes it. */
async function token(
  name = 'orchestrator',
  canvases: CanvasId[] = [M1],
): Promise<{ token: string; caller: OutsideCaller }> {
  const made = await current().tokens.create({ name, canvases, access: 'write' });
  return { token: made, caller: callerOf(made) };
}

interface Waited {
  messages: Message[];
  next: string;
}

async function call<T>(
  name: string,
  args: Record<string, unknown>,
  caller: OutsideCaller,
  signal?: AbortSignal,
): Promise<T> {
  const result = await current().call(name as never, args, caller, signal);
  if (!result.ok) throw new Error(`${name} failed: ${result.error.sentence}`);
  return result.value;
}

const wait = (caller: OutsideCaller, args: Record<string, unknown> = {}) =>
  call<Waited>('wait', { timeoutSeconds: 0, ...args }, caller);

/** Sends Builder a message on `canvas` and waits for its reply to come back: the message's id. */
async function exchange(caller: OutsideCaller, body: string, canvas = M1): Promise<string> {
  const { id } = await call<{ id: string }>('message', { canvas, to: 'builder', body }, caller);
  await vi.waitFor(async () => {
    const { items } = await call<{ items: Message[] }>('messages', { canvas }, caller);
    expect(items.some((message) => message.replyTo === id && message.kind === 'text')).toBe(true);
  });
  return id;
}

describe('wait', () => {
  it('returns what is addressed to the party, oldest first, and never twice without a cursor', async () => {
    await keep();
    await start();
    const { caller } = await token();
    const first = await exchange(caller, 'One');
    const second = await exchange(caller, 'Two');

    const waited = await wait(caller);
    expect(waited.messages.map(({ replyTo, kind }) => [replyTo, kind])).toEqual([
      [first, 'text'],
      [second, 'text'],
    ]);
    expect(waited.messages.every(({ to }) => to === 'outside:orchestrator')).toBe(true);
    expect(waited.messages[0]?.turn).toEqual({ status: 'completed', reason: 'completed' });
    // Nothing new since.
    expect((await wait(caller)).messages).toEqual([]);
    const third = await exchange(caller, 'Three');
    expect((await wait(caller)).messages.map(({ replyTo }) => replyTo)).toEqual([third]);
  });

  it('never consumes: a cursor reads again what a wait returned, and messages still lists it', async () => {
    await keep();
    await start();
    const { caller } = await token();
    const status = await call<{ next: string }>('status', { canvas: M1 }, caller);
    const id = await exchange(caller, 'Hello');
    const waited = await wait(caller);
    expect(waited.messages).toHaveLength(1);
    // Again, from the same cursor: the same messages, and the same next.
    expect(await wait(caller, { after: status.next })).toEqual(waited);
    // From where the first one ended: nothing.
    expect((await wait(caller, { after: waited.next })).messages).toEqual([]);
    const { items } = await call<{ items: Message[] }>('messages', { canvas: M1 }, caller);
    expect(items.find((message) => message.replyTo === id)).toEqual(waited.messages[0]);
  });

  it('with `for`, returns only what concerns that message, and leaves the read position alone', async () => {
    await keep();
    await start();
    const { caller } = await token();
    const first = await exchange(caller, 'One');
    const second = await exchange(caller, 'Two');
    expect((await wait(caller, { for: second })).messages.map(({ replyTo }) => replyTo)).toEqual([
      second,
    ]);
    // A wait without `for` still returns both: the one with `for` moved nothing.
    expect((await wait(caller)).messages.map(({ replyTo }) => replyTo)).toEqual([first, second]);
  });

  it('waits for the next thing addressed to the party, or returns at its time limit at its start', async () => {
    await keep();
    await start();
    const { caller } = await token();
    const status = await call<{ next: string }>('status', { canvas: M1 }, caller);

    const before = Date.now();
    const empty = await wait(caller, { timeoutSeconds: 1 });
    expect(Date.now() - before).toBeGreaterThanOrEqual(900);
    expect(empty).toEqual({ messages: [], next: status.next });

    const waiting = wait(caller, { timeoutSeconds: 30 });
    const { id } = await call<{ id: string }>(
      'message',
      { canvas: M1, to: 'builder', body: 'Wake me' },
      caller,
    );
    const woken = await waiting;
    expect(woken.messages.map(({ replyTo, kind }) => [replyTo, kind])).toEqual([[id, 'text']]);
  });

  it('keeps the party’s read position in the canvas’s record before it returns, across restarts', async () => {
    await keep();
    await start();
    const { token: made } = await token();
    const caller = callerOf(made);
    await exchange(caller, 'One');
    const waited = await wait(caller);
    expect(waited.messages).toHaveLength(1);
    const record = JSON.parse(
      await readFile(path.join(profile, 'runs', M1, 'record.json'), 'utf8'),
    ) as { reads?: Record<string, number> };
    expect(record.reads?.['outside:orchestrator']).toEqual(expect.any(Number));

    await restart();
    // The same token, kept in tokens.json, reads on where its party left off.
    const again = callerOf(made);
    expect((await wait(again)).messages).toEqual([]);
    const second = await exchange(again, 'Two');
    expect((await wait(again)).messages.map(({ replyTo }) => replyTo)).toEqual([second]);
  });

  it('is the party’s: a token renewed by name mid-turn revokes the old at once, and the new one gets the reply', async () => {
    connector = new FakeConnector({ adapter: 'codex', pause: 100 });
    await keep();
    await start();
    const old = await token();
    const { id } = await call<{ id: string }>(
      'message',
      { canvas: M1, to: 'builder', body: 'Take your time' },
      old.caller,
    );
    // The old token waits for the reply meanwhile.
    const oldWait = current().call('wait', { timeoutSeconds: 30 }, old.caller);
    await vi.waitFor(() => {
      expect(connector.sessions[0]?.sent).toHaveLength(1);
    });

    const renewed = await token();
    expect(current().tokens.clientOf(old.token)).toBeUndefined();
    // Its wait ends refused, returning nothing and moving nothing.
    const ended = await oldWait;
    expect(ended.ok).toBe(false);
    if (!ended.ok) {
      expect(ended.error.code).toBe('refused');
      expect(ended.error.sentence).toMatch(/replaced or expired/);
    }

    const waited = await call<Waited>('wait', { timeoutSeconds: 30 }, renewed.caller);
    expect(waited.messages.map(({ replyTo, kind, turn }) => [replyTo, kind, turn?.status])).toEqual(
      [[id, 'text', 'completed']],
    );
  });

  it('reads every canvas the party reaches, oldest first, with a cursor naming each', async () => {
    await keep(true);
    await start([M1, WORKER]);
    const { caller } = await token('orchestrator', [M1, WORKER]);
    const status = await call<{ next: string }>('status', { canvas: WORKER }, caller);
    const onM1 = await exchange(caller, 'On m1', M1);
    const onWorker = await exchange(caller, 'On the worker', WORKER);

    const waited = await wait(caller);
    expect(waited.messages.map(({ canvas, replyTo }) => [canvas, replyTo])).toEqual([
      [M1, onM1],
      [WORKER, onWorker],
    ]);
    // status's cursor is at the end of every canvas the caller reaches.
    expect(await wait(caller, { after: status.next })).toEqual(waited);
    expect((await wait(caller, { after: waited.next })).messages).toEqual([]);
  });

  it('returns nothing addressed to another party, and refuses a cursor it didn’t give', async () => {
    await keep();
    await start();
    const { caller } = await token('orchestrator');
    const { caller: other } = await token('other');
    await exchange(caller, 'Mine');
    await exchange(other, 'Theirs');
    expect((await wait(caller)).messages.map(({ to }) => to)).toEqual(['outside:orchestrator']);
    expect((await wait(other)).messages.map(({ to }) => to)).toEqual(['outside:other']);
    const refused = await current().call(
      'wait',
      { timeoutSeconds: 0, after: 'not a cursor' },
      caller,
    );
    expect(refused.ok ? undefined : refused.error.code).toBe('invalid');
  });

  it('ends when its caller gives up, over MCP too', async () => {
    await keep();
    await start();
    const { caller } = await token();
    const controller = new AbortController();
    const before = Date.now();
    const waiting = callTool(current(), caller, 'wait', { timeoutSeconds: 60 }, controller.signal);
    setTimeout(() => {
      controller.abort();
    }, 100);
    const result = await waiting;
    expect(Date.now() - before).toBeLessThan(5000);
    expect(result).toMatchObject({ isError: true });
  });
});
