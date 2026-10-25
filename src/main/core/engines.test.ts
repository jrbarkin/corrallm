import { legacyDirectories } from './workspaces/test-directories';
import { asHuman } from './gui';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CanvasId } from '../../shared/canvas';
import type { SessionMode } from '../../shared/session';
import { MAX_RUN_BYTES } from '../../shared/run';
import type { Connector } from '../sessions/connector';
import { FakeConnector } from '../sessions/fake';
import { Settings } from '../settings';
import { UsageReadings } from '../usage';
import { createCore } from './core';
import type { Core } from './core';
import { STORE_FILE } from './store/open';
import { snapshots, takeSnapshot } from './store/snapshots';
import {
  journaledRun,
  keepCanvases,
  keepMessages,
  readOnDisk,
  refuseWrites,
} from './store/test-store';
import { CALLERS, NO_DESKTOP } from './test-registry';

/** A canvas with one Codex agent whose queue sends it a message (its id is the file's). */
const FIXTURE = path.join(import.meta.dirname, 'test-worker.corral');
const CANVAS = '4b1f6c2e-8d3a-4e5f-9a0b-7c6d5e4f3a2b' as CanvasId;
const REPLY = 'You said: Say hello';

let profile: string;
let project: string;
let core: Core | undefined;

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-engines-'));
  project = path.join(profile, 'project');
  await mkdir(project);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await core?.close();
  core = undefined;
  await rm(profile, { recursive: true, force: true });
});

/** The canvas's run's state, as the journal keeps it on disk. */
function journaled(): {
  run: { agents: Record<string, unknown> };
  replies: unknown;
} {
  const checkpoint = journaledRun(profile, CANVAS);
  if (checkpoint === undefined) throw new Error('No run was journaled.');
  return JSON.parse(checkpoint.state) as {
    run: { agents: Record<string, unknown> };
    replies: unknown;
  };
}

/**
 * A profile that keeps the fixture's canvas, as the app would once it was opened and its project
 * folder picked: its file, and (unless `folder` is false) its folder.
 */
async function keepCanvas({ folder = true } = {}): Promise<void> {
  const file = path.join(profile, 'worker.corral');
  await copyFile(FIXTURE, file);
  await keepCanvases(profile, { [CANVAS]: { file, ...(folder ? { project } : {}) } });
}

async function start(codex: Connector<SessionMode>): Promise<Core> {
  core = await createCore(
    {
      profile,
      app: { name: 'corrallm', version: '9.8.7' },
      check: true,
      distribution: 'local',
      directoryResolver: legacyDirectories,
      sessions: {
        connectors: { 'codex.app-server': codex },
        environment: () => Promise.resolve({}),
      },
    },
    NO_DESKTOP,
  );
  return core;
}

describe('the core runs each canvas’s engine', () => {
  it.each(['oversized', 'complex'] as const)(
    'holds its next queue send when the checkpoint is %s while a token’s message still reaches the agent',
    async (limit) => {
      await keepCanvas();
      const codex = new FakeConnector({ adapter: 'codex' });
      const started = await start(codex);
      const engine = await started.engines.open(CANVAS);
      const checkpoint = engine.checkpoint();
      const limited = vi.spyOn(engine, 'checkpoint').mockReturnValue({
        ...checkpoint,
        state: JSON.stringify(
          limit === 'oversized'
            ? { text: 'x'.repeat(MAX_RUN_BYTES) }
            : Array<number>(200_001).fill(0),
        ),
      });
      const reason = limit === 'oversized' ? /too large/ : /too complex/;
      engine.run.start();
      // Await the actual dispatch decision, not a timeout that could hide a late queue send.
      await vi.waitFor(() => {
        expect(engine.run.sending('worker')).toBe(false);
        expect(
          engine.run.snapshot().agents.worker?.problem !== undefined ||
            codex.sessions.some((session) => session.sent.length > 0),
        ).toBe(true);
      });
      expect(codex.started).toEqual([]);
      expect(engine.run.snapshot().agents.worker?.problem?.text).toMatch(reason);
      const needs = await started.call('needs', { canvas: CANVAS }, CALLERS.you);
      if (!needs.ok) throw new Error(needs.error.sentence);
      const hold = needs.value.items.find(
        (item) => item.id === `unsaved/${encodeURIComponent(CANVAS)}`,
      );
      expect(hold?.detail).toMatch(reason);
      expect(hold?.for).toBe('you');
      expect(hold?.kind).toBe('hold');
      const message = await started.call(
        'message',
        {
          canvas: CANVAS,
          to: 'worker',
          body: 'Party work still goes',
        },
        {
          kind: 'outside',
          token: 'write-token',
          name: 'orchestrator',
          access: 'write',
          canvases: [CANVAS],
        },
      );
      expect(message).toMatchObject({ ok: true });
      await vi.waitFor(() => {
        expect(codex.sessions[0]?.sent).toHaveLength(1);
      });
      expect(codex.sessions[0]?.sent[0]?.text).toContain('Party work still goes');
      expect(codex.sessions[0]?.sent[0]?.text).not.toContain('Say hello');
      await vi.waitFor(() => {
        expect(
          started.engines
            .canvas(CANVAS)
            ?.messages.all()
            .find((item) => item.body === 'Party work still goes')?.state,
        ).toBe('replied');
      });
      // A checkpoint that fits clears the canvas hold; an explicit Run then sends as usual.
      limited.mockRestore();
      engine.run.start();
      await vi.waitFor(() => {
        expect(engine.run.snapshot().agents.worker?.outcomes).toEqual({ hello: 'succeeded' });
      });
      expect(codex.sessions[0]?.sent).toHaveLength(2);
      const healthy = await started.call('needs', { canvas: CANVAS }, CALLERS.you);
      if (!healthy.ok) throw new Error(healthy.error.sentence);
      expect(healthy.value.items.some((item) => item.id.startsWith('unsaved/'))).toBe(false);
    },
  );

  it('records and delivers messages while its run is too large to keep, and says why', async () => {
    await keepCanvas();
    const codex = new FakeConnector({ adapter: 'codex' });
    const recordAtSend: unknown[] = [];
    const watched: Connector<SessionMode> = {
      start: async (spec, host) => {
        const session = await codex.start(spec, host);
        const send = session.send.bind(session);
        session.send = (message) => {
          recordAtSend.push(
            readOnDisk(profile, (db) =>
              db
                .prepare("SELECT state FROM message WHERE json_extract(delivery, '$.as') = ?")
                .get(message.id),
            ),
          );
          return send(message);
        };
        return session;
      },
    };
    const started = await start(watched);
    await started.engines.open(CANVAS);
    const open = started.engines.canvas(CANVAS);
    if (!open) throw new Error('Canvas did not open');
    const checkpoint = open.engine.checkpoint();
    vi.spyOn(open.engine, 'checkpoint').mockReturnValue({
      ...checkpoint,
      state: JSON.stringify({ text: 'x'.repeat(MAX_RUN_BYTES) }),
    });
    // Force an actual run change; every following message write used to throw from keep().
    open.engine.run.pause();
    await expect(open.journal()).resolves.toBeUndefined();
    const sent = await started.call(
      'message',
      { canvas: CANVAS, to: 'worker', body: 'Still deliver' },
      asHuman(7),
    );
    if (!sent.ok) throw new Error(JSON.stringify(sent.error));
    expect(sent).toMatchObject({ ok: true });
    await vi.waitFor(() => {
      expect(codex.sessions[0]?.sent).toHaveLength(1);
    });
    expect(recordAtSend).toEqual([{ state: 'delivering' }]);
    const items = await started.call('needs', { canvas: CANVAS }, CALLERS.you);
    if (!items.ok) throw new Error(items.error.sentence);
    expect(
      items.value.items.some((item) => item.title.includes('too large') && item.for === 'you'),
    ).toBe(true);
    const view = await started.call('run.get', { canvas: CANVAS }, asHuman(7));
    if (!view.ok) throw new Error(view.error.sentence);
    expect(view.value.saveError).toMatch(/too large/);
  });
  it('keeps one core runtime and document edits when a window sends a manual message', async () => {
    await keepCanvas();
    await (await start(new FakeConnector({ adapter: 'codex' }))).engines.open(CANVAS);
    await core?.close();
    core = undefined;
    await keepMessages(profile, CANVAS, [
      {
        message: {
          id: crypto.randomUUID(),
          from: 'outside:orchestrator',
          to: 'agent:worker',
          kind: 'text',
          body: 'Earlier',
          state: 'replied',
          at: 1,
        },
      },
    ]);

    const app = await start(new FakeConnector({ adapter: 'codex' }));
    expect(await app.call('window.get', {}, asHuman(7))).toMatchObject({
      ok: true,
      value: { canvas: CANVAS },
    });
    const owner = app.engines.canvas(CANVAS)?.engine;
    expect(
      await app.call('session.open', { canvas: CANVAS, agent: 'worker' }, asHuman(7)),
    ).toMatchObject({ ok: true });
    await app.channels.call(7, 'session:send', [
      'worker',
      { id: crypto.randomUUID(), text: 'Hello from the app' },
    ]);
    expect(app.engines.opened()).toContain(CANVAS);
    const checkpoint = owner?.checkpoint();
    if (!checkpoint) throw new Error('Nothing was restored.');
    const loaded = await app.call('canvas.get', { canvas: CANVAS }, asHuman(7));
    if (!loaded.ok) throw new Error(loaded.error.sentence);
    const renamed = await app.call(
      'canvas.rename',
      { canvas: CANVAS, node: 'worker', label: 'Edited in renderer', request: crypto.randomUUID() },
      asHuman(7),
    );
    if (!renamed.ok) throw new Error(renamed.error.sentence);
    expect(app.engines.canvas(CANVAS)?.engine).toBe(owner);
    await app.flush();
    await app.close();
    core = undefined;
    expect(journaledRun(profile, CANVAS)).toBeDefined();
    expect(
      readOnDisk(profile, (disk) =>
        disk.prepare("SELECT label FROM node WHERE canvas_id = ? AND id = 'worker'").get(CANVAS),
      ),
    ).toEqual({ label: 'Edited in renderer' });
    expect(app.engines.opened()).toEqual([]);
  });

  it('runs a message to a Codex agent, keeps its reply as the evidence and journals the run', async () => {
    await keepCanvas();
    const codex = new FakeConnector({ adapter: 'codex' });
    /** What the journal held each time a message reached the agent's session. */
    const before: unknown[] = [];
    const watched: Connector<SessionMode> = {
      start: async (spec, host) => {
        const session = await codex.start(spec, host);
        const send = session.send.bind(session);
        session.send = (message) => {
          // Read through a connection of its own: what is on disk.
          before.push(journaled());
          return send(message);
        };
        return session;
      },
    };
    const engine = await (await start(watched)).engines.open(CANVAS);
    engine.run.start();
    await vi.waitFor(() => {
      expect(engine.run.snapshot().agents.worker).toMatchObject({
        status: 'done',
        outcomes: { hello: 'succeeded' },
      });
    });
    expect(codex.started).toMatchObject([{ cwd: project, mode: null }]);
    // The run's record was on disk before its message reached the agent.
    expect(before).toMatchObject([
      { run: { running: true, agents: { worker: { status: 'running', current: 'hello' } } } },
    ]);

    await core?.close();
    core = undefined;
    const state = journaled();
    expect(state.run.agents.worker).toMatchObject({ outcomes: { hello: 'succeeded' } });
    expect(state.replies).toEqual([[JSON.stringify(['worker', 'hello']), REPLY]]);
  });

  it('restores a canvas’s journaled run paused, its evidence kept, sending nothing again', async () => {
    await keepCanvas();
    const first = await (await start(new FakeConnector({ adapter: 'codex' }))).engines.open(CANVAS);
    first.run.start();
    await vi.waitFor(() => {
      expect(first.run.snapshot().agents.worker?.status).toBe('done');
    });
    await core?.close();

    const codex = new FakeConnector({ adapter: 'codex' });
    const engine = await (await start(codex)).engines.open(CANVAS);
    expect(engine.run.snapshot()).toMatchObject({
      running: false,
      paused: true,
      agents: { worker: { status: 'done', outcomes: { hello: 'succeeded' } } },
    });
    expect(JSON.parse(engine.run.checkpoint())).toMatchObject({
      replies: [[JSON.stringify(['worker', 'hello']), REPLY]],
    });
    expect(codex.started).toEqual([]);
  });

  it('restores a run from a snapshot taken while its message was out paused, sending nothing again', async () => {
    await keepCanvas();
    // Its agent takes the run's message, and its turn goes on as long as the test does.
    const codex = new FakeConnector({ adapter: 'codex' });
    const sent: string[] = [];
    const busy: Connector<SessionMode> = {
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
    const engine = await (await start(busy)).engines.open(CANVAS);
    engine.run.start();
    await vi.waitFor(() => {
      expect(sent).toEqual(['Say hello']);
    });
    // A snapshot of the database now, as the store takes them every few hours; then the database
    // is damaged, and every later snapshot lost with it.
    const kept = await takeSnapshot(path.join(profile, STORE_FILE), profile, Date.now() - 60_000);
    await core?.close();
    core = undefined;
    for (const other of await snapshots(profile)) if (other !== kept) await rm(other);
    await writeFile(path.join(profile, STORE_FILE), 'not a database');

    const again = new FakeConnector({ adapter: 'codex' });
    const restarted = await start(again);
    const restored = await restarted.engines.open(CANVAS);
    expect(restarted.engines.canvas(CANVAS)?.warnings).toEqual([
      expect.stringMatching(/damaged.*restored from its snapshot/) as string,
    ]);
    // Its message was out: never sent again, the run paused where the snapshot had it.
    expect(restored.run.snapshot()).toMatchObject({ running: false, paused: true });
    expect(restored.run.snapshot().agents.worker?.status).not.toBe('done');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(again.started).toEqual([]);
  });

  it('closes every session as it closes, and writes out what it keeps, though a run can’t be journaled', async () => {
    await keepCanvas();
    const codex = new FakeConnector({ adapter: 'codex' });
    let closed = 0;
    const watched: Connector<SessionMode> = {
      start: async (spec, host) => {
        const session = await codex.start(spec, host);
        const close = session.close.bind(session);
        session.close = () => {
          closed += 1;
          return close();
        };
        return session;
      },
    };
    const engine = await (await start(watched)).engines.open(CANVAS);
    engine.run.start();
    await vi.waitFor(() => {
      expect(journaled().run.agents.worker).toMatchObject({
        outcomes: { hello: 'succeeded' },
      });
    });
    // The canvas's run can't be written any more.
    refuseWrites(profile, 'run', 'The disk is full');
    const flushes = [
      vi.spyOn(Settings.prototype, 'flush'),
      vi.spyOn(UsageReadings.prototype, 'flush'),
    ];

    await expect(core?.close()).rejects.toThrow(/journal/);
    core = undefined;
    expect(closed).toBe(1);
    for (const flush of flushes) expect(flush).toHaveBeenCalled();
  });

  it('keeps a usable core when preparing to close cannot save its run', async () => {
    await keepCanvas();
    const codex = new FakeConnector({ adapter: 'codex' });
    const started = await start(codex);
    const engine = await started.engines.open(CANVAS);
    engine.run.start();
    await vi.waitFor(() => {
      expect(journaled().run.agents.worker).toMatchObject({
        outcomes: { hello: 'succeeded' },
      });
    });
    await started.call('window.get', {}, asHuman(7));
    const allow = refuseWrites(profile, 'run', 'The disk is full');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(started.flush()).rejects.toThrow('The disk is full');
    } finally {
      allow();
    }
    errors.mockRestore();
    expect(
      await started.call('session.open', { canvas: CANVAS, agent: 'worker' }, asHuman(7)),
    ).toMatchObject({ ok: true });
    await started.channels.call(7, 'session:send', [
      'worker',
      { id: crypto.randomUUID(), text: 'After Keep corrallm open' },
    ]);
    await vi.waitFor(() => {
      expect(codex.sessions.flatMap(({ sent }) => sent).at(-1)?.text).toBe(
        'After Keep corrallm open',
      );
    });
    expect(await started.call('app.info', {}, CALLERS.you)).toMatchObject({
      ok: true,
    });
    await expect(started.flush()).resolves.toBeUndefined();
  });

  it('refuses a canvas the profile keeps no project folder for, starting nothing', async () => {
    await keepCanvas({ folder: false });
    const codex = new FakeConnector({ adapter: 'codex' });
    await expect((await start(codex)).engines.open(CANVAS)).rejects.toThrow(/project folder/);
    expect(codex.started).toEqual([]);
  });

  it('opens a canvas the core keeps the document of with no file, its run restored paused', async () => {
    await journalRun();
    // Its file forgotten: the profile keeps its folder, its run and its document, and no file.
    await keepCanvases(profile, { [CANVAS]: { project } });
    const engine = await (
      await start(new FakeConnector({ adapter: 'codex' }))
    ).engines.open(CANVAS);
    expect(engine.run.snapshot()).toMatchObject({
      paused: true,
      agents: { worker: { status: 'done' } },
    });
  });

  it('refuses a draft that holds nothing, though its folder is kept', async () => {
    const draft = '6e5d4c3b-2a19-4f08-8e7d-6c5b4a392817' as CanvasId;
    await keepCanvases(profile, { [draft]: { project } });
    await expect(
      (await start(new FakeConnector({ adapter: 'codex' }))).engines.open(draft),
    ).rejects.toThrow(/isn’t saved/);
  });

  it('closes a canvas it runs: its run held and journaled, its sessions closed, open again paused', async () => {
    await keepCanvas();
    const codex = new FakeConnector({ adapter: 'codex' });
    const started = await start(codex);
    const engine = await started.engines.open(CANVAS);
    expect(
      readOnDisk(profile, (disk) => disk.prepare('SELECT canvas_id FROM open_canvas').all()),
    ).toEqual([{ canvas_id: CANVAS }]);
    engine.run.start();
    await vi.waitFor(() => {
      expect(engine.run.snapshot().agents.worker?.status).toBe('done');
    });
    const closing = vi.spyOn(codex, 'start');
    await started.engines.closeCanvas(CANVAS);
    expect(started.engines.canvas(CANVAS)).toBeUndefined();
    expect(started.engines.opened()).toEqual([]);
    expect(journaled().run.agents.worker).toMatchObject({ outcomes: { hello: 'succeeded' } });
    // Nothing more of it runs, and closing it again is nothing.
    await started.engines.closeCanvas(CANVAS);
    expect(closing).not.toHaveBeenCalled();
    const again = await started.engines.open(CANVAS);
    expect(again).not.toBe(engine);
    expect(again.run.snapshot()).toMatchObject({ running: false, paused: true });
  });

  it('refuses a canvas whose file holds another canvas now, though its run was journaled', async () => {
    await journalRun();
    const another = (await readFile(FIXTURE, 'utf8')).replace(
      CANVAS,
      '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a',
    );
    await writeFile(path.join(profile, 'worker.corral'), another);
    await expect(
      (await start(new FakeConnector({ adapter: 'codex' }))).engines.open(CANVAS),
    ).rejects.toThrow(/another canvas/);
  });
});

/** Keeps the fixture's canvas, runs its queue to the end and closes the core: its run journaled. */
async function journalRun(): Promise<void> {
  await keepCanvas();
  const engine = await (await start(new FakeConnector({ adapter: 'codex' }))).engines.open(CANVAS);
  engine.run.start();
  await vi.waitFor(() => {
    expect(engine.run.snapshot().agents.worker?.status).toBe('done');
  });
  await core?.close();
  core = undefined;
}
