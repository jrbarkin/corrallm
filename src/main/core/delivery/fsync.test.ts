import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
const gate = vi.hoisted(() => ({
  held: undefined as Promise<void> | undefined,
  fails: false,
  only: undefined as 'record' | 'messages' | undefined,
}));

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
        if (
          gate.only === undefined ||
          (gate.only === 'record' && file.startsWith('record.json.')) ||
          (gate.only === 'messages' && file === 'messages.jsonl')
        ) {
          await gate.held;
          if (gate.fails) throw new Error('EIO: i/o error, fsync');
        }
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
  gate.only = undefined;
  await core?.close();
  core = undefined;
  await rm(profile, { recursive: true, force: true });
});

/**
 * Starts the core over a profile keeping a canvas of Builder, on Codex's App Server: `connector`;
 * with `queue`, what Builder's queue holds.
 */
async function start(connector: Connector<SessionMode>, queue?: unknown[]): Promise<Core> {
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
          ...(queue === undefined ? {} : { queue }),
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

it.each(['run.pause', 'run.kill', 'run.unpause'] as const)(
  '%s takes effect at once but returns only once its run record is forced to disk',
  async (op) => {
    const { engines } = await start(new FakeConnector({ adapter: 'codex' }));
    const target = { agent: 'builder' };
    if (op === 'run.unpause') await ok('run.pause', { target });
    const held = Promise.withResolvers<undefined>();
    gate.only = 'record';
    gate.held = held.promise;
    let settled = false;
    const result = ok(op, { target }).then((value) => {
      settled = true;
      return value;
    });
    try {
      await vi.waitFor(() => {
        expect(engines.canvas(CANVAS)?.engine.run.holding(target).length).toBe(
          op === 'run.unpause' ? 0 : 1,
        );
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
    } finally {
      gate.held = undefined;
      held.resolve(undefined);
      await result;
    }
    const record = JSON.parse(
      await readFile(path.join(profile, 'runs', CANVAS, 'record.json'), 'utf8'),
    ) as { checkpoint: { state: string } };
    const { run } = JSON.parse(record.checkpoint.state) as {
      run: { individualPauses?: { id: string; by: string }[] };
    };
    expect(run.individualPauses ?? []).toEqual(
      op === 'run.unpause' ? [] : [{ id: 'builder', by: 'outside:orchestrator' }],
    );
    expect(events.some((event) => /^fsync record\.json\..+\.partial$/.test(event))).toBe(true);
  },
);

it.each(['run.pause', 'run.kill', 'run.unpause'] as const)(
  '%s says its immediate change may not survive a restart when its record cannot be forced',
  async (op) => {
    const { engines } = await start(new FakeConnector({ adapter: 'codex' }));
    const target = { agent: 'builder' };
    if (op === 'run.unpause') await ok('run.pause', { target });
    gate.only = 'record';
    gate.fails = true;
    try {
      expect(await core?.call(op, { canvas: CANVAS, target }, OUTSIDE)).toEqual({
        ok: false,
        error: {
          code: 'unavailable',
          sentence: {
            'run.pause':
              'The hold is in place now, but it could not be saved and may not survive a restart.',
            'run.kill':
              'The hold is in place now, and what was sent to or from it taken back, but not all of it could be saved, so it may not survive a restart.',
            'run.unpause':
              'The pause is released now, but the release could not be saved and may not survive a restart.',
          }[op],
        },
      });
      expect(engines.canvas(CANVAS)?.engine.run.holding(target).length).toBe(
        op === 'run.unpause' ? 0 : 1,
      );
    } finally {
      gate.fails = false;
    }
  },
);

it('returns from a kill only once its hold and pending and active withdrawals are forced to disk', async () => {
  const { engines } = await start(new FakeConnector({ adapter: 'codex', pause: 100 }));
  const open = engines.canvas(CANVAS);
  const active = await ok<{ id: string }>('message', { to: 'builder', body: 'Working' });
  await vi.waitFor(() => {
    expect(open?.messages.get(active.id)?.state).toBe('delivered');
  });
  const waiting = await ok<{ id: string }>('message', { to: 'builder', body: 'Next' });
  const held = Promise.withResolvers<undefined>();
  gate.only = 'messages';
  gate.held = held.promise;
  let settled = false;
  const result = ok('run.kill', { target: { agent: 'builder' } }).then(() => {
    settled = true;
  });
  try {
    await vi.waitFor(() => {
      expect([active.id, waiting.id].map((id) => open?.messages.get(id)?.state)).toEqual([
        'withdrawn',
        'withdrawn',
      ]);
    });
    expect(settled).toBe(false);
  } finally {
    gate.held = undefined;
    held.resolve(undefined);
    await result;
  }
  const forced = events.lastIndexOf('fsync messages.jsonl');
  for (const { id } of [active, waiting]) {
    const appended = events.findIndex((event) => event.startsWith(`append ${id} withdrawn `));
    expect(appended).toBeGreaterThan(-1);
    expect(forced).toBeGreaterThan(appended);
  }
  const record = events.findIndex((event) => /^fsync record\.json\..+\.partial$/.test(event));
  expect(record).toBeGreaterThan(-1);
  expect(record).toBeLessThan(
    events.findIndex((event) => event.startsWith(`append ${waiting.id} withdrawn `)),
  );
});

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

it('sends the run’s own message only once the run’s record is on disk (Core Server §7.7)', async () => {
  const codex = new FakeConnector({ adapter: 'codex' });
  const engine = await (
    await start(
      {
        start: async (spec, host) => {
          const session = await codex.start(spec, host);
          const send = session.send.bind(session);
          session.send = (message) => {
            events.push(`send ${message.id}`);
            return send(message);
          };
          return session;
        },
      },
      [{ id: 'hello', message: 'Say hello' }],
    )
  ).engines.open(CANVAS);
  engine.run.start();
  await vi.waitFor(() => {
    expect(events.some((event) => event.startsWith('send '))).toBe(true);
  });
  const before = events.slice(
    0,
    events.findIndex((event) => event.startsWith('send ')),
  );
  // The record written whole for the send was forced to disk, and then the folder it was moved into.
  const recordAt = before.findLastIndex((event) => /^fsync record\.json\..+\.partial$/.test(event));
  expect(recordAt).toBeGreaterThan(-1);
  expect(before.slice(recordAt)).toContain(`fsync ${CANVAS}`);
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
  // The log written anew was forced to disk before it was moved into place, and the folder it was
  // moved into after: a power loss can't bring the old log back over what was appended since.
  expect(events[rewriteAt - 1]).toMatch(/^fsync messages\.jsonl\..+\.partial$/);
  expect(events.slice(rewriteAt, sendAt)).toContain(`fsync ${CANVAS}`);
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
  gate.only = 'messages';
  gate.held = held.promise;
  await ok('run.unpause', { target: { agent: 'builder' } }, CALLERS.you);
  await vi.waitFor(() => {
    expect(messages?.get(first.id)?.state).toBe('delivering');
  });
  expect(await ok('withdraw', { id: first.id })).toEqual({ reached: false, interrupted: false });
  gate.held = undefined;
  held.resolve(undefined);
  await vi.waitFor(() => {
    expect(messages?.get(second.id)?.state).toBe('replied');
  });
  expect(messages?.get(first.id)?.state).toBe('withdrawn');
  expect(
    codex.sessions.flatMap((session) => session.sent).every(({ text }) => !text.includes(first.id)),
  ).toBe(true);
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
  gate.only = 'messages';
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
  gate.only = 'messages';
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
