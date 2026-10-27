import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CanvasId } from '../../shared/canvas';
import { FakeConnector } from '../sessions/fake';
import type { OutsideCaller } from './caller';
import { createCore } from './core';
import type { Core } from './core';
import { asHuman } from './gui';
import { keepCanvases, refuseWrites } from './store/test-store';
import { CALLERS, NO_DESKTOP } from './test-registry';
import { legacyDirectories } from './workspaces/test-directories';

/*
 * Pause all (B14 §9 C3): from main's native menus, as you ('host'), every agent of every canvas the
 * core runs, with a run or without, paused in one synchronous pass, then every canvas journaled.
 * Turns going on finish, as for any pause; then nothing more reaches those agents, a party's
 * message included, until you release each. It releases, answers and resumes nothing.
 */

const RUNNING = '0b9a8c7d-6e5f-4a3b-9c2d-1e0f9a8b7c6d' as CanvasId;
const QUIET = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f' as CanvasId;
const PASSIVE = '2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f6a' as CanvasId;
const HOST = asHuman('host');
const OUTSIDE: OutsideCaller = {
  kind: 'outside',
  token: 'write-token',
  name: 'orchestrator',
  access: 'write',
  merge: true,
  canvases: [RUNNING, QUIET, PASSIVE],
};

let profile: string;
let core: Core | undefined;
let fake: FakeConnector;
/** Each turn's steps wait for `release` while held. */
let held = false;
let waiting: (() => void)[] = [];

const agent = (id: string, more: Record<string, unknown> = {}) => ({
  id,
  kind: 'agent',
  label: id,
  position: { x: 0, y: 0 },
  adapter: 'codex',
  connection: 'codex.app-server',
  ...more,
});

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-pause-all-'));
  const project = path.join(profile, 'project');
  await mkdir(project);
  const canvases = {
    [RUNNING]: [
      agent('lead', {
        queue: [
          { id: 'one', message: 'First' },
          { id: 'two', message: 'Second' },
        ],
      }),
      agent('helper', { parent: 'lead', position: { x: 40, y: 40 } }),
    ],
    [QUIET]: [agent('solo')],
    [PASSIVE]: [agent('idle')],
  };
  const kept: Record<string, { file: string; project: string }> = {};
  for (const [id, nodes] of Object.entries(canvases)) {
    const file = path.join(profile, `${id}.corral`);
    await writeFile(file, JSON.stringify({ format: 'corrallm', version: 2, id, nodes, links: [] }));
    kept[id] = { file, project };
  }
  await keepCanvases(profile, kept);
  held = false;
  waiting = [];
  fake = new FakeConnector({
    adapter: 'codex',
    step: () =>
      held
        ? new Promise<void>((resolve) => {
            waiting.push(resolve);
          })
        : Promise.resolve(),
  });
});

afterEach(async () => {
  release();
  vi.restoreAllMocks();
  await core?.close();
  core = undefined;
  await rm(profile, { recursive: true, force: true });
});

function release(): void {
  held = false;
  for (const go of waiting.splice(0)) go();
}

async function start(): Promise<Core> {
  core = await createCore(
    {
      profile,
      app: { name: 'corrallm', version: '9.8.7' },
      check: true,
      distribution: 'local',
      directoryResolver: legacyDirectories,
      sessions: {
        connectors: { 'codex.app-server': fake },
        environment: () => Promise.resolve({}),
      },
    },
    NO_DESKTOP,
  );
  await core.engines.open(RUNNING);
  await core.engines.open(QUIET);
  // Allocated, but not executing: nothing of it runs, so nothing of it is paused.
  await core.engines.load(PASSIVE);
  return core;
}

/** Who holds each agent of a canvas, by its pauses' parties. */
async function pausedBy(started: Core, canvas: CanvasId): Promise<Record<string, string[]>> {
  const run = await started.call('run.get', { canvas }, CALLERS.you);
  if (!run.ok) throw new Error(run.error.sentence);
  const view = run.value as { agents: Record<string, { pauses?: string[] }> };
  return Object.fromEntries(Object.entries(view.agents).map(([id, at]) => [id, at.pauses ?? []]));
}

describe('run.pauseAll', () => {
  it('pauses every agent of every canvas the core runs, run or no run, as you: a party’s message waits', async () => {
    const started = await start();
    // Yours already: untouched, and not counted.
    expect(
      (await started.call('run.pause', { canvas: RUNNING, target: { agent: 'helper' } }, HOST)).ok,
    ).toBe(true);
    held = true;
    expect((await started.call('run.start', { canvas: RUNNING }, CALLERS.you)).ok).toBe(true);
    await vi.waitFor(
      () => {
        expect(started.engines.canvas(RUNNING)?.engine.sessions.of('lead').status).toBe('working');
      },
      { timeout: 5000 },
    );

    const paused = await started.call('run.pauseAll', {}, HOST);
    expect(paused).toEqual({
      ok: true,
      value: { agents: 2, canvases: 2, unsaved: [], revs: expect.any(Object) as object },
    });
    expect(await pausedBy(started, RUNNING)).toMatchObject({ lead: ['you'], helper: ['you'] });
    expect(await pausedBy(started, QUIET)).toMatchObject({ solo: ['you'] });
    expect((await pausedBy(started, PASSIVE)).idle ?? []).toEqual([]);

    // An outside orchestrator's message to an idle agent on a canvas with no run waits.
    const sent = await started.call(
      'message',
      { canvas: QUIET, to: 'solo', body: 'Are you there?' },
      OUTSIDE,
    );
    if (!sent.ok) throw new Error(sent.error.sentence);
    // The orchestrator can't release yours (R9).
    const freed = await started.call(
      'run.unpause',
      { canvas: QUIET, target: { agent: 'solo' } },
      OUTSIDE,
    );
    expect(freed).toMatchObject({ ok: false, error: { code: 'refused' } });
    expect(await pausedBy(started, QUIET)).toMatchObject({ solo: ['you'] });

    // The turn going on finishes; the run sends nothing more to its paused agent.
    release();
    await vi.waitFor(
      () => {
        expect(
          started.engines.canvas(RUNNING)?.engine.run.snapshot().agents.lead?.outcomes,
        ).toEqual({ one: 'succeeded' });
      },
      { timeout: 5000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fake.sessions.flatMap((one) => one.sent.map(({ text }) => text))).toEqual(['First']);
    const page = await started.call('messages', { canvas: QUIET }, OUTSIDE);
    if (!page.ok) throw new Error(page.error.sentence);
    expect(page.value.items.find((one) => one.id === sent.value.id)?.state).toBe('pending');
  });

  it('says which canvases’ pauses couldn’t be saved, holding them all the same', async () => {
    const started = await start();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const allow = refuseWrites(profile, 'run', 'The disk is full', QUIET);
    let paused;
    try {
      paused = await started.call('run.pauseAll', {}, HOST);
    } finally {
      allow();
    }
    expect(paused).toMatchObject({
      ok: true,
      value: {
        agents: 3,
        canvases: 2,
        unsaved: [
          {
            canvas: QUIET,
            sentence:
              'The hold is in place now, but it could not be saved and may not survive a restart.',
          },
        ],
      },
    });
    expect(await pausedBy(started, QUIET)).toMatchObject({ solo: ['you'] });
  });

  it('is refused under the shutdown barrier, like any write', async () => {
    const started = await start();
    expect(await started.prepareShutdown('quit')).toEqual({ ok: true });
    expect(await started.call('run.pauseAll', {}, HOST)).toMatchObject({
      ok: false,
      error: { code: 'unavailable' },
    });
  });

  it('is yours alone, and never a window’s', async () => {
    const started = await start();
    expect(await started.call('run.pauseAll', {}, OUTSIDE)).toMatchObject({
      ok: false,
      error: { code: 'human-only' },
    });
    expect((await pausedBy(started, QUIET)).solo ?? []).toEqual([]);
  });
});
