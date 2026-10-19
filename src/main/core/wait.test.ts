import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TOKEN_REPLACED, TOO_MANY_WAITS } from '../../shared/api/errors';
import { MAX_MESSAGE_BYTES, TOKEN_WAITS } from '../../shared/api/limits';
import type { CanvasId } from '../../shared/canvas';
import type { Message } from '../../shared/model/messages';
import { callTool } from '../api/mcp';
import { FakeConnector } from '../sessions/fake';
import type { OutsideCaller } from './caller';
import { createCore } from './core';
import type { Core } from './core';
import { cursorOf, readCursor } from './delivery/messages';
import { keepCanvases, readPositions, refuseWrites } from './store/test-store';
import { NO_DESKTOP } from './test-registry';

/*
 * `wait` (decision 20a; API Spec §7.7): one call that returns the next things addressed to an
 * outside party after a cursor, or waits for them. It never consumes; the party's read position,
 * which a `wait` without `for` moves forward, is kept on disk for each canvas across restarts, and
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
  await keepCanvases(profile, {
    [M1]: await canvasFile(M1, 'm1'),
    ...(both ? { [WORKER]: await canvasFile(WORKER, 'worker') } : {}),
  });
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

/** A call's error, as `{ code, sentence }`: the test fails if it worked. */
async function failure(
  name: string,
  args: Record<string, unknown>,
  caller: OutsideCaller,
): Promise<{ code: string; sentence: string }> {
  const result = await current().call(name as never, args, caller);
  if (result.ok) throw new Error(`${name} worked`);
  return result.error;
}

/** Where the canvas's messages say each party's `wait` has read to, as on disk. */
function keptReads(canvas: CanvasId = M1): Record<string, number> {
  return readPositions(profile, canvas);
}

/** Sends Builder a message on `canvas` and waits for its reply to come back: the message's id. */
async function exchange(caller: OutsideCaller, body: string, canvas = M1): Promise<string> {
  const { id } = await call<{ id: string }>('message', { canvas, to: 'builder', body }, caller);
  await vi.waitFor(() => {
    const kept = current().engines.canvas(canvas)?.messages.all() ?? [];
    expect(kept.some((message) => message.replyTo === id && message.kind === 'text')).toBe(true);
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

  it('keeps the party’s read position on disk before it returns, across restarts', async () => {
    await keep();
    await start();
    const { token: made } = await token();
    const caller = callerOf(made);
    await exchange(caller, 'One');
    const waited = await wait(caller);
    expect(waited.messages).toHaveLength(1);
    // On disk as it returned.
    expect(keptReads()['outside:orchestrator']).toEqual(expect.any(Number));

    await restart();
    // The same token, kept in tokens.json, reads on where its party left off.
    const again = callerOf(made);
    expect((await wait(again)).messages).toEqual([]);
    const second = await exchange(again, 'Two');
    expect((await wait(again)).messages.map(({ replyTo }) => replyTo)).toEqual([second]);
  });

  it('is the party’s: a token renewed by name mid-turn revokes the old at once, and the new one gets the reply', async () => {
    // A turn far longer than it takes the old token's wait to end.
    connector = new FakeConnector({ adapter: 'codex', pause: 1000 });
    await keep();
    await start();
    const old = await token();
    const { id } = await call<{ id: string }>(
      'message',
      { canvas: M1, to: 'builder', body: 'Take your time' },
      old.caller,
    );
    // The old token waits for the reply meanwhile.
    let settled = false;
    const oldWait = current()
      .call('wait', { timeoutSeconds: 30 }, old.caller)
      .finally(() => {
        settled = true;
      });
    await vi.waitFor(() => {
      expect(connector.sessions[0]?.sent).toHaveLength(1);
    });

    const renewed = await token();
    expect(current().tokens.clientOf(old.token)).toBeUndefined();
    // Its wait ends at once, refused, returning nothing and moving nothing, while the turn goes on.
    await vi.waitFor(
      () => {
        expect(settled).toBe(true);
      },
      { timeout: 500 },
    );
    const { items } = await call<{ items: Message[] }>('messages', { canvas: M1 }, renewed.caller);
    expect(items.filter((message) => message.replyTo === id)).toEqual([]);
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

  it('ends refused as its token expires, though nothing came', async () => {
    await keep();
    // A token kept with a second and a half to go, as tokens.json would hold one made an hour ago.
    const made = 'a-token-about-to-expire-0123456789abcdef';
    await writeFile(
      path.join(profile, 'tokens.json'),
      JSON.stringify({
        version: 2,
        tokens: {
          [createHash('sha256').update(made).digest('hex')]: {
            id: 'expiring',
            name: 'orchestrator',
            canvases: [M1],
            access: 'write',
            expires: Date.now() + 1500,
          },
        },
      }),
    );
    await start();
    const caller = callerOf(made);
    const before = Date.now();
    const ended = await failure('wait', { timeoutSeconds: 30 }, caller);
    expect(Date.now() - before).toBeLessThan(5000);
    expect(ended).toEqual({ code: 'refused', sentence: TOKEN_REPLACED });
  });

  it('reads every canvas the party reaches, oldest first, with a cursor naming each', async () => {
    await keep(true);
    await start([M1, WORKER]);
    const { caller } = await token('orchestrator', [M1, WORKER]);
    const earlier = await exchange(caller, 'Before the status', M1);
    const status = await call<{ next: string }>('status', { canvas: WORKER }, caller);
    const onM1 = await exchange(caller, 'On m1', M1);
    const onWorker = await exchange(caller, 'On the worker', WORKER);

    const waited = await wait(caller);
    expect(waited.messages.map(({ canvas, replyTo }) => [canvas, replyTo])).toEqual([
      [M1, earlier],
      [M1, onM1],
      [WORKER, onWorker],
    ]);
    // status's cursor, though it was asked of the worker, is at the end of every canvas the caller
    // reaches: a wait from it reads only what came on each since, m1's earlier reply left out.
    expect(
      (await wait(caller, { after: status.next })).messages.map(({ canvas, replyTo }) => [
        canvas,
        replyTo,
      ]),
    ).toEqual([
      [M1, onM1],
      [WORKER, onWorker],
    ]);
    expect((await wait(caller, { after: waited.next })).messages).toEqual([]);
  });

  it('reads a canvas a cursor doesn’t name from its start: a token renewed to reach more', async () => {
    await keep(true);
    await start([M1, WORKER]);
    // The party reached the worker first, and read what came there; then m1 alone, whose cursor
    // names m1 alone.
    const first = await token('orchestrator', [WORKER]);
    const older = await exchange(first.caller, 'On the worker, long ago', WORKER);
    expect((await wait(first.caller)).messages.map(({ replyTo }) => replyTo)).toEqual([older]);
    const second = await token('orchestrator', [M1]);
    const onM1 = await exchange(second.caller, 'On m1', M1);
    const { next } = await wait(second.caller);
    // Renewed to reach both: from that cursor, the worker's older reply comes back (at least once,
    // though the party's read position there is past it), and m1's doesn't.
    const both = await token('orchestrator', [M1, WORKER]);
    const waited = await wait(both.caller, { after: next });
    expect(waited.messages.map(({ canvas, replyTo }) => [canvas, replyTo])).toEqual([
      [WORKER, older],
    ]);
    expect(onM1).not.toBe(older);
  });

  it('returns a page at a time, its next where that page ends, and never moves the read position back', async () => {
    await keep();
    await start();
    const { caller } = await token();
    const status = await call<{ next: string }>('status', { canvas: M1 }, caller);
    // Four replies of 15 KB or so, more than one page holds.
    const big = 'x'.repeat(MAX_MESSAGE_BYTES - 1024);
    const sent: string[] = [];
    for (let i = 0; i < 4; i++) sent.push(await exchange(caller, `${String(i)} ${big}`));

    const first = await wait(caller);
    expect(first.messages.length).toBeGreaterThan(0);
    expect(first.messages.length).toBeLessThan(sent.length);
    const returned = first.messages.length;
    // The read position is just past the last it returned: the next wait without a cursor returns
    // the rest, none skipped and none twice.
    const second = await wait(caller);
    expect(second.messages.map(({ replyTo }) => replyTo)).toEqual(sent.slice(returned));
    // And so is its next: from it, the rest again.
    expect(await wait(caller, { after: first.next })).toEqual(second);
    const kept = keptReads();

    // A wait from before them all returns the first page again, and leaves the read position
    // where it was.
    const again = await wait(caller, { after: status.next });
    expect(again.messages.map(({ replyTo }) => replyTo)).toEqual(sent.slice(0, returned));
    expect(keptReads()).toEqual(kept);
    expect((await wait(caller)).messages).toEqual([]);
  });

  it('moves no read position it couldn’t journal: that wait fails, and the next returns what it didn’t', async () => {
    await keep();
    await start();
    const { caller } = await token();
    const id = await exchange(caller, 'One');
    // Where it has read to can't be written meanwhile.
    const allow = refuseWrites(profile, 'read_position', 'The disk is full');
    try {
      expect((await current().call('wait', { timeoutSeconds: 0 }, caller)).ok).toBe(false);
    } finally {
      allow();
    }
    expect((await wait(caller)).messages.map(({ replyTo }) => replyTo)).toEqual([id]);
  });

  it.each([false, true])(
    'returns only the canvases whose read positions landed, losing none (with cursor: %s)',
    async (withCursor) => {
      await keep(true);
      await start([M1, WORKER]);
      const { caller } = await token('orchestrator', [M1, WORKER]);
      const first = await exchange(caller, 'One', M1);
      const second = await exchange(caller, 'Two', WORKER);
      const before = cursorOf('wait', { [M1]: 0, [WORKER]: 0 });
      // Where it has read to on the worker canvas can't be written meanwhile.
      const allow = refuseWrites(profile, 'read_position', 'The disk is full', WORKER);
      let waited: Waited;
      try {
        waited = await wait(caller, withCursor ? { after: before } : {});
        expect(waited.messages.map(({ replyTo }) => replyTo)).toEqual([first]);
        const next = readCursor(waited.next, ['wait']);
        expect(next).toEqual({
          [M1]: current()
            .engines.canvas(M1)
            ?.messages.seqOf(waited.messages[0]?.id ?? ''),
          [WORKER]: 0,
        });
        expect(keptReads(M1)).toEqual({ 'outside:orchestrator': next?.[M1] });
        expect(keptReads(WORKER)).toEqual({});
        expect(current().engines.canvas(WORKER)?.reads.of('outside:orchestrator')).toBe(0);
      } finally {
        allow();
      }
      const following = await wait(caller, withCursor ? { after: waited.next } : {});
      expect(following.messages.map(({ replyTo }) => replyTo)).toEqual([second]);
      expect((await wait(caller)).messages).toEqual([]);
    },
  );

  it('wakes only one of two waits at once with what comes, when neither names a cursor', async () => {
    await keep();
    await start();
    const { caller } = await token();
    const one = wait(caller, { timeoutSeconds: 2 });
    const two = wait(caller, { timeoutSeconds: 2 });
    const { id } = await call<{ id: string }>(
      'message',
      { canvas: M1, to: 'builder', body: 'Wake one' },
      caller,
    );
    const both = await Promise.all([one, two]);
    expect(both.flatMap(({ messages }) => messages.map(({ replyTo }) => replyTo))).toEqual([id]);
  });

  it('takes only its own cursors: not one of messages’, nor one past what the store holds', async () => {
    await keep(true);
    await start([M1, WORKER]);
    const { caller } = await token('orchestrator', [M1, WORKER]);
    await exchange(caller, 'On the worker', WORKER);
    const onM1 = await exchange(caller, 'On m1', M1);
    const { messages } = await wait(caller);
    expect(messages).toHaveLength(2);
    const kept = keptReads(M1);

    // messages' cursor names the one canvas it paged: as wait's, it would read the worker anew.
    const paged = await call<{ next: string }>('messages', { canvas: M1 }, caller);
    expect(await failure('wait', { timeoutSeconds: 0, after: paged.next }, caller)).toMatchObject({
      code: 'invalid',
    });
    // A place past m1's last message is no place corrallm gave: it moves nothing.
    const past = cursorOf('wait', { [M1]: 1_000_000, [WORKER]: 0 });
    expect(await failure('wait', { timeoutSeconds: 0, after: past }, caller)).toMatchObject({
      code: 'invalid',
    });
    expect(keptReads(M1)).toEqual(kept);
    const later = await exchange(caller, 'Later', M1);
    expect((await wait(caller)).messages.map(({ replyTo }) => replyTo)).toEqual([later]);
    expect(onM1).not.toBe(later);
  });

  it('keeps a token’s waits out of its limit on calls in flight, within a limit of their own', async () => {
    await keep();
    await start();
    const { caller } = await token();
    const controllers = Array.from({ length: TOKEN_WAITS }, () => new AbortController());
    const waiting = controllers.map((controller) =>
      current().call('wait', { timeoutSeconds: 30 }, caller, controller.signal),
    );
    try {
      // Every wait holds its place, and the token's other calls are answered meanwhile.
      await vi.waitFor(async () => {
        // In the words `corrallm wait` exits 3 on, to try again later.
        expect(await failure('wait', { timeoutSeconds: 30 }, caller)).toEqual({
          code: 'refused',
          sentence: TOO_MANY_WAITS,
        });
      });
      expect((await current().call('agents', { canvas: M1 }, caller)).ok).toBe(true);
      expect(
        (
          await current().call(
            'message',
            { canvas: M1, to: 'builder', body: 'Still heard' },
            caller,
          )
        ).ok,
      ).toBe(true);
    } finally {
      for (const controller of controllers) controller.abort(new Error('done'));
      await Promise.all(waiting);
    }
    // Once they end, a wait is taken again.
    expect((await current().call('wait', { timeoutSeconds: 0 }, caller)).ok).toBe(true);
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
