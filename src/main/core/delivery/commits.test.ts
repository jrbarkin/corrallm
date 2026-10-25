import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { SessionMode } from '../../../shared/session';
import type { Connector, SessionHost } from '../../sessions/connector';
import { FakeConnector } from '../../sessions/fake';
import type { Caller, OutsideCaller } from '../caller';
import { createCore } from '../core';
import type { Core } from '../core';
import { MessageStore } from './messages';
import { Store } from '../store/store';
import { journaledRun, keepCanvases, readOnDisk, refuseWrites } from '../store/test-store';
import { CALLERS, CANVAS, NO_DESKTOP } from '../test-registry';

/*
 * What the core journals is on disk before what depends on it happens (API Spec §5.3, Core
 * Database §4): a message's record before it is sent, journaled delivering, with the id it is sent
 * under; a run's record before the run's own message goes; a hold before the op that set it
 * returns. And what changes together is committed together, or not at all: a kill's hold with the
 * withdrawals it makes, a turn's reply with what its end changed in the run. A connection of the
 * test's own reads what is on disk; the database's commits are held, or refused, while a test says
 * so.
 */

const OUTSIDE = CALLERS['outside-write'] as OutsideCaller;

let profile: string;
let core: Core | undefined;

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-commits-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
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
  await keepCanvases(profile, { [CANVAS]: { file, project } });
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

/**
 * Holds every commit of the database asked for from now on (once those asked for already are
 * committed, a write asked for meanwhile among them) until what it returns is called: with
 * `messages`, only those its message stores ask for themselves (as a message's record, or a
 * delivering one, on its way to disk), not the run's.
 */
async function holdCommits(only?: 'messages'): Promise<() => void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
  const held = Promise.withResolvers<undefined>();
  if (only === 'messages') {
    const { value: durable } = Object.getOwnPropertyDescriptor(
      MessageStore.prototype,
      'durable',
    ) as {
      value: MessageStore['durable'];
    };
    vi.spyOn(MessageStore.prototype, 'durable').mockImplementation(function (this: MessageStore) {
      // Run journaling can commit message rows too. Hold delivery's durability barrier itself,
      // regardless of which write happens to carry those rows to disk first.
      return held.promise.then(() => durable.call(this));
    });
  } else {
    const { value: write } = Object.getOwnPropertyDescriptor(Store.prototype, 'write') as {
      value: Store['write'];
    };
    vi.spyOn(Store.prototype, 'write').mockImplementation(function (this: Store, run) {
      return held.promise.then(() => write.call(this, run));
    });
  }
  return () => {
    held.resolve(undefined);
  };
}

/** The pauses the canvas's run, as on disk, holds its agents by. */
function pausesOnDisk(): { id: string; by: string }[] {
  const state = journaledRun(profile, CANVAS)?.state;
  if (state === undefined) return [];
  const { run } = JSON.parse(state) as { run: { individualPauses?: { id: string; by: string }[] } };
  return run.individualPauses ?? [];
}

/** A message's row as on disk: its state and the id it was sent under. */
function onDisk(id: string): { state: string; as: string | undefined } | undefined {
  const row = readOnDisk(profile, (disk) =>
    disk.prepare('SELECT state, delivery FROM message WHERE id = ?').get(id),
  );
  if (row === undefined) return undefined;
  const delivery =
    typeof row.delivery === 'string' ? (JSON.parse(row.delivery) as { as: string }) : undefined;
  return { state: String(row.state), as: delivery?.as };
}

/** A connector on the fake whose sessions tell `sent` each message as it reaches them. */
function watching(sent: (text: string, id: string) => void): Connector<SessionMode> {
  const codex = new FakeConnector({ adapter: 'codex' });
  return {
    start: async (spec, host) => {
      const session = await codex.start(spec, host);
      const send = session.send.bind(session);
      session.send = (message) => {
        sent(message.text, message.id);
        return send(message);
      };
      return session;
    },
  };
}

it.each(['run.pause', 'run.kill', 'run.unpause'] as const)(
  '%s takes effect at once but returns only once its run record is on disk',
  async (op) => {
    const { engines } = await start(new FakeConnector({ adapter: 'codex' }));
    const target = { agent: 'builder' };
    if (op === 'run.unpause') await ok('run.pause', { target });
    const release = await holdCommits();
    let settled = false;
    let seen: { id: string; by: string }[] | undefined;
    const result = ok(op, { target }).then((value) => {
      settled = true;
      seen = pausesOnDisk();
      return value;
    });
    try {
      await vi.waitFor(() => {
        expect(engines.canvas(CANVAS)?.engine.run.holding(target).length).toBe(
          op === 'run.unpause' ? 0 : 1,
        );
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      expect(settled).toBe(false);
    } finally {
      release();
      await result;
    }
    // As it returned, the run's record on disk had the change.
    expect(seen).toEqual(
      op === 'run.unpause' ? [] : [{ id: 'builder', by: 'outside:orchestrator' }],
    );
  },
);

it.each(['run.pause', 'run.kill', 'run.unpause'] as const)(
  '%s says its immediate change may not survive a restart when its record cannot be written',
  async (op) => {
    const { engines } = await start(new FakeConnector({ adapter: 'codex' }));
    const target = { agent: 'builder' };
    if (op === 'run.unpause') await ok('run.pause', { target });
    const allow = refuseWrites(profile, 'run', 'The disk is full');
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
      allow();
    }
  },
);

it('returns from a kill only once its hold and every withdrawal it made are on disk', async () => {
  const { engines } = await start(new FakeConnector({ adapter: 'codex', pause: 100 }));
  const open = engines.canvas(CANVAS);
  const active = await ok<{ id: string }>('message', { to: 'builder', body: 'Working' });
  await vi.waitFor(() => {
    expect(open?.messages.get(active.id)?.state).toBe('delivered');
  });
  const waiting = await ok<{ id: string }>('message', { to: 'builder', body: 'Next' });
  const release = await holdCommits();
  let settled = false;
  const result = ok('run.kill', { target: { agent: 'builder' } }).then(() => {
    settled = true;
    return { holds: pausesOnDisk(), active: onDisk(active.id), waiting: onDisk(waiting.id) };
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
    release();
  }
  expect(await result).toMatchObject({
    holds: [{ id: 'builder', by: 'outside:orchestrator' }],
    active: { state: 'withdrawn' },
    waiting: { state: 'withdrawn' },
  });
});

it('commits a kill’s hold with the withdrawals it makes at once, or neither', async () => {
  const { engines } = await start(new FakeConnector({ adapter: 'codex' }));
  const open = engines.canvas(CANVAS);
  await ok('run.pause', { target: { agent: 'builder' } }, CALLERS.you);
  const waiting = await ok<{ id: string }>('message', { to: 'builder', body: 'Waits' });
  expect(pausesOnDisk()).toEqual([{ id: 'builder', by: 'you' }]);
  // Its withdrawal can't be written: nor can its hold.
  const allow = refuseWrites(profile, 'message', 'The disk is full');
  try {
    expect(
      await core?.call('run.kill', { canvas: CANVAS, target: { agent: 'builder' } }, OUTSIDE),
    ).toMatchObject({ ok: false, error: { code: 'unavailable' } });
    expect(open?.messages.get(waiting.id)?.state).toBe('withdrawn');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(pausesOnDisk()).toEqual([{ id: 'builder', by: 'you' }]);
    expect(onDisk(waiting.id)?.state).toBe('pending');
  } finally {
    allow();
  }
  // Both land with the next write.
  await open?.journal();
  expect(pausesOnDisk()).toEqual([
    { id: 'builder', by: 'you' },
    { id: 'builder', by: 'outside:orchestrator' },
  ]);
  expect(onDisk(waiting.id)?.state).toBe('withdrawn');
});

it('commits a turn’s reply with what its end changed in the run, or neither', async () => {
  // Builder's turns go on until the test ends them.
  let host: SessionHost | undefined;
  let turn = '';
  const codex = new FakeConnector({ adapter: 'codex' });
  const { engines } = await start({
    start: async (spec, given) => {
      host = given;
      const session = await codex.start(spec, given);
      session.send = (message) => {
        turn = message.id;
        given.emit({ type: 'user', id: message.id, text: message.text });
        given.emit({ type: 'status', status: 'working' });
        return Promise.resolve();
      };
      return session;
    },
  });
  const open = engines.canvas(CANVAS);
  const { id } = await ok<{ id: string }>('message', { to: 'builder', body: 'Hello' }, CALLERS.you);
  await vi.waitFor(() => {
    expect(onDisk(id)?.state).toBe('delivered');
  });
  /** What the run on disk records of your message's turn. */
  const recorded = () => {
    const { agents } = JSON.parse(journaledRun(profile, CANVAS)?.messages ?? '{"agents":[]}') as {
      agents: { submissions: { status: string }[] }[];
    };
    return agents.flatMap(({ submissions }) => submissions.map(({ status }) => status));
  };
  await open?.journal();
  expect(recorded()).toEqual(['running']);
  const replies = () =>
    readOnDisk(profile, (disk) =>
      disk.prepare('SELECT body FROM message WHERE reply_to = ? AND kind = ?').all(id, 'text'),
    );

  // The run can't be written as the turn ends: nor can its reply.
  const allow = refuseWrites(profile, 'run', 'The disk is full');
  try {
    host?.emit({ type: 'text', id: `${turn}/reply`, text: 'Hello back' });
    host?.emit({
      type: 'end',
      messages: [turn],
      seconds: 1,
      result: { status: 'completed', reason: 'completed' },
    });
    await vi.waitFor(() => {
      expect(open?.messages.get(id)?.state).toBe('replied');
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(replies()).toEqual([]);
    expect(onDisk(id)?.state).toBe('delivered');
    expect(recorded()).toEqual(['running']);
  } finally {
    allow();
  }
  await open?.messages.durable();
  expect(replies()).toEqual([{ body: 'Hello back' }]);
  expect(onDisk(id)?.state).toBe('replied');
  expect(recorded()).toEqual(['completed']);
});

it('sends a message only once its delivering record is committed, with the id it is sent under', async () => {
  const seen: { as: string; row: ReturnType<typeof onDisk> }[] = [];
  let message = '';
  await start(
    watching((_, as) => {
      seen.push({ as, row: onDisk(message) });
    }),
  );
  message = (await ok<{ id: string }>('message', { to: 'builder', body: 'Say hello' })).id;
  await vi.waitFor(() => {
    expect(seen).toHaveLength(1);
  });
  expect(seen[0]?.row).toEqual({ state: 'delivering', as: seen[0]?.as });
});

it('sends the run’s own message only once the run’s record is on disk (Core Server §7.7)', async () => {
  /** The builder's run, as on disk, as each message reached its session. */
  const before: unknown[] = [];
  const engine = await (
    await start(
      watching(() => {
        const state = journaledRun(profile, CANVAS)?.state;
        before.push(state && (JSON.parse(state) as { run: { agents: unknown } }).run.agents);
      }),
      [{ id: 'hello', message: 'Say hello' }],
    )
  ).engines.open(CANVAS);
  engine.run.start();
  await vi.waitFor(() => {
    expect(before).toHaveLength(1);
  });
  expect(before).toMatchObject([{ builder: { status: 'running', current: 'hello' } }]);
});

it('delivers the next message once one taken back while it was journaled is withdrawn', async () => {
  const codex = new FakeConnector({ adapter: 'codex' });
  const messages = (await start(codex)).engines.canvas(CANVAS)?.messages;
  await ok('run.pause', { target: { agent: 'builder' } }, CALLERS.you);
  const first = await ok<{ id: string }>('message', { to: 'builder', body: 'First' });
  const other: OutsideCaller = { ...OUTSIDE, token: 'other-token', name: 'other' };
  const second = await ok<{ id: string }>('message', { to: 'builder', body: 'Second' }, other);
  // The first's delivering record is held on its way to disk, and taken back meanwhile.
  const release = await holdCommits('messages');
  try {
    await ok('run.unpause', { target: { agent: 'builder' } }, CALLERS.you);
    await vi.waitFor(() => {
      expect(messages?.get(first.id)?.state).toBe('delivering');
    });
    expect(await ok('withdraw', { id: first.id })).toEqual({
      reached: false,
      interrupted: false,
      revs: expect.any(Object) as Record<string, number>,
    });
  } finally {
    release();
  }
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
  // Its pending record is on disk; its delivering one can't be committed, and nor can the release
  // of the pause that lets it go, written with it.
  const allow = refuseWrites(profile, 'message', 'The disk is full');
  try {
    expect(
      await core?.call(
        'run.unpause',
        { canvas: CANVAS, target: { agent: 'builder' } },
        CALLERS.you,
      ),
    ).toMatchObject({ ok: false, error: { code: 'unavailable' } });
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
  } finally {
    allow();
  }
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
  const release = await holdCommits('messages');
  try {
    await ok('run.unpause', { target: { agent: 'builder' } }, CALLERS.you);
    await vi.waitFor(() => {
      expect(messages?.get(id)?.state).toBe('delivering');
    });
    await ok('run.pause', { target: { agent: 'builder' } }, CALLERS.you);
  } finally {
    release();
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  // Handed to its session, it waits in its queue there, as the run's own sends do.
  expect(codex.sessions.flatMap((session) => session.sent)).toEqual([]);
  await ok('run.unpause', { target: { agent: 'builder' } }, CALLERS.you);
  await vi.waitFor(() => {
    expect(messages?.get(id)?.state).toBe('replied');
  });
});

it('refuses a message whose record can’t be committed, and never sends it', async () => {
  const codex = new FakeConnector({ adapter: 'codex' });
  const messages = (await start(codex)).engines.canvas(CANVAS)?.messages;
  const allow = refuseWrites(profile, 'message', 'The disk is full');
  try {
    expect(
      await core?.call('message', { canvas: CANVAS, to: 'builder', body: 'Lost' }, OUTSIDE),
    ).toEqual({ ok: false, error: { code: 'unavailable', sentence: 'The disk is full' } });
  } finally {
    allow();
  }
  // What comes next goes; the refused one never does, though the disk works again.
  const next = await ok<{ id: string }>('message', { to: 'builder', body: 'Next' });
  await vi.waitFor(() => {
    expect(messages?.get(next.id)?.state).toBe('replied');
  });
  expect(codex.sessions.flatMap((session) => session.sent.map(({ text }) => text))).toEqual([
    expect.stringMatching(/Next$/) as string,
  ]);
  const lost = messages?.all().find(({ body }) => body === 'Lost');
  expect(lost).toMatchObject({
    state: 'unresolved',
    turn: { status: 'failed', reason: 'error', message: 'The disk is full' },
  });
  expect(onDisk(lost?.id ?? '')?.state).toBe('unresolved');
});
