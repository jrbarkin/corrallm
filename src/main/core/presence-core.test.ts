import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CanvasId } from '../../shared/canvas';
import { FakeConnector } from '../sessions/fake';
import { createCore } from './core';
import type { Core } from './core';
import type { Presence } from './presence';
import { keepCanvases } from './store/test-store';
import { CALLERS, NO_DESKTOP } from './test-registry';
import { legacyDirectories } from './workspaces/test-directories';

/*
 * The core's presence (B14 §9 C5, C6), as main hears it with no window subscribed to anything:
 * agents in a turn, canvases whose run is running, owned jobs and your Needs, whether quitting would
 * cut something off (`busy`) and whether something goes on without you (`awake`).
 */

const CANVAS = '7d0c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d' as CanvasId;
const IDLE = { working: 0, runs: 0, jobs: 0, needs: 0, busy: false, awake: false };

let profile: string;
let core: Core | undefined;
let sent: Presence[];
/** Each turn's steps wait for `release` while held. */
let held = false;
let waiting: (() => void)[] = [];

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-presence-'));
  const project = path.join(profile, 'project');
  await mkdir(project);
  const file = path.join(profile, 'presence.corral');
  await writeFile(
    file,
    JSON.stringify({
      format: 'corrallm',
      version: 2,
      id: CANVAS,
      nodes: [
        {
          id: 'worker',
          kind: 'agent',
          label: 'Worker',
          position: { x: 0, y: 0 },
          adapter: 'codex',
          connection: 'codex.app-server',
          queue: [
            { id: 'hello', message: 'Say hello' },
            { id: 'check', approve: 'Check the greeting' },
          ],
        },
        {
          id: 'waiter',
          kind: 'agent',
          label: 'Waiter',
          position: { x: 300, y: 0 },
          adapter: 'codex',
          connection: 'codex.app-server',
          queue: [{ id: 'later', delay: { seconds: 3600 } }],
        },
      ],
      links: [],
    }),
  );
  await keepCanvases(profile, { [CANVAS]: { file, project } });
  sent = [];
  held = false;
  waiting = [];
});

afterEach(async () => {
  release();
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
        connectors: {
          'codex.app-server': new FakeConnector({
            adapter: 'codex',
            step: () =>
              held
                ? new Promise<void>((resolve) => {
                    waiting.push(resolve);
                  })
                : Promise.resolve(),
          }),
        },
        environment: () => Promise.resolve({}),
      },
    },
    {
      ...NO_DESKTOP,
      presence: (snapshot) => {
        sent.push(snapshot);
      },
    },
  );
  return core;
}

/** The last snapshot main heard, once it is `expected` (revisions aside). */
async function heard(expected: Omit<Presence, 'revision'>): Promise<void> {
  await vi.waitFor(
    () => {
      expect(sent.at(-1)).toEqual({ revision: expect.any(Number) as number, ...expected });
    },
    { timeout: 5000 },
  );
}

async function message(body: string): Promise<void> {
  const sentIt = await core?.call('message', { canvas: CANVAS, to: 'worker', body }, CALLERS.you);
  if (!sentIt?.ok) throw new Error(JSON.stringify(sentIt));
}

describe('the core’s presence', () => {
  it('is sent whole as the core is composed, before anything opens, then only as it changes', async () => {
    const started = await start();
    expect(sent).toEqual([{ revision: 0, ...IDLE }]);
    await started.engines.open(CANVAS);
    // Opening a canvas whose run is restored paused, with nothing at work: nothing to say.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(sent).toHaveLength(1);
  });

  it('counts an agent in a turn as working and awake; one waiting for you as working and a Need', async () => {
    const started = await start();
    await started.engines.open(CANVAS);
    held = true;
    await message('Hello');
    await heard({ ...IDLE, working: 1, busy: true, awake: true });
    release();
    await heard(IDLE);
    await message('/question Go on?');
    // Waiting for your answer mid-turn: it would be cut off, but nothing goes on without you.
    await heard({ ...IDLE, working: 1, needs: 1, busy: true });
    const revisions = sent.map(({ revision }) => revision);
    expect(revisions).toEqual(revisions.toSorted((a, b) => a - b));
    expect(new Set(revisions).size).toBe(revisions.length);
  });

  it('counts a running run: a delay keeps it awake, an OK waiting only for you does not', async () => {
    const started = await start();
    await started.engines.open(CANVAS);
    expect((await started.call('run.start', { canvas: CANVAS }, CALLERS.you)).ok).toBe(true);
    // Worker said hello and waits at its OK for you; Waiter's delay will move the run by itself.
    await heard({ ...IDLE, runs: 1, needs: 1, busy: true, awake: true });
    const paused = await started.call(
      'run.pause',
      { canvas: CANVAS, target: { agent: 'waiter' } },
      CALLERS.you,
    );
    expect(paused.ok).toBe(true);
    // The run goes on waiting for you alone: the machine may sleep.
    await heard({ ...IDLE, runs: 1, needs: 1, busy: true });
  });
});

describe('preparing the shutdown barrier only if nothing is at work (ifIdle)', () => {
  it.each(['quit', 'update'] as const)(
    'answers busy for %s with an idle session’s live background task, without keeping awake',
    async (reason) => {
      const started = await start();
      await started.engines.open(CANVAS);
      await message('Hello');
      const sessions = started.engines.canvas(CANVAS)?.engine.sessions;
      await vi.waitFor(() => {
        expect(sessions?.of('worker').status).toBe('idle');
        expect(sessions?.of('worker').entries.some((entry) => entry.kind === 'text')).toBe(true);
      });
      await heard(IDLE);
      await started.engines.emit(CANVAS, 'worker', 'codex.app-server', {
        type: 'tasks',
        tasks: [{ id: 'server', description: 'Dev server', kind: 'command' }],
      });
      expect(sessions?.of('worker').status).toBe('idle');
      // The idle check reads now, before the publisher’s trailing pass tells main.
      expect(await started.prepareShutdown(reason, { ifIdle: true })).toEqual({
        busy: {
          revision: expect.any(Number) as number,
          ...IDLE,
          jobs: 1,
          busy: true,
        },
      });
      await heard({ ...IDLE, jobs: 1, busy: true });
      // The connector’s whole live list says the task has ended; the push returns to idle too.
      await started.engines.emit(CANVAS, 'worker', 'codex.app-server', {
        type: 'tasks',
        tasks: [],
      });
      await heard(IDLE);
      expect(await started.prepareShutdown(reason, { ifIdle: true })).toEqual({ ok: true });
    },
  );

  it('holds the barrier when idle, as a plain prepare does', async () => {
    const started = await start();
    await started.engines.open(CANVAS);
    expect(await started.prepareShutdown('quit', { ifIdle: true })).toEqual({ ok: true });
    expect(
      await started.call('message', { canvas: CANVAS, to: 'worker', body: 'Hi' }, CALLERS.you),
    ).toMatchObject({ ok: false, error: { code: 'unavailable' } });
  });

  it('answers busy, holding nothing, for work started since main last heard it idle', async () => {
    const started = await start();
    await started.engines.open(CANVAS);
    expect(sent.at(-1)).toMatchObject({ busy: false });
    held = true;
    await message('Hello');
    await vi.waitFor(() => {
      expect(started.engines.canvas(CANVAS)?.engine.sessions.of('worker').status).toBe('working');
    });
    const prepared = await started.prepareShutdown('quit', { ifIdle: true });
    expect(prepared).toEqual({
      busy: {
        revision: expect.any(Number) as number,
        ...IDLE,
        working: 1,
        busy: true,
        awake: true,
      },
    });
    // Nothing held: a write goes on, and so does the turn.
    expect((await started.call('run.start', { canvas: CANVAS }, CALLERS.you)).ok).toBe(true);
    // Asked again without ifIdle (Quit and pause), it prepares whatever goes on.
    expect(await started.prepareShutdown('quit')).toEqual({ ok: true });
  });
});
