import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import { newCanvasId } from '../../shared/canvas';
import { FakeConnector } from '../sessions/fake';
import { createCore } from './core';
import type { Core } from './core';
import { asHuman } from './gui';
import { mintTrustedPath } from './host';
import { SessionControl } from './session-control';
import { SessionViews } from './session-views';
import { keepCanvases } from './store/test-store';
import { CALLERS, NO_DESKTOP } from './test-registry';
import { legacyDirectories } from './workspaces/test-directories';

const roots: string[] = [];
const cores: Core[] = [];
afterEach(async () => {
  for (const core of cores.splice(0)) await core.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'corrallm-session-views-'));
  roots.push(root);
  const project = path.join(root, 'project');
  await mkdir(project);
  const canvas = newCanvasId();
  const file = path.join(root, 'canvas.corral');
  await writeFile(
    file,
    JSON.stringify({
      format: 'corrallm',
      version: 2,
      id: canvas,
      nodes: [
        {
          id: 'a',
          kind: 'agent',
          label: 'Writer',
          position: { x: 0, y: 0 },
          adapter: 'claude-code',
          connection: 'claude-code.sdk',
          settings: { 'claude-code': { model: 'chosen', mode: 'plan' } },
          role: 'Review carefully',
        },
      ],
      links: [],
    }),
  );
  await keepCanvases(root, { [canvas]: { file, project } });
  const sdk = new FakeConnector();
  const terminal = new FakeConnector();
  const listeners = new Set<() => void>();
  let held = false;
  let generation = 0;
  const nextProject = path.join(root, 'next-project');
  await mkdir(nextProject);
  const core = await createCore(
    {
      profile: root,
      app: { name: 'corrallm', version: '1' },
      distribution: 'local',
      check: true,
      watchFolder: () => ({ close: () => undefined }),
      directoryResolver: (projects) => {
        const base = legacyDirectories(projects);
        return {
          projectRoot: (canvas) => base.projectRoot(canvas),
          workingDirectory: async (canvas, agent) => {
            if (held)
              return {
                state: 'held',
                reason: 'pending-change',
                sentence: 'Switch its worktree first.',
              };
            const directory = await base.workingDirectory(canvas, agent);
            return directory.state === 'ready' ? { ...directory, generation } : directory;
          },
          onAvailability: (canvas, listener) => {
            listeners.add(listener);
            const stop = base.onAvailability(canvas, listener);
            return () => {
              stop();
              listeners.delete(listener);
            };
          },
        };
      },
      sessions: {
        connectors: { 'claude-code.sdk': sdk, 'claude-code.terminal': terminal },
        environment: () => Promise.resolve({}),
      },
    },
    { ...NO_DESKTOP, pickFolder: () => Promise.resolve(mintTrustedPath(nextProject)) },
  );
  cores.push(core);
  await core.engines.view(canvas);
  const request = { topic: 'session' as const, canvas, agent: 'a' };
  const subscribe = (window = 1) => core.call('topics.subscribe', request, asHuman(window));
  const unsubscribe = (window = 1) => core.call('topics.unsubscribe', request, asHuman(window));
  return {
    core,
    canvas,
    sdk,
    terminal,
    subscribe,
    unsubscribe,
    nextProject,
    availability: (nextHeld: boolean, nextGeneration = generation) => {
      held = nextHeld;
      generation = nextGeneration;
      for (const listener of listeners) listener();
    },
  };
}

it('an admitted session view opens through SessionControl with the document settings; losing every view leaves it running', async () => {
  const open = vi.spyOn(SessionControl.prototype, 'open');
  const { core, canvas, sdk, subscribe, unsubscribe } = await setup();
  const detach = core.topics.listen(1, () => undefined);
  expect(await subscribe()).toMatchObject({ ok: true });
  await vi.waitFor(() => {
    expect(sdk.started).toHaveLength(1);
  });
  expect(open).toHaveBeenCalledWith({ canvas, agent: 'a' });
  expect(sdk.started[0]).toMatchObject({ model: 'chosen', mode: 'plan', role: 'Review carefully' });
  const session = sdk.sessions[0];
  if (!session) throw new Error('No session');
  const close = vi.spyOn(session, 'close');
  expect(await subscribe(2)).toMatchObject({ ok: true });
  await unsubscribe(2);
  await unsubscribe();
  detach();
  expect(close).not.toHaveBeenCalled();
  expect(sdk.started).toHaveLength(1);
});

it('StrictMode subscribe/unsubscribe/subscribe keeps one lease and one open attempt, including a refused start', async () => {
  const open = vi.spyOn(SessionControl.prototype, 'open');
  const { core, canvas, sdk, subscribe, unsubscribe } = await setup();
  const start = vi.spyOn(sdk, 'start').mockRejectedValue(new Error('Sign in first.'));
  expect(await subscribe()).toMatchObject({ ok: true });
  await unsubscribe();
  expect(await subscribe()).toMatchObject({ ok: true });
  await vi.waitFor(() => {
    expect(open).toHaveBeenCalledOnce();
  });
  await vi.waitFor(() => {
    expect(core.engines.canvas(canvas)?.engine.sessions.of('a').entries).toContainEqual(
      expect.objectContaining({ kind: 'notice', text: 'Sign in first.' }),
    );
  });
  expect(start).toHaveBeenCalledOnce();
});

it('a held view subscribes successfully and opens only when its active workspace generation is ready', async () => {
  const { core, canvas, sdk, subscribe, availability } = await setup();
  availability(true);
  expect(await subscribe()).toMatchObject({ ok: true });
  await vi.waitFor(() => {
    expect(core.engines.canvas(canvas)?.engine.sessions.of('a').entries).toContainEqual(
      expect.objectContaining({ kind: 'notice', text: 'Switch its worktree first.' }),
    );
  });
  expect(sdk.started).toHaveLength(0);
  availability(false);
  await vi.waitFor(() => {
    expect(sdk.started).toHaveLength(1);
  });
  const first = sdk.sessions[0];
  if (!first) throw new Error('No session');
  const close = vi.spyOn(first, 'close');
  availability(true, 1);
  await core.flush();
  expect(close).not.toHaveBeenCalled();
  // C7 installs the new binding only after its approved Switch closes the old session.
  await core.engines.canvas(canvas)?.engine.sessions.close('a');
  availability(false, 1);
  await vi.waitFor(() => {
    expect(sdk.started).toHaveLength(2);
  });
  availability(false, 1);
  await core.flush();
  expect(sdk.started).toHaveLength(2);
});

it('a connection change reopens a viewed session once on the new connection', async () => {
  const { core, canvas, sdk, terminal, subscribe } = await setup();
  await subscribe();
  await vi.waitFor(() => {
    expect(sdk.started).toHaveLength(1);
  });
  expect(
    await core.call(
      'agent.setConnection',
      { canvas, agent: 'a', connection: 'claude-code.terminal' },
      asHuman(1),
    ),
  ).toMatchObject({ ok: true });
  await vi.waitFor(() => {
    expect(terminal.started).toHaveLength(1);
  });
  await subscribe(2);
  await core.flush();
  expect(terminal.started).toHaveLength(1);
});

it('the first view of a Terminal agent starts it without a session.open operation', async () => {
  const { core, canvas, terminal, subscribe } = await setup();
  expect(
    await core.call(
      'agent.setConnection',
      { canvas, agent: 'a', connection: 'claude-code.terminal' },
      asHuman(1),
    ),
  ).toMatchObject({ ok: true });
  expect(terminal.started).toHaveLength(0);
  expect(await subscribe()).toMatchObject({ ok: true });
  await vi.waitFor(() => {
    expect(terminal.started).toHaveLength(1);
  });
});

it('neither a token subscription nor an internal projection follower opens a native session', async () => {
  const { core, canvas, sdk } = await setup();
  expect(
    await core.call(
      'topics.subscribe',
      { topic: 'session', canvas, agent: 'a' },
      CALLERS['outside-write'],
    ),
  ).toMatchObject({ ok: false });
  const follower = await core.topics.follow(CALLERS.you, `session:${canvas}:a`, () => undefined);
  follower.stop();
  expect(
    await core.call('topics.subscribe', { topic: 'session', canvas, agent: 'missing' }, asHuman(1)),
  ).toMatchObject({ ok: false });
  expect(
    await core.call(
      'topics.subscribe',
      { topic: 'session', canvas, agent: 'a' },
      asHuman(1),
      AbortSignal.abort(),
    ),
  ).toMatchObject({ ok: false });
  expect(sdk.started).toHaveLength(0);
});

it('a disconnected port releases its session view exactly once, including a repeated subscription', async () => {
  const release = vi.fn();
  const acquire = vi.spyOn(SessionViews.prototype, 'acquire').mockReturnValue(release);
  const { core, sdk, subscribe } = await setup();
  const detach = core.topics.listen(1, () => undefined);
  expect(await subscribe()).toMatchObject({ ok: true });
  expect(await subscribe()).toMatchObject({ ok: true });
  expect(acquire).toHaveBeenCalledOnce();
  detach();
  detach();
  expect(release).toHaveBeenCalledOnce();
  expect(sdk.started).toHaveLength(0);
});

it('Continue in Terminal and its existing view share one native launch on the new connection', async () => {
  const { core, canvas, sdk, terminal, subscribe } = await setup();
  await subscribe();
  await vi.waitFor(() => {
    expect(sdk.started).toHaveLength(1);
  });
  expect(
    await core.call(
      'session.continueIn',
      { canvas, agent: 'a', connection: 'claude-code.terminal' },
      asHuman(1),
    ),
  ).toMatchObject({ ok: true });
  await vi.waitFor(() => {
    expect(terminal.started).toHaveLength(1);
  });
  await subscribe(2);
  await core.flush();
  expect(terminal.started).toHaveLength(1);
});

it('a slow native launch does not delay the admitted subscription or start twice during StrictMode', async () => {
  const { sdk, subscribe, unsubscribe } = await setup();
  const started = Promise.withResolvers<undefined>();
  const start = sdk.start.bind(sdk);
  const launch = vi.spyOn(sdk, 'start').mockImplementation(async (...args) => {
    await started.promise;
    return start(...args);
  });
  try {
    expect(await subscribe()).toMatchObject({ ok: true });
    await unsubscribe();
    expect(await subscribe()).toMatchObject({ ok: true });
    await vi.waitFor(() => {
      expect(launch).toHaveBeenCalledOnce();
    });
  } finally {
    started.resolve(undefined);
  }
  await vi.waitFor(() => {
    expect(sdk.started).toHaveLength(1);
  });
});

it('a view admitted during a prepared shutdown waits until the shutdown is cancelled', async () => {
  const { core, sdk, subscribe } = await setup();
  await core.prepareShutdown('quit');
  expect(await subscribe()).toMatchObject({ ok: true });
  await core.flush();
  expect(sdk.started).toHaveLength(0);
  core.cancelShutdown();
  await vi.waitFor(() => {
    expect(sdk.started).toHaveLength(1);
  });
});

it('quitting waits for a viewed session still starting and closes it', async () => {
  const { core, sdk, subscribe } = await setup();
  const ready = Promise.withResolvers<undefined>();
  const start = sdk.start.bind(sdk);
  const close = vi.fn();
  const launch = vi.spyOn(sdk, 'start').mockImplementation(async (...args) => {
    await ready.promise;
    const session = await start(...args);
    const nativeClose = session.close.bind(session);
    session.close = async () => {
      close();
      await nativeClose();
    };
    return session;
  });
  await subscribe();
  await vi.waitFor(() => {
    expect(launch).toHaveBeenCalledOnce();
  });
  let closed = false;
  const quitting = core.close().then(() => {
    closed = true;
  });
  expect(closed).toBe(false);
  ready.resolve(undefined);
  await quitting;
  expect(close).toHaveBeenCalledOnce();
});

it('a project switch reopens a viewed session in the new folder once the old session has closed', async () => {
  const { core, canvas, sdk, subscribe, nextProject } = await setup();
  await subscribe();
  await vi.waitFor(() => {
    expect(sdk.started).toHaveLength(1);
  });
  const first = sdk.sessions[0];
  if (!first) throw new Error('No session');
  const stopped = Promise.withResolvers<undefined>();
  const nativeClose = first.close.bind(first);
  const close = vi.spyOn(first, 'close').mockImplementation(async () => {
    await stopped.promise;
    await nativeClose();
  });
  const switched = core.call('project.choose', { canvas }, asHuman(1));
  try {
    await vi.waitFor(() => {
      expect(close).toHaveBeenCalledOnce();
    });
    expect(sdk.started).toHaveLength(1);
  } finally {
    stopped.resolve(undefined);
  }
  expect(await switched).toMatchObject({ ok: true });
  await vi.waitFor(() => {
    expect(sdk.started).toHaveLength(2);
  });
  expect(close).toHaveBeenCalledOnce();
  expect(sdk.started[1]).toMatchObject({ cwd: nextProject });
});
