import { legacyDirectories } from './workspaces/test-directories';
import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CanvasId } from '../../shared/canvas';
import type { Message } from '../../shared/model/messages';
import type { SessionMode } from '../../shared/session';
import type { Connector } from '../sessions/connector';
import { FakeConnector } from '../sessions/fake';
import { SessionManager } from '../sessions/manager';
import { RunJournal } from '../run-journal';
import { createCore } from './core';
import type { Core } from './core';
import { STORE_FILE } from './store/open';
import { keepCanvases, keepMessages, openedLast, readOnDisk } from './store/test-store';
import type { OutsideCaller } from './caller';
import { CALLERS, NO_DESKTOP } from './test-registry';

/*
 * The canvas runtime's lifecycle (B11 Design §2): allocated passively, without starting any CLI or
 * delivering anything; initialized exactly once per core, however often and concurrently asked; a
 * cold start initializing every canvas open, each restored paused with what was cut off settled
 * before delivery starts; and a canvas closed stays closed.
 */

/** A canvas with one Codex agent whose queue sends it a message (its id is the file's). */
const FIXTURE = path.join(import.meta.dirname, 'test-worker.corral');
const CANVAS = '4b1f6c2e-8d3a-4e5f-9a0b-7c6d5e4f3a2b' as CanvasId;
/** An orchestrator's write token, granted the canvas. */
const ORCHESTRATOR: OutsideCaller = {
  kind: 'outside',
  token: 'write-token',
  name: 'orchestrator',
  access: 'write',
  merge: true,
  canvases: [CANVAS],
};

let profile: string;
let project: string;
const cores: Core[] = [];

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-runtime-'));
  project = path.join(profile, 'project');
  await mkdir(project);
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const core of cores.splice(0)) await core.close().catch(() => undefined);
  await rm(profile, { recursive: true, force: true });
});

/** Keeps the fixture's canvas as the app would (its file, and unless `folder` is false, its folder). */
async function keepCanvas(at = profile, { folder = true } = {}): Promise<void> {
  const file = path.join(at, 'worker.corral');
  await copyFile(FIXTURE, file);
  await keepCanvases(at, { [CANVAS]: { file, ...(folder ? { project } : {}) } });
}

async function start(codex: Connector<SessionMode>, at = profile): Promise<Core> {
  const core = await createCore(
    {
      profile: at,
      app: { name: 'corrallm', version: '9.8.7' },
      check: true,
      distribution: 'local',
      directoryResolver: legacyDirectories,
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

/** A message from an outside orchestrator to the worker, as its row would hold it. */
function party(state: 'pending' | 'delivering', body: string) {
  return {
    message: {
      id: crypto.randomUUID(),
      from: 'outside:orchestrator' as const,
      to: 'agent:worker' as const,
      kind: 'text' as const,
      body,
      state,
      at: 1,
      ...(state === 'pending' ? {} : { delivery: { at: 1, as: crypto.randomUUID(), attempt: 1 } }),
    },
  };
}

/** A connector whose agent takes each message and works on it until the test ends its turn. */
function busy(): { connector: Connector<SessionMode>; codex: FakeConnector; sent: string[] } {
  const codex = new FakeConnector({ adapter: 'codex' });
  const sent: string[] = [];
  const connector: Connector<SessionMode> = {
    start: async (spec, host) => {
      const session = await codex.start(spec, host);
      session.send = (message) => {
        sent.push(message.text);
        host.emit({ type: 'user', id: message.id, text: message.text });
        host.emit({ type: 'status', status: 'working' });
        return Promise.resolve();
      };
      return session;
    },
  };
  return { connector, codex, sent };
}

/** What the canvas's store keeps of the message `id`. */
async function find(core: Core, id: string): Promise<Message | undefined> {
  return (await core.engines.messagesOf(CANVAS)).get(id);
}

/** The notices corrallm kept for the orchestrator about message `id`. */
async function notices(core: Core, id: string): Promise<Message[]> {
  return (await core.engines.messagesOf(CANVAS))
    .all()
    .filter((one) => one.kind === 'notice' && one.replyTo === id);
}

describe('the canvas runtime', () => {
  it('allocates a canvas passively: its run restored paused and its messages, with no project folder, starting and delivering nothing', async () => {
    await keepCanvas(profile, { folder: false });
    const waiting = party('pending', 'Waiting work');
    await keepMessages(profile, CANVAS, [waiting]);
    const codex = new FakeConnector({ adapter: 'codex' });
    const core = await start(codex);

    const engine = await core.engines.load(CANVAS);
    expect(core.engines.canvas(CANVAS)?.engine).toBe(engine);
    expect(core.engines.canvas(CANVAS)?.state).toBe('passive');
    expect(engine.run.snapshot().running).toBe(false);
    expect(core.engines.canvas(CANVAS)?.document.nodes.map(({ id }) => id)).toEqual(['worker']);
    // Open until it is closed, though nothing runs it yet.
    expect(
      readOnDisk(profile, (disk) => disk.prepare('SELECT canvas_id FROM open_canvas').all()),
    ).toEqual([{ canvas_id: CANVAS }]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await find(core, waiting.message.id))?.state).toBe('pending');
    expect(codex.started).toEqual([]);

    // Serve's admission stays as strict as it was: a canvas with no project folder isn't served.
    await expect(core.engines.open(CANVAS)).rejects.toThrow(/project folder/);
    expect(core.engines.canvas(CANVAS)?.state).toBe('passive');
    expect(codex.started).toEqual([]);
  });

  it('initializes every open canvas once, however often and concurrently asked, and delivers only once what was cut off is settled', async () => {
    await keepCanvas();
    await openedLast(profile, CANVAS);
    const cut = party('delivering', 'Cut off');
    const waiting = party('pending', 'Waiting work');
    await keepMessages(profile, CANVAS, [cut, waiting]);
    const read = vi.spyOn(RunJournal.prototype, 'get');
    const codex = new FakeConnector({ adapter: 'codex' });
    const core = await start(codex);

    const [first, second, loaded, opened] = await Promise.all([
      core.engines.initialize(),
      core.engines.initialize(),
      core.engines.load(CANVAS),
      core.engines.open(CANVAS, { held: true }),
    ]);
    expect(second).toBe(first);
    expect(first).toEqual([{ canvas: CANVAS, warnings: [] }]);
    expect(opened).toBe(loaded);
    expect(core.engines.canvas(CANVAS)?.engine).toBe(loaded);
    expect(core.engines.canvas(CANVAS)?.state).toBe('executing');
    expect(core.engines.opened()).toEqual([CANVAS]);
    // Its run and its file were read once: one runtime, initialized once.
    expect(read.mock.calls.filter(([canvas]) => canvas === CANVAS)).toHaveLength(1);
    // What was cut off is settled once, its sender told once; what waited goes, once.
    expect((await find(core, cut.message.id))?.state).toBe('unresolved');
    await vi.waitFor(async () => {
      expect((await find(core, waiting.message.id))?.state).toBe('replied');
    });
    await core.engines.initialize();
    await core.engines.load(CANVAS);
    await core.engines.open(CANVAS);
    expect(await notices(core, cut.message.id)).toHaveLength(1);
    expect(codex.sessions.flatMap((session) => session.sent)).toHaveLength(1);
  });

  it('after a crash, initializes each open canvas paused, what was out unresolved, sending nothing again', async () => {
    await keepCanvas();
    const { connector, sent } = busy();
    const core = await start(connector);
    const engine = await core.engines.open(CANVAS);
    const message = await core.call(
      'message',
      { canvas: CANVAS, to: 'worker', body: 'Party work' },
      ORCHESTRATOR,
    );
    if (!message.ok || !('id' in message.value)) throw new Error('No message');
    await vi.waitFor(() => {
      expect(sent).toEqual([expect.stringContaining('Party work')]);
    });
    engine.run.start();
    // The run's own message waits behind the party's turn, its attempt on disk.

    // The process dies: what is on disk now is all the next core has.
    const crashed = await mkdtemp(path.join(tmpdir(), 'corrallm-crashed-'));
    try {
      for (const file of await readdir(profile)) {
        if (file.startsWith(STORE_FILE)) {
          await copyFile(path.join(profile, file), path.join(crashed, file));
        }
      }
      const again = busy();
      const restarted = await start(again.connector, crashed);
      const [initialized] = await Promise.all([
        restarted.engines.initialize(),
        restarted.engines.initialize(),
      ]);
      expect(initialized.map(({ canvas }) => canvas)).toEqual([CANVAS]);
      const restored = restarted.engines.canvas(CANVAS);
      expect(restored?.engine.run.snapshot()).toMatchObject({ running: false, paused: true });
      expect(restored?.engine.run.snapshot().agents.worker?.attempts?.hello).toMatchObject([
        { status: 'uncertain' },
      ]);
      expect((await find(restarted, message.value.id))?.state).toBe('unresolved');
      await restarted.engines.initialize();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(again.sent).toEqual([]);
      expect(again.codex.started).toEqual([]);
      expect(await notices(restarted, message.value.id)).toHaveLength(1);
    } finally {
      await rm(crashed, { recursive: true, force: true });
    }
  });

  it('initializes no canvas closed since, and a token naming it reaches nothing', async () => {
    await keepCanvas();
    const core = await start(new FakeConnector({ adapter: 'codex' }));
    await core.engines.open(CANVAS);
    expect(await core.call('canvas.close', { canvas: CANVAS }, CALLERS.you)).toMatchObject({
      ok: true,
    });
    await core.close();
    cores.splice(0);

    const codex = new FakeConnector({ adapter: 'codex' });
    const restarted = await start(codex);
    expect(await restarted.engines.initialize()).toEqual([]);
    expect(restarted.engines.opened()).toEqual([]);
    expect(
      await restarted.call(
        'message',
        { canvas: CANVAS, to: 'worker', body: 'Anyone there?' },
        ORCHESTRATOR,
      ),
    ).toMatchObject({ ok: false, error: { code: 'unavailable' } });
    expect(codex.started).toEqual([]);
  });

  it('allocates a canvas being closed again only once its close has finished: one runtime at a time', async () => {
    await keepCanvas();
    const core = await start(new FakeConnector({ adapter: 'codex' }));
    const engine = await core.engines.open(CANVAS);
    const closed = Promise.withResolvers<undefined>();
    const order: string[] = [];
    vi.spyOn(SessionManager.prototype, 'closeCanvas').mockImplementation(async () => {
      await closed.promise;
      order.push('closed');
    });
    const closing = core.engines.closeCanvas(CANVAS);
    const loading = core.engines.load(CANVAS).then((again) => {
      order.push('loaded');
      return again;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual([]);
    closed.resolve(undefined);
    await closing;
    const again = await loading;
    expect(order).toEqual(['closed', 'loaded']);
    expect(again).not.toBe(engine);
    expect(core.engines.canvas(CANVAS)?.state).toBe('passive');
  });
});
