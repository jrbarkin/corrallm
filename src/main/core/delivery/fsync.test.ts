import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { Message } from '../../../shared/model/messages';
import type { SessionMode } from '../../../shared/session';
import type { Connector } from '../../sessions/connector';
import { FakeConnector } from '../../sessions/fake';
import type { Caller, OutsideCaller } from '../caller';
import { createCore } from '../core';
import type { Core } from '../core';
import { CALLERS, CANVAS, NO_DESKTOP } from '../test-registry';

/*
 * A message's record reaches the disk before it is sent (API Spec §5.3): the core journals it
 * delivering, with the id it will send under, forces that to disk, and only then sends. A fake fs
 * records each record appended to the message log (its message, state and delivery id) and each
 * fsync, and the agent's session each message it is sent, in one list; and holds every fsync while
 * a test holds its gate, or fails it while the gate says so.
 */

const events = vi.hoisted(() => [] as string[]);
const gate = vi.hoisted(() => ({ held: undefined as Promise<void> | undefined, fails: false }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const file = path.basename(String(args[0]));
      const append = handle.appendFile.bind(handle);
      handle.appendFile = async (data, options) => {
        // The journal appends text.
        if (file === 'messages.jsonl' && typeof data === 'string') {
          for (const line of data.split('\n').filter(Boolean)) {
            const { message } = JSON.parse(line) as { message: Message };
            events.push(`append ${message.id} ${message.state} ${message.delivery?.as ?? '-'}`);
          }
        }
        await append(data, options);
      };
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        await gate.held;
        if (gate.fails) throw new Error('EIO: i/o error, fsync');
        await sync();
        events.push(`fsync ${file}`);
      };
      return handle;
    },
    // The log written anew, whole, lands with a rename.
    rename: async (...args: Parameters<typeof actual.rename>) => {
      await actual.rename(...args);
      const file = path.basename(String(args[1]));
      if (file === 'messages.jsonl') events.push(`rewrite ${file}`);
    },
  };
});

const OUTSIDE = CALLERS['outside-write'] as OutsideCaller;

let profile: string;
let core: Core | undefined;

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-fsync-'));
  events.length = 0;
});

afterEach(async () => {
  gate.held = undefined;
  gate.fails = false;
  await core?.close();
  core = undefined;
  await rm(profile, { recursive: true, force: true });
});

/** Starts the core over a profile keeping a canvas of Builder, on Codex's App Server: `connector`. */
async function start(connector: Connector<SessionMode>): Promise<Core> {
  const project = path.join(profile, 'project');
  await mkdir(project);
  const file = path.join(profile, 'canvas.corral');
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
  await writeFile(
    path.join(profile, 'canvases.json'),
    JSON.stringify({ version: 2, canvases: { [CANVAS]: { file, project, conversations: {} } } }),
  );
  core = await createCore(
    {
      profile,
      app: { name: 'corrallm', version: '9.8.7' },
      check: true,
      distribution: 'local',
      sessions: {
        connectors: { 'codex.app-server': connector },
        environment: () => Promise.resolve({}),
      },
    },
    NO_DESKTOP,
  );
  await core.engines.open(CANVAS);
  return core;
}

/** Calls `name` on the canvas as `caller`, expecting it to work: its result. */
async function ok<T = Record<string, unknown>>(
  name: string,
  args: Record<string, unknown>,
  caller: Caller = OUTSIDE,
): Promise<T> {
  const result = await core?.call(name as never, { canvas: CANVAS, ...args }, caller);
  if (!result?.ok) throw new Error(`${name} failed: ${JSON.stringify(result)}`);
  return result.value;
}

it('sends a message only once its delivering record is on disk', async () => {
  const codex = new FakeConnector({ adapter: 'codex' });
  await start({
    start: async (spec, host) => {
      const session = await codex.start(spec, host);
      const send = session.send.bind(session);
      session.send = (message) => {
        events.push(`send ${message.id}`);
        return send(message);
      };
      return session;
    },
  });
  const { id } = await ok<{ id: string }>('message', { to: 'builder', body: 'Say hello' });
  await vi.waitFor(() => {
    expect(events.some((event) => event.startsWith('send '))).toBe(true);
  });
  const sendAt = events.findIndex((event) => event.startsWith('send '));
  const as = events[sendAt]?.slice('send '.length);
  // Its delivering record, with the id it was sent under, was appended, and then forced to disk.
  const appendedAt = events.indexOf(`append ${id} delivering ${String(as)}`);
  expect(appendedAt).toBeGreaterThan(-1);
  expect(events.slice(0, sendAt).lastIndexOf('fsync messages.jsonl')).toBeGreaterThan(appendedAt);
});

it('forces a delivering record written with the log anew to disk before it sends', async () => {
  // A log grown past the store's budget (a waiting message, changed many times) is written anew
  // with the next record: the delivering one.
  const log = path.join(profile, 'runs', CANVAS, 'messages.jsonl');
  await mkdir(path.dirname(log), { recursive: true });
  const id = crypto.randomUUID();
  const line = (i: number) =>
    JSON.stringify({
      seq: 1,
      message: {
        id,
        canvas: CANVAS,
        from: 'outside:orchestrator',
        to: 'agent:builder',
        kind: 'text',
        body: `${String(i)} ${'x'.repeat(16 * 1024)}`,
        state: 'pending',
        at: 1,
      },
    });
  await writeFile(log, Array.from({ length: 260 }, (_, i) => `${line(i)}\n`).join(''));
  const codex = new FakeConnector({ adapter: 'codex' });
  await start({
    start: async (spec, host) => {
      const session = await codex.start(spec, host);
      const send = session.send.bind(session);
      session.send = (message) => {
        events.push(`send ${message.id}`);
        return send(message);
      };
      return session;
    },
  });
  await vi.waitFor(() => {
    expect(events.some((event) => event.startsWith('send '))).toBe(true);
  });
  const sendAt = events.findIndex((event) => event.startsWith('send '));
  const rewriteAt = events.indexOf('rewrite messages.jsonl');
  expect(rewriteAt).toBeGreaterThan(-1);
  expect(events.slice(rewriteAt, sendAt)).toContain('fsync messages.jsonl');
});

it('delivers the next message once one taken back while it was journaled is withdrawn', async () => {
  const codex = new FakeConnector({ adapter: 'codex' });
  const messages = (await start(codex)).engines.canvas(CANVAS)?.messages;
  await ok('run.pause', { target: { agent: 'builder' } }, CALLERS.you);
  const first = await ok<{ id: string }>('message', { to: 'builder', body: 'First' });
  const other: OutsideCaller = { ...OUTSIDE, token: 'other-token', name: 'other' };
  const second = await ok<{ id: string }>('message', { to: 'builder', body: 'Second' }, other);
  // The first's delivering record is held on its way to disk, and taken back meanwhile.
  const held = Promise.withResolvers<undefined>();
  gate.held = held.promise;
  await ok('run.unpause', { target: { agent: 'builder' } }, CALLERS.you);
  await vi.waitFor(() => {
    expect(messages?.get(first.id)?.state).toBe('delivering');
  });
  await ok('withdraw', { id: first.id });
  gate.held = undefined;
  held.resolve(undefined);
  await vi.waitFor(() => {
    expect(messages?.get(second.id)?.state).toBe('replied');
  });
  expect(messages?.get(first.id)?.state).toBe('withdrawn');
  expect(codex.sessions.flatMap((session) => session.sent.map(({ text }) => text))).toEqual([
    expect.stringMatching(/Second$/) as string,
  ]);
});

it('keeps waiting what it couldn’t record as delivering, and sends it once its disk works again', async () => {
  const codex = new FakeConnector({ adapter: 'codex' });
  const messages = (await start(codex)).engines.canvas(CANVAS)?.messages;
  await ok('run.pause', { target: { agent: 'builder' } }, CALLERS.you);
  const first = await ok<{ id: string }>('message', { to: 'builder', body: 'First' });
  const other: OutsideCaller = { ...OUTSIDE, token: 'other-token', name: 'other' };
  const second = await ok<{ id: string }>('message', { to: 'builder', body: 'Second' }, other);
  // Its pending record is on disk; its delivering one can't be forced there.
  gate.fails = true;
  await ok('run.unpause', { target: { agent: 'builder' } }, CALLERS.you);
  await vi.waitFor(() => {
    expect(messages?.get(first.id)?.delivery?.attempt).toBe(1);
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  // Never sent, it waits again, first in line, and so does what is behind it: no one is told.
  expect([first.id, second.id].map((id) => messages?.get(id)?.state)).toEqual([
    'pending',
    'pending',
  ]);
  expect(messages?.all().filter(({ body }) => body.includes('wasn’t sent'))).toEqual([]);
  expect(codex.sessions.flatMap((session) => session.sent)).toEqual([]);

  gate.fails = false;
  await vi.waitFor(
    () => {
      expect(messages?.get(second.id)?.state).toBe('replied');
    },
    { timeout: 3000 },
  );
  expect(messages?.get(first.id)).toMatchObject({ state: 'replied', delivery: { attempt: 2 } });
  expect(codex.sessions.flatMap((session) => session.sent.map(({ text }) => text))).toEqual([
    expect.stringMatching(/First$/) as string,
    expect.stringMatching(/Second$/) as string,
  ]);
});

it('holds a party’s message in its session’s queue when its agent is paused while it was journaled', async () => {
  const codex = new FakeConnector({ adapter: 'codex' });
  const messages = (await start(codex)).engines.canvas(CANVAS)?.messages;
  await ok('run.pause', { target: { agent: 'builder' } }, CALLERS.you);
  const { id } = await ok<{ id: string }>('message', { to: 'builder', body: 'Wait for me' });
  // Its delivering record is held on its way to disk; meanwhile its agent is paused again.
  const held = Promise.withResolvers<undefined>();
  gate.held = held.promise;
  await ok('run.unpause', { target: { agent: 'builder' } }, CALLERS.you);
  await vi.waitFor(() => {
    expect(messages?.get(id)?.state).toBe('delivering');
  });
  await ok('run.pause', { target: { agent: 'builder' } }, CALLERS.you);
  gate.held = undefined;
  held.resolve(undefined);
  await new Promise((resolve) => setTimeout(resolve, 50));
  // Handed to its session, it waits in its queue there, as the run's own sends do.
  expect(codex.sessions.flatMap((session) => session.sent)).toEqual([]);
  await ok('run.unpause', { target: { agent: 'builder' } }, CALLERS.you);
  await vi.waitFor(() => {
    expect(messages?.get(id)?.state).toBe('replied');
  });
});

it('refuses a message whose record can’t be forced to disk, and never sends it', async () => {
  const codex = new FakeConnector({ adapter: 'codex' });
  const messages = (await start(codex)).engines.canvas(CANVAS)?.messages;
  gate.fails = true;
  expect(
    await core?.call('message', { canvas: CANVAS, to: 'builder', body: 'Lost' }, OUTSIDE),
  ).toEqual({ ok: false, error: { code: 'unavailable', sentence: 'EIO: i/o error, fsync' } });
  gate.fails = false;
  // What comes next goes; the refused one never does, though the disk works again.
  const next = await ok<{ id: string }>('message', { to: 'builder', body: 'Next' });
  await vi.waitFor(() => {
    expect(messages?.get(next.id)?.state).toBe('replied');
  });
  expect(codex.sessions.flatMap((session) => session.sent.map(({ text }) => text))).toEqual([
    expect.stringMatching(/Next$/) as string,
  ]);
  expect(messages?.all().find(({ body }) => body === 'Lost')).toMatchObject({
    state: 'unresolved',
    turn: { status: 'failed', reason: 'error', message: 'EIO: i/o error, fsync' },
  });
});
