import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CanvasId } from '../../shared/canvas';
import type { Message } from '../../shared/model/messages';
import type { SessionMode } from '../../shared/session';
import type { Connector } from '../sessions/connector';
import { FakeConnector } from '../sessions/fake';
import type { OutsideCaller } from './caller';
import { createCore } from './core';
import type { Core } from './core';
import { journaledRun, keepCanvases, refuseWrites } from './store/test-store';
import { CALLERS, NO_DESKTOP } from './test-registry';
import { legacyDirectories } from './workspaces/test-directories';

/*
 * The core's shutdown barrier (B11 Design §8 "Quit is not window close", §16.5), as quit and
 * Restart to update use it: prepare freezes new dispatch (no run task or delivery starts, turns
 * going on go on), admits no write, and forces every journal and store, keeping sessions usable;
 * cancel lifts only that; commit alone ends sessions, children and the database. Each idempotent.
 */

/** A canvas with one Codex agent whose queue sends it a message (its id is the file's). */
const FIXTURE = path.join(import.meta.dirname, 'test-worker.corral');
const CANVAS = '4b1f6c2e-8d3a-4e5f-9a0b-7c6d5e4f3a2b' as CanvasId;
const OUTSIDE: OutsideCaller = {
  kind: 'outside',
  token: 'write-token',
  name: 'orchestrator',
  access: 'write',
  canvases: [CANVAS],
};
const QUITTING = 'corrallm is quitting: try again once it is open again.';

let profile: string;
let project: string;
let core: Core | undefined;
/** Each turn's steps wait for `release` while held. */
let held = false;
let waiting: (() => void)[] = [];

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-shutdown-'));
  project = path.join(profile, 'project');
  await mkdir(project);
  held = false;
  waiting = [];
  const file = path.join(profile, 'worker.corral');
  await copyFile(FIXTURE, file);
  await keepCanvases(profile, { [CANVAS]: { file, project } });
});

afterEach(async () => {
  release();
  vi.restoreAllMocks();
  await core?.close();
  core = undefined;
  await rm(profile, { recursive: true, force: true });
});

/** Lets every turn step held go on. */
function release(): void {
  held = false;
  for (const go of waiting.splice(0)) go();
}

/** A Codex App Server whose turns wait at each step while `held`. */
function connector(): FakeConnector {
  return new FakeConnector({
    adapter: 'codex',
    step: () =>
      held
        ? new Promise<void>((resolve) => {
            waiting.push(resolve);
          })
        : Promise.resolve(),
  });
}

async function start(codex: Connector<SessionMode> = connector()): Promise<Core> {
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
  await core.engines.open(CANVAS);
  return core;
}

/** What the orchestrator sends Worker: its id, or why not. */
async function send(started: Core, body: string) {
  return started.call('message', { canvas: CANVAS, to: 'worker', body }, OUTSIDE);
}

async function message(started: Core, id: string): Promise<Pick<Message, 'state'> | undefined> {
  const page = await started.call('messages', { canvas: CANVAS }, OUTSIDE);
  if (!page.ok) throw new Error(page.error.sentence);
  return page.value.items.find((one) => one.id === id);
}

function idOf(result: Awaited<ReturnType<typeof send>>): string {
  if (!result.ok) throw new Error(result.error.sentence);
  return (result.value as { id: string }).id;
}

describe('the shutdown barrier', () => {
  it('prepared, admits no write, saying why, and still answers reads; cancelled, admits them again', async () => {
    const started = await start();
    const prepared = started.prepareShutdown('quit');
    expect(started.prepareShutdown('quit')).toBe(prepared);
    expect(await prepared).toEqual({ ok: true });
    expect(await send(started, 'Hello')).toEqual({
      ok: false,
      error: { code: 'unavailable', sentence: QUITTING },
    });
    expect(
      await started.call(
        'agent.setRole',
        { canvas: CANVAS, agent: 'worker', role: 'x' },
        CALLERS.you,
      ),
    ).toMatchObject({ ok: false, error: { code: 'unavailable', sentence: QUITTING } });
    expect((await started.call('canvas.get', { canvas: CANVAS }, CALLERS.you)).ok).toBe(true);
    expect((await started.call('app.info', {}, CALLERS.you)).ok).toBe(true);

    started.cancelShutdown();
    started.cancelShutdown();
    expect((await send(started, 'Hello')).ok).toBe(true);
  });

  it('says an update’s restart as its reason', async () => {
    const started = await start();
    await started.prepareShutdown('update');
    expect(await send(started, 'Hello')).toEqual({
      ok: false,
      error: {
        code: 'unavailable',
        sentence: 'corrallm is restarting to update: try again once it is open again.',
      },
    });
  });

  it('prepared, starts no delivery while the turn going on goes on and its reply comes back; cancelled, delivers what waited', async () => {
    const codex = connector();
    const started = await start(codex);
    held = true;
    const first = idOf(await send(started, 'First'));
    await vi.waitFor(async () => {
      expect((await message(started, first))?.state).toBe('delivered');
    });
    const second = idOf(await send(started, 'Second'));
    expect((await message(started, second))?.state).toBe('pending');

    expect(await started.prepareShutdown('quit')).toEqual({ ok: true });
    // The turn going on goes on, its session still usable, and its reply comes back.
    release();
    await vi.waitFor(async () => {
      expect((await message(started, first))?.state).toBe('replied');
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await message(started, second))?.state).toBe('pending');
    expect(codex.sessions.flatMap((session) => session.sent).length).toBe(1);

    started.cancelShutdown();
    await vi.waitFor(async () => {
      expect((await message(started, second))?.state).toBe('replied');
    });
    expect(codex.sessions).toHaveLength(1);
  });

  it('prepared, forces the run to disk at once, and its turn going on still ends', async () => {
    const codex = connector();
    const started = await start(codex);
    const engine = started.engines.canvas(CANVAS)?.engine;
    if (!engine) throw new Error('not open');
    held = true;
    engine.run.start();
    // Its task's message is in its session: the turn is going.
    await vi.waitFor(() => {
      expect(codex.sessions.flatMap((session) => session.sent)).toHaveLength(1);
    });
    expect(await started.prepareShutdown('quit')).toEqual({ ok: true });
    const journaled = JSON.parse(journaledRun(profile, CANVAS)?.state ?? '{}') as {
      run?: { agents?: Record<string, { status?: string }> };
    };
    expect(journaled.run?.agents?.worker?.status).toBe('running');
    release();
    await vi.waitFor(() => {
      expect(engine.run.snapshot().agents.worker?.outcomes).toEqual({ hello: 'succeeded' });
    });
  });

  it('says what it couldn’t write, still holding, until cancelled: the core usable again', async () => {
    const started = await start();
    const engine = started.engines.canvas(CANVAS)?.engine;
    engine?.run.start();
    await vi.waitFor(() => {
      expect(engine?.run.snapshot().agents.worker?.outcomes).toEqual({ hello: 'succeeded' });
    });
    const allow = refuseWrites(profile, 'run', 'The disk is full');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let answer;
    try {
      answer = await started.prepareShutdown('quit');
    } finally {
      allow();
    }
    expect(answer).toEqual({
      failed: true,
      sentence: expect.stringContaining('The disk is full') as string,
    });
    expect(await send(started, 'Hello')).toMatchObject({
      ok: false,
      error: { code: 'unavailable' },
    });
    started.cancelShutdown();
    const id = idOf(await send(started, 'Hello'));
    await vi.waitFor(async () => {
      expect((await message(started, id))?.state).toBe('replied');
    });
    // Prepared again after Keep corrallm open, it tries again.
    expect(await started.prepareShutdown('quit')).toEqual({ ok: true });
  });

  it('a canvas opened while prepared is held too', async () => {
    const started = await start();
    await started.engines.closeCanvas(CANVAS);
    await started.prepareShutdown('quit');
    const engine = await started.engines.open(CANVAS);
    engine.run.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(engine.run.snapshot().agents.worker?.status).not.toBe('running');
    started.cancelShutdown();
    await vi.waitFor(() => {
      expect(engine.run.snapshot().agents.worker?.outcomes).toEqual({ hello: 'succeeded' });
    });
  });

  it('committed, ends every session once, however often asked; a cancel then changes nothing', async () => {
    const codex = connector();
    const started = await start(codex);
    const id = idOf(await send(started, 'Hello'));
    await vi.waitFor(async () => {
      expect((await message(started, id))?.state).toBe('replied');
    });
    const close = vi.spyOn(codex.sessions[0] ?? { close: () => Promise.resolve() }, 'close');
    await started.prepareShutdown('quit');
    const committed = started.commitShutdown();
    expect(started.commitShutdown()).toBe(committed);
    expect(started.close()).toBe(committed);
    started.cancelShutdown();
    await committed;
    core = undefined;
    expect(close).toHaveBeenCalledOnce();
  });

  it('committed without being prepared (Quit anyway, or a second quit), admits no write as it closes', async () => {
    const started = await start();
    const committing = started.commitShutdown();
    expect(await send(started, 'Hello')).toMatchObject({
      ok: false,
      error: { code: 'unavailable' },
    });
    await committing;
    core = undefined;
  });
});

describe('whether the core has work going on', () => {
  it('is a run running or a turn going on, on a canvas it runs', async () => {
    const started = await start();
    expect(started.active()).toBe(false);
    held = true;
    const id = idOf(await send(started, 'Hello'));
    await vi.waitFor(async () => {
      expect((await message(started, id))?.state).toBe('delivered');
    });
    expect(started.active()).toBe(true);
    release();
    await vi.waitFor(async () => {
      expect((await message(started, id))?.state).toBe('replied');
    });
    await vi.waitFor(() => {
      expect(started.active()).toBe(false);
    });
  });
});
