import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { Core } from './core';
import { createCore } from './core';
import { CALLERS, CANVAS, NO_DESKTOP } from './test-registry';
import { keepCanvases } from './store/test-store';
import { FakeConnector } from '../sessions/fake';
import type { Connector } from '../sessions/connector';
import type { SessionMode } from '../../shared/session';
import { gitEnvironment } from './workspaces/test-git';
import { SessionStore } from '../../shared/engine/delivery/mailbox';
import { TEST_ENGINE } from '../../shared/engine/test-engine';
import { NO_BACKEND } from '../../shared/engine/transcript/receive';
import type { GuiEventArgs } from '../../shared/gui-link';
import type { CoreChannel, IpcArgs, IpcResult } from '../../shared/ipc';
import { asHuman } from './gui';

let core: Core | undefined;
let root: string | undefined;
let store: SessionStore | undefined;
let releaseStartup: (() => void) | undefined;
afterEach(async () => {
  releaseStartup?.();
  releaseStartup = undefined;
  store?.reset();
  store = undefined;
  await core?.close();
  core = undefined;
  if (root !== undefined) await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function setup(holdRetry = false) {
  root = await mkdtemp(path.join(tmpdir(), 'corrallm-refusal-switch-'));
  const project = path.join(root, 'project');
  const profile = path.join(root, 'profile');
  const file = path.join(root, 'canvas.corral');
  await mkdir(project);
  await mkdir(profile);
  await writeFile(
    file,
    JSON.stringify({
      format: 'corrallm',
      version: 2,
      id: CANVAS,
      nodes: [
        {
          id: 'a',
          kind: 'agent',
          label: 'Shop',
          position: { x: 0, y: 0 },
          adapter: 'claude-code',
          connection: 'claude-code.sdk',
        },
      ],
      links: [],
    }),
  );
  await keepCanvases(profile, { [CANVAS]: { file, project } });
  const retry = Promise.withResolvers<never>();
  const start = vi.fn<Connector<SessionMode>['start']>((_spec, host) => {
    if (holdRetry && start.mock.calls.length > 1) {
      releaseStartup = () => {
        retry.reject(new Error('This login cannot run here.'));
      };
      return retry.promise;
    }
    host.emit({
      type: 'notice',
      id: crypto.randomUUID(),
      level: 'error',
      text: 'This login cannot run here.',
      switchTo: 'claude-code.terminal',
    });
    return Promise.reject(new Error('This login cannot run here.'));
  });
  const sdk: Connector<SessionMode> = { start };
  const terminal = new FakeConnector({ mode: 'acceptEdits', step: () => Promise.resolve() });
  const env = gitEnvironment(path.join(root, 'home'));
  core = await createCore(
    {
      profile,
      app: { name: 'corrallm', version: '1' },
      distribution: 'local',
      check: true,
      watchFolder: () => ({ close: () => undefined }),
      children: {
        platform: 'darwin',
        inspect: (pid) => ({ started: 1, group: pid }),
        alive: () => false,
        signal: () => undefined,
        wait: () => Promise.resolve(),
        pause: () => undefined,
        now: Date.now,
      },
      sessions: {
        connectors: { 'claude-code.sdk': sdk, 'claude-code.terminal': terminal },
        environment: () => Promise.resolve(env),
      },
    },
    NO_DESKTOP,
  );
  return { core, terminal, start, retry };
}

it('delivers a refused message once after Continue in Terminal on a non-repository project', async () => {
  const { core, terminal } = await setup();
  await core.engines.open(CANVAS);
  const open = core.engines.canvas(CANVAS);
  if (!open) throw new Error('No runtime');
  const sent = await core.call(
    'message',
    { canvas: CANVAS, to: 'a', body: 'Fix the login bug' },
    CALLERS.you,
  );
  if (!sent.ok) throw new Error(sent.error.sentence);
  await vi.waitFor(() => {
    expect(
      open.engine.sessions
        .of('a')
        .entries.some(
          (entry) => entry.kind === 'notice' && entry.switchTo === 'claude-code.terminal',
        ),
    ).toBe(true);
    expect(open.messages.get(sent.value.id)?.state).toBe('pending');
  });
  expect(terminal.started).toHaveLength(0);
  expect(
    await core.call(
      'session.continueIn',
      { canvas: CANVAS, agent: 'a', connection: 'claude-code.terminal' },
      CALLERS.you,
    ),
  ).toMatchObject({ ok: true });
  await vi.waitFor(() => {
    expect(terminal.sessions.flatMap((session) => session.sent.map(({ text }) => text))).toEqual([
      'Fix the login bug',
    ]);
    expect(open.messages.get(sent.value.id)?.state).toBe('replied');
  });
  expect(terminal.started).toHaveLength(1);
});

it('delivers the window-owned refused message after Switch to Terminal on a non-repository project', async () => {
  const { core, terminal, start, retry } = await setup(true);
  const window = 1;
  expect(await core.call('window.show', { canvas: CANVAS }, asHuman(window))).toMatchObject({
    ok: true,
  });
  const channel = async <C extends CoreChannel>(
    name: C,
    ...args: IpcArgs<C>
  ): Promise<IpcResult<C>> => (await core.channels.call(window, name, args)) as IpcResult<C>;
  const sessions = new SessionStore(TEST_ENGINE, {
    ...NO_BACKEND,
    availability: (agent) => channel('session:availability', agent),
    onAvailability: (listener) =>
      core.channels.listen(window, (name) => {
        if (name === 'session:availability') listener();
      }),
    start: (agent, options) => channel('session:start', agent, options),
    send: (agent, message) => channel('session:send', agent, message),
    close: (agent) => channel('session:close', agent),
    onEvent: (listener) =>
      core.channels.listen(window, (name, args) => {
        if (name === 'session:event') listener(...(args as GuiEventArgs<'session:event'>));
      }),
  });
  store = sessions;
  sessions.sync([{ id: 'a', connection: 'claude-code.sdk' }]);
  sessions.open('a');
  await vi.waitFor(() => {
    expect(sessions.of('a').entries).toContainEqual(
      expect.objectContaining({ kind: 'notice', switchTo: 'claude-code.terminal' }),
    );
  });
  sessions.send('a', 'claude-code', 'Fix the login bug');
  await vi.waitFor(() => {
    expect(sessions.of('a').queued.map(({ text }) => text)).toEqual(['Fix the login bug']);
  });
  await vi.waitFor(() => {
    expect(start).toHaveBeenCalledTimes(2);
  });
  expect(terminal.started).toHaveLength(0);
  expect(
    await core.call(
      'agent.setConnection',
      { canvas: CANVAS, agent: 'a', connection: 'claude-code.terminal' },
      asHuman(window),
    ),
  ).toMatchObject({ ok: true });
  sessions.sync([{ id: 'a', connection: 'claude-code.terminal' }]);
  sessions.open('a');
  retry.reject(new Error('This login cannot run here.'));
  await vi.waitFor(() => {
    expect(terminal.sessions.flatMap((session) => session.sent.map(({ text }) => text))).toEqual([
      'Fix the login bug',
    ]);
    expect(sessions.of('a').submissions?.[0]?.status).toBe('completed');
  });
  expect(terminal.started).toHaveLength(1);
});
