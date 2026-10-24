import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CanvasId } from '../../shared/canvas';
import type { Message } from '../../shared/model/messages';
import type { SessionHost } from '../sessions/connector';
import type { SessionMode, UserMessage } from '../../shared/session';
import type { Connector } from '../sessions/connector';
import { FakeConnector } from '../sessions/fake';
import type { OutsideCaller } from './caller';
import { createCore } from './core';
import type { Core } from './core';
import { STORE_FILE } from './store/open';
import { keepCanvases, readOnDisk, refuseWrites } from './store/test-store';
import { CALLERS, NO_DESKTOP } from './test-registry';

/*
 * The run's own sends go through the durable mailbox (B11 Design §3): each of a task's attempts is
 * a message, from corrallm (or, for a hand-off, the queue's agent; for a correction you typed,
 * you), recorded with its attempt's link in the write that journals its run, on disk before its
 * agent's session gets it; settled as its turn ends, in the write that holds the run's result, or
 * withdrawn when it is taken back or never goes. Delivery never sends it: the run does.
 */

/** A canvas with one Codex agent whose queue sends it a message (its id is the file's). */
const FIXTURE = path.join(import.meta.dirname, 'test-worker.corral');
const CANVAS = '4b1f6c2e-8d3a-4e5f-9a0b-7c6d5e4f3a2b' as CanvasId;
const ORCHESTRATOR: OutsideCaller = {
  kind: 'outside',
  token: 'write-token',
  name: 'orchestrator',
  access: 'write',
  canvases: [CANVAS],
};

let profile: string;
let project: string;
const cores: Core[] = [];

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-run-sends-'));
  project = path.join(profile, 'project');
  await mkdir(project);
  const file = path.join(profile, 'worker.corral');
  await copyFile(FIXTURE, file);
  await keepCanvases(profile, { [CANVAS]: { file, project } });
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const core of cores.splice(0)) await core.close().catch(() => undefined);
  await rm(profile, { recursive: true, force: true });
});

async function start(codex: Connector<SessionMode>, at = profile): Promise<Core> {
  const core = await createCore(
    {
      profile: at,
      app: { name: 'corrallm', version: '9.8.7' },
      check: true,
      distribution: 'local',
      sessions: {
        connectors: { 'codex.app-server': codex },
        environment: () => Promise.resolve({}),
      },
      watchFolder: () => ({ close: () => undefined }),
    },
    NO_DESKTOP,
  );
  cores.push(core);
  return core;
}

/** A row of `message` as on disk, its JSON columns read. */
interface Row {
  id: string;
  from_party: string;
  to_party: string;
  origin: string;
  state: string;
  task: { agent: string; item: string; attempt: string } | null;
  delivery: { as: string } | null;
  turn: { status: string } | null;
}

/** The canvas's messages as on disk, whoever has the database open. */
function rowsOnDisk(at = profile): Row[] {
  return readOnDisk(at, (disk) =>
    disk
      .prepare(
        'SELECT id, from_party, to_party, origin, state, task, delivery, turn FROM message WHERE canvas_id = ? ORDER BY seq',
      )
      .all(CANVAS)
      .map((row) => ({
        ...(row as unknown as Row),
        task: JSON.parse(String(row.task ?? 'null')) as Row['task'],
        delivery: JSON.parse(String(row.delivery ?? 'null')) as Row['delivery'],
        turn: JSON.parse(String(row.turn ?? 'null')) as Row['turn'],
      })),
  );
}

/** The worker's attempts at its task, as journaled on disk. */
function attemptsOnDisk(at = profile): { id: string; status: string; messageId?: string }[] {
  const state = readOnDisk(at, (disk) =>
    disk
      .prepare("SELECT json_extract(state, '$.run') AS run FROM run WHERE canvas_id = ?")
      .get(CANVAS),
  );
  if (state === undefined) return [];
  const run = JSON.parse(String(state.run)) as {
    run: {
      agents: Record<string, { attempts?: Record<string, { id: string; status: string }[]> }>;
    };
  };
  return run.run.agents.worker?.attempts?.hello ?? [];
}

/** A connector whose agent takes each message and works on it until the test ends its turn. */
function busy() {
  const codex = new FakeConnector({ adapter: 'codex' });
  const sent: UserMessage[] = [];
  let host: SessionHost | undefined;
  const connector: Connector<SessionMode> = {
    start: async (spec, given) => {
      host = given;
      const session = await codex.start(spec, given);
      session.send = (message) => {
        sent.push(message);
        given.emit({ type: 'user', id: message.id, text: message.text });
        given.emit({ type: 'status', status: 'working' });
        return Promise.resolve();
      };
      return session;
    },
  };
  /** Ends the turn of the messages `ids`, as its CLI says: completed unless said. */
  const end = (ids: readonly string[], status: 'completed' | 'cancelled' = 'completed') => {
    host?.emit({ type: 'text', id: `reply-${ids.join('-')}`, text: 'Hello' });
    host?.emit({
      type: 'end',
      messages: [...ids],
      seconds: 1,
      result: { status, reason: status === 'completed' ? 'completed' : 'interrupted' },
    });
  };
  return { connector, codex, sent, end };
}

async function messageOf(core: Core, id: string): Promise<Message | undefined> {
  return (await core.engines.messagesOf(CANVAS)).get(id);
}

describe('the run’s own sends', () => {
  it('records each attempt’s message and its link on disk before the agent’s session gets it', async () => {
    const codex = new FakeConnector({ adapter: 'codex' });
    /** What was on disk each time a message reached the agent's session. */
    const before: { rows: Row[]; attempts: ReturnType<typeof attemptsOnDisk> }[] = [];
    const ids: string[] = [];
    const watched: Connector<SessionMode> = {
      start: async (spec, host) => {
        const session = await codex.start(spec, host);
        const send = session.send.bind(session);
        session.send = (message) => {
          ids.push(message.id);
          before.push({ rows: rowsOnDisk(), attempts: attemptsOnDisk() });
          return send(message);
        };
        return session;
      },
    };
    const core = await start(watched);
    const engine = await core.engines.open(CANVAS);
    engine.run.start();
    await vi.waitFor(() => {
      expect(engine.run.snapshot().agents.worker).toMatchObject({
        status: 'done',
        outcomes: { hello: 'succeeded' },
      });
    });
    const [id] = ids;
    const attempt = engine.run.snapshot().agents.worker?.attempts?.hello?.[0];
    expect(attempt).toMatchObject({ messageId: id, status: 'succeeded' });
    // Its message and its attempt's link were on disk first.
    expect(before).toEqual([
      {
        rows: [
          expect.objectContaining({
            id,
            from_party: 'corrallm',
            to_party: 'agent:worker',
            origin: 'run',
            state: 'delivering',
            task: { agent: 'worker', item: 'hello', attempt: attempt?.id },
            delivery: expect.objectContaining({ as: id }) as unknown,
          }),
        ],
        attempts: [expect.objectContaining({ id: attempt?.id, status: 'running', messageId: id })],
      },
    ]);
    // Settled as its turn ended, never delivered again.
    await vi.waitFor(() => {
      expect(rowsOnDisk()).toEqual([
        expect.objectContaining({
          id,
          state: 'replied',
          turn: expect.objectContaining({ status: 'completed' }) as unknown,
        }),
      ]);
    });
    expect(codex.sessions.flatMap((session) => session.sent)).toHaveLength(1);
  });

  it('settles the run’s message and its result in one write, or neither', async () => {
    const { connector, sent, end } = busy();
    const core = await start(connector);
    const engine = await core.engines.open(CANVAS);
    engine.run.start();
    await vi.waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    const id = sent[0]?.id ?? '';
    await core.flush();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const allow = refuseWrites(profile, 'message', 'The disk is full', CANVAS);
    try {
      end([id]);
      await vi.waitFor(() => {
        expect(engine.run.snapshot().agents.worker?.status).toBe('done');
      });
      await expect(core.engines.canvas(CANVAS)?.journal()).rejects.toThrow('The disk is full');
      // Neither its settlement nor the run's result reached the disk: as its CLI had it.
      expect(rowsOnDisk()).toEqual([expect.objectContaining({ id, state: 'delivered' })]);
      expect(attemptsOnDisk()).toEqual([expect.objectContaining({ status: 'running' })]);
    } finally {
      allow();
      errors.mockRestore();
    }
    await core.engines.canvas(CANVAS)?.journal();
    expect(rowsOnDisk()).toEqual([expect.objectContaining({ id, state: 'replied' })]);
    expect(attemptsOnDisk()).toEqual([expect.objectContaining({ status: 'succeeded' })]);
  });

  it('never sends a run message whose record can’t be kept', async () => {
    const codex = new FakeConnector({ adapter: 'codex' });
    const core = await start(codex);
    const engine = await core.engines.open(CANVAS);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const allow = refuseWrites(profile, 'message', 'The disk is full', CANVAS);
    try {
      engine.run.start();
      await vi.waitFor(() => {
        expect(engine.run.snapshot().agents.worker?.problem?.text).toMatch(/could not be saved/);
      });
    } finally {
      allow();
      errors.mockRestore();
    }
    expect(codex.started).toEqual([]);
    const [message] = (await core.engines.messagesOf(CANVAS)).all();
    expect(message).toMatchObject({ state: 'unresolved', turn: { status: 'failed' } });
    expect((await core.engines.messagesOf(CANVAS)).originOf(message?.id ?? '')).toBe('run');
  });

  it('withdraws a run message taken back before it goes, never sending it', async () => {
    const codex = new FakeConnector({ adapter: 'codex' });
    const core = await start(codex);
    const engine = await core.engines.open(CANVAS);
    engine.run.start();
    // Stopped in the same turn: its record is on its way to disk, and it never goes.
    engine.run.stop();
    await vi.waitFor(async () => {
      const [message] = (await core.engines.messagesOf(CANVAS)).all();
      expect(message).toMatchObject({
        state: 'withdrawn',
        by: 'corrallm',
        turn: { status: 'cancelled', reason: 'taken-back' },
      });
    });
    await core.flush();
    expect(rowsOnDisk()).toEqual([expect.objectContaining({ state: 'withdrawn' })]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(codex.sessions.flatMap((session) => session.sent)).toEqual([]);
  });

  it('settles a message once, whatever its native ends name, and its result arriving before the send returns', async () => {
    const codex = new FakeConnector({ adapter: 'codex' });
    let ends = 0;
    // The CLI ends the turn before its send even returns, then says it ended again with another.
    const eager: Connector<SessionMode> = {
      start: async (spec, host) => {
        const session = await codex.start(spec, host);
        session.send = (message) => {
          host.emit({ type: 'user', id: message.id, text: message.text });
          host.emit({ type: 'text', id: 'reply', text: 'Hello' });
          for (const messages of [[message.id], [message.id, 'another']]) {
            ends += 1;
            host.emit({
              type: 'end',
              messages,
              seconds: 1,
              result: { status: 'completed', reason: 'completed' },
            });
          }
          return Promise.resolve();
        };
        return session;
      },
    };
    const core = await start(eager);
    const engine = await core.engines.open(CANVAS);
    engine.run.start();
    await vi.waitFor(() => {
      expect(engine.run.snapshot().agents.worker).toMatchObject({
        status: 'done',
        outcomes: { hello: 'succeeded' },
      });
    });
    expect(ends).toBe(2);
    expect(engine.run.snapshot().agents.worker?.attempts?.hello).toHaveLength(1);
    const messages = (await core.engines.messagesOf(CANVAS)).all();
    expect(messages).toEqual([expect.objectContaining({ state: 'replied' })]);
  });

  it('is never delivered by delivery, nor taken back or killed as a party’s message', async () => {
    const { connector, sent, end } = busy();
    const core = await start(connector);
    const engine = await core.engines.open(CANVAS);
    engine.run.start();
    await vi.waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    const id = sent[0]?.id ?? '';
    expect(await core.call('withdraw', { canvas: CANVAS, id }, CALLERS.you)).toMatchObject({
      ok: false,
      error: { code: 'refused' },
    });
    // A party's message waits behind the run's, then goes once its turn ends.
    const party = await core.call(
      'message',
      { canvas: CANVAS, to: 'worker', body: 'Party work' },
      ORCHESTRATOR,
    );
    if (!party.ok || !('id' in party.value)) throw new Error('No message');
    end([id]);
    await vi.waitFor(() => {
      expect(sent).toHaveLength(2);
    });
    expect(sent[1]?.text).toContain('Party work');
    expect((await messageOf(core, id))?.state).toBe('replied');
    end([sent[1]?.id ?? '']);
    await vi.waitFor(async () => {
      expect((await messageOf(core, party.value.id))?.state).toBe('replied');
    });
    // The run's reply goes to the run, never back to corrallm as a message.
    expect(
      (await core.engines.messagesOf(CANVAS)).all().filter((one) => one.replyTo === id),
    ).toEqual([]);
  });

  it('leaves the run’s message out unresolved after a crash, its attempt uncertain, sending nothing again', async () => {
    const { connector, sent } = busy();
    const core = await start(connector);
    const engine = await core.engines.open(CANVAS);
    engine.run.start();
    await vi.waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    const id = sent[0]?.id ?? '';
    const crashed = await mkdtemp(path.join(tmpdir(), 'corrallm-crashed-'));
    try {
      for (const file of await readdir(profile)) {
        if (file.startsWith(STORE_FILE)) {
          await copyFile(path.join(profile, file), path.join(crashed, file));
        }
      }
      const again = busy();
      const restarted = await start(again.connector, crashed);
      await restarted.engines.initialize();
      const restored = restarted.engines.canvas(CANVAS);
      expect(restored?.engine.run.snapshot().agents.worker?.attempts?.hello).toEqual([
        expect.objectContaining({ status: 'uncertain', messageId: id }),
      ]);
      expect(restored?.messages.get(id)).toMatchObject({ state: 'unresolved' });
      // No notice to corrallm, nor to anyone, of its own message cut off.
      expect(restored?.messages.all().filter((one) => one.kind === 'notice')).toEqual([]);
      restored?.engine.run.resume();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(again.sent).toEqual([]);
    } finally {
      await rm(crashed, { recursive: true, force: true });
    }
  });
});
