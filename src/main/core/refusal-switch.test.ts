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
import type { CoreChannel, IpcArgs, IpcResult } from '../../shared/ipc';
import { asHuman } from './gui';

let core: Core | undefined;
let root: string | undefined;
let releaseStartup: (() => void) | undefined;
afterEach(async () => {
  releaseStartup?.();
  releaseStartup = undefined;
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

it('delivers the window’s refused manual message after Switch to Terminal on a non-repository project', async () => {
  const { core, terminal, start, retry } = await setup(true);
  const window = 1;
  expect(await core.call('window.show', { canvas: CANVAS }, asHuman(window))).toMatchObject({
    ok: true,
  });
  const channel = async <C extends CoreChannel>(
    name: C,
    ...args: IpcArgs<C>
  ): Promise<IpcResult<C>> => (await core.channels.call(window, name, args)) as IpcResult<C>;
  await core.call('session.open', { canvas: CANVAS, agent: 'a' }, asHuman(window));
  const open = core.engines.canvas(CANVAS);
  if (!open) throw new Error('No runtime');
  await vi.waitFor(() => {
    expect(open.engine.sessions.of('a').entries).toContainEqual(
      expect.objectContaining({ kind: 'notice', switchTo: 'claude-code.terminal' }),
    );
  });
  const sent = await channel('session:send', 'a', {
    id: crypto.randomUUID(),
    text: 'Fix the login bug',
  });
  await vi.waitFor(() => {
    // Core delivery has journaled its attempt, but startup has not handed it to the CLI.
    expect(open.messages.get(sent.id)?.state).toBe('delivering');
    expect(start).toHaveBeenCalledTimes(2);
  });
  expect(terminal.started).toHaveLength(0);
  const switching = core.call(
    'session.continueIn',
    { canvas: CANVAS, agent: 'a', connection: 'claude-code.terminal' },
    asHuman(window),
  );
  await vi.waitFor(() => {
    const agent = open.document.nodes.find((node) => node.id === 'a');
    expect(agent?.type === 'agent' && agent.data.connection).toBe('claude-code.terminal');
  });
  retry.reject(new Error('This login cannot run here.'));
  expect(await switching).toMatchObject({ ok: true });
  await vi.waitFor(() => {
    expect(terminal.sessions.flatMap((session) => session.sent.map(({ text }) => text))).toEqual([
      'Fix the login bug',
    ]);
    expect(open.messages.get(sent.id)?.state).toBe('replied');
  });
  expect(terminal.started).toHaveLength(1);
});
