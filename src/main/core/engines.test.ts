import { readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CanvasId } from '../../shared/canvas';
import type { SessionMode } from '../../shared/session';
import type { RunContext } from '../../shared/run';
import type { Connector } from '../sessions/connector';
import { FakeConnector } from '../sessions/fake';
import { Settings } from '../settings';
import { UsageReadings } from '../usage';
import { createCore } from './core';
import type { Core } from './core';
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

/** The canvas's run, as the journal keeps it. */
async function journaled(): Promise<{
  run: { agents: Record<string, unknown> };
  replies: unknown;
}> {
  const record = JSON.parse(
    await readFile(path.join(profile, 'runs', CANVAS, 'record.json'), 'utf8'),
  ) as { checkpoint: { state: string } };
  return JSON.parse(record.checkpoint.state) as {
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
  await writeFile(
    path.join(profile, 'canvases.json'),
    JSON.stringify({
      version: 2,
      canvases: { [CANVAS]: { file, ...(folder ? { project } : {}), conversations: {} } },
    }),
  );
}

async function start(codex: Connector<SessionMode>): Promise<Core> {
  core = await createCore(
    {
      profile,
      app: { name: 'corrallm', version: '9.8.7' },
      check: true,
      distribution: 'local',
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
  it('keeps the renderer’s edited checkpoint when a manual send reads an existing message log', async () => {
    await keepCanvas();
    await (await start(new FakeConnector({ adapter: 'codex' }))).engines.open(CANVAS);
    await core?.close();
    core = undefined;
    await writeFile(path.join(profile, 'runs', CANVAS, 'messages.jsonl'), '');

    const app = await start(new FakeConnector({ adapter: 'codex' }));
    const context = (await app.channels.call(7, 'run:get', [])) as RunContext;
    await app.channels.call(7, 'session:start', [
      'worker',
      { connection: 'codex.app-server', model: null, mode: null },
    ]);
    await app.channels.call(7, 'session:send', [
      'worker',
      { id: crypto.randomUUID(), text: 'Hello from the app' },
    ]);
    expect(app.engines.opened()).toEqual([]);
    const checkpoint = context.checkpoint;
    if (!checkpoint) throw new Error('No checkpoint was restored.');
    const workflow = JSON.parse(checkpoint.workflow) as { nodes: { label: string }[] };
    const worker = workflow.nodes[0];
    if (!worker) throw new Error('No worker was restored.');
    worker.label = 'Edited in renderer';
    const edited = { ...checkpoint, workflow: JSON.stringify(workflow), updatedAt: Date.now() };
    await app.channels.call(7, 'run:save', [context.token, edited]);
    await app.close();
    core = undefined;
    const record = JSON.parse(
      await readFile(path.join(profile, 'runs', CANVAS, 'record.json'), 'utf8'),
    ) as { checkpoint: typeof edited };
    expect(record.checkpoint).toEqual(edited);
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
          const record = readFileSync(path.join(profile, 'runs', CANVAS, 'record.json'), 'utf8');
          before.push(
            JSON.parse((JSON.parse(record) as { checkpoint: { state: string } }).checkpoint.state),
          );
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
    // The run's record reached the journal before its message reached the agent.
    expect(before).toMatchObject([
      { run: { running: true, agents: { worker: { status: 'running', current: 'hello' } } } },
    ]);

    await core?.close();
    core = undefined;
    const state = await journaled();
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
    await vi.waitFor(async () => {
      expect((await journaled()).run.agents.worker).toMatchObject({
        outcomes: { hello: 'succeeded' },
      });
    });
    // The canvas's record can't be written any more: a file stands where its folder was.
    const record = path.join(profile, 'runs', CANVAS);
    await rm(record, { recursive: true });
    await writeFile(record, '');
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
    await vi.waitFor(async () => {
      expect((await journaled()).run.agents.worker).toMatchObject({
        outcomes: { hello: 'succeeded' },
      });
    });
    await started.channels.call(7, 'run:get', []);
    const record = path.join(profile, 'runs', CANVAS, 'record.json');
    await rm(record);
    await mkdir(record);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(started.flush()).rejects.toThrow();
    } finally {
      await rm(record, { recursive: true, force: true });
    }
    errors.mockRestore();
    await started.channels.call(7, 'session:start', [
      'worker',
      { connection: 'codex.app-server', model: null, mode: null },
    ]);
    await started.channels.call(7, 'session:send', [
      'worker',
      { id: crypto.randomUUID(), text: 'After Keep corrallm open' },
    ]);
    expect(codex.sessions.flatMap(({ sent }) => sent).at(-1)?.text).toBe(
      'After Keep corrallm open',
    );
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

  it('refuses an unsaved canvas, though its run was journaled and its folder kept', async () => {
    await journalRun();
    // A draft: the profile keeps its folder and its run, and no file.
    await writeFile(
      path.join(profile, 'canvases.json'),
      JSON.stringify({ version: 2, canvases: { [CANVAS]: { project, conversations: {} } } }),
    );
    await expect(
      (await start(new FakeConnector({ adapter: 'codex' }))).engines.open(CANVAS),
    ).rejects.toThrow(/isn’t saved/);
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
