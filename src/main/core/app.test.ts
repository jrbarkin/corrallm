import type { OpResult } from '../../shared/api/errors';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { canvasIdOf, newCanvasId } from '../../shared/canvas';
import type { CanvasId } from '../../shared/canvas';
import type { CoreGuiSide, GuiSide, GuiEvent, GuiEventArgs } from '../../shared/gui-link';
import type { CoreChannel, IpcArgs, IpcResult } from '../../shared/ipc';
import type { CoreLink } from '../../shared/link';
import { toFile } from '../../shared/model/file';
import type { TerminalEvent } from '../../shared/terminal';
import type { SessionHost } from '../sessions/connector';
import { FakeConnector } from '../sessions/fake';
import { createCore } from './core';
import type { Core, CoreConfig } from './core';
import { WindowPorts } from './gui';
import { mintTrustedPath } from './host';
import { journaledRun, keepCanvases, openedLast, readOnDisk } from './store/test-store';
import { CALLERS, NO_DESKTOP } from './test-registry';
import { openWindow } from './test-window';
import { ProjectDirectories } from './workspaces/resolver';

type WindowLink = CoreLink<GuiSide, CoreGuiSide>;
let profile: string;
let folder: string;
let core: Core | undefined;
const closing: (() => void)[] = [];

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-app-core-'));
  folder = path.join(profile, 'project');
  await mkdir(folder);
  vi.stubEnv(
    'CORRALLM_AGENT_PATHS',
    JSON.stringify({
      'claude-code': path.join(profile, 'no-claude'),
      codex: path.join(profile, 'no-codex'),
    }),
  );
});
afterEach(async () => {
  delete dialogs.open;
  delete dialogs.save;
  for (const close of closing.splice(0)) close();
  await core?.close();
  core = undefined;
  vi.unstubAllEnvs();
  await rm(profile, { recursive: true, force: true });
});

/** What the Open and Save dialogs answer next: a file, or nothing (cancelled). */
const dialogs: { open?: string; save?: string } = {};
const picked = (file: string | undefined) =>
  Promise.resolve(file === undefined ? null : mintTrustedPath(file));

async function app(
  sessions?: CoreConfig['sessions'],
  watchdog?: CoreConfig['watchdog'],
  watchdogNetwork?: CoreConfig['watchdogNetwork'],
) {
  const host = {
    ...NO_DESKTOP,
    pickFolder: vi.fn(() => Promise.resolve(mintTrustedPath(folder))),
    pickCanvasToOpen: vi.fn(() => picked(dialogs.open)),
    pickCanvasToSave: vi.fn(() => picked(dialogs.save)),
    runReady: vi.fn(() => Promise.resolve(null)),
  };
  core = await createCore(
    {
      profile,
      app: { name: 'corrallm', version: '1.2.3' },
      check: true,
      distribution: 'local',
      locale: 'en-US',
      fakeSessions: true,
      ...(sessions === undefined ? {} : { sessions }),
      ...(watchdog === undefined ? {} : { watchdog }),
      ...(watchdogNetwork === undefined ? {} : { watchdogNetwork }),
    },
    host,
  );
  const served = new WindowPorts(core);
  const connect = (id: number) => {
    const window = openWindow(served, id);
    closing.push(window.close);
    return window.link;
  };
  return { core, host, served, connect };
}

async function channel<C extends CoreChannel>(
  window: WindowLink,
  name: C,
  ...args: IpcArgs<C>
): Promise<IpcResult<C>> {
  const answer = await window.request('channel', name, args);
  if (!answer.ok) throw new Error(answer.error.message);
  return answer.value as IpcResult<C>;
}

/** Calls `op` over `window`'s port, as its renderer does: its result, or throws its sentence. */
async function call(
  window: WindowLink,
  op: string,
  args: object,
): Promise<Record<string, unknown>> {
  const answer = await window.request('call', op, args);
  if (!answer.ok) throw new Error(answer.error.message);
  const result = answer.value as OpResult<Record<string, unknown>>;
  if (!result.ok) throw new Error(result.error.sentence);
  return result.value;
}
/** Begins a new canvas in `window`, as New does: its id. */
async function created(window: WindowLink): Promise<CanvasId> {
  return (await call(window, 'canvas.create', {})).canvas as CanvasId;
}
/** Picks the project folder of the canvas `window` shows, in the folder dialog. */
async function chooseProject(window: WindowLink): Promise<void> {
  const { canvas } = await call(window, 'window.get', {});
  await call(window, 'project.choose', { canvas: canvas as string });
}
/** The canvas `window` shows (window.get). */
async function shownIn(window: WindowLink): Promise<CanvasId> {
  return (await call(window, 'window.get', {})).canvas as CanvasId;
}
/** Adds an agent running on `connection` to the canvas `window` shows, as you: its id. */
async function agentOn(window: WindowLink, connection: string): Promise<string> {
  const canvas = await shownIn(window);
  const { id } = await call(window, 'canvas.addAgent', {
    canvas,
    at: { x: 0, y: 0 },
    adapter:
      connection.split('.')[0] ??
      (() => {
        throw new Error('No adapter');
      })(),
    connection,
  });
  return id as string;
}
/** Opens `agent`'s session as its agent window does (session.open): the core's own session. */
async function opened(window: WindowLink, agent: string): Promise<void> {
  await call(window, 'session.open', { canvas: await shownIn(window), agent });
}

function events(window: WindowLink) {
  const heard: [GuiEvent, GuiEventArgs<GuiEvent>][] = [];
  window.on('event', (name, args) => {
    heard.push([name, args]);
  });
  return heard;
}

describe('working-directory routing', () => {
  afterEach(() => vi.restoreAllMocks());

  async function setup() {
    const fake = new FakeConnector({ adapter: 'codex' });
    const options = vi.fn(() =>
      Promise.resolve({
        models: [],
        defaults: { model: null, mode: null, effort: null },
      }),
    );
    const { core, connect } = await app({
      connectors: { 'codex.app-server': fake },
      environment: () => Promise.resolve({ HOME: profile }),
      options: { codex: options },
    });
    const window = connect(7);
    const canvas = await created(window);
    await chooseProject(window);
    const { id } = await call(window, 'canvas.addAgent', {
      canvas,
      at: { x: 0, y: 0 },
      adapter: 'codex',
      connection: 'codex.app-server',
    });
    return { core, window, canvas, agent: id as string, options };
  }

  it.each([
    { how: 'start', op: 'session.open' },
    { how: 'restart', op: 'session.restart' },
    { how: 'fresh', op: 'session.newConversation' },
  ])('asks the resolver before a $how launch', async ({ how, op }) => {
    const { window, canvas, agent } = await setup();
    if (how !== 'start') await opened(window, agent);
    const resolve = vi.spyOn(ProjectDirectories.prototype, 'workingDirectory').mockResolvedValue({
      state: 'held',
      reason: 'no-project',
      sentence: 'Pick a folder first.',
    });
    await expect(call(window, op, { canvas, agent })).rejects.toThrow('Pick a folder first.');
    expect(resolve).toHaveBeenCalledWith(canvas, agent);
  });

  it('asks the resolver before listing conversations', async () => {
    const { window, canvas, agent } = await setup();
    const resolve = vi.spyOn(ProjectDirectories.prototype, 'workingDirectory').mockResolvedValue({
      state: 'held',
      reason: 'no-project',
      sentence: 'Pick a folder first.',
    });
    await expect(channel(window, 'session:list', agent)).rejects.toThrow('Pick a folder first.');
    expect(resolve).toHaveBeenCalledWith(canvas, agent);
  });

  it('checks the resolved directory before accepting a listed conversation', async () => {
    const { window, canvas, agent } = await setup();
    const resolve = vi.spyOn(ProjectDirectories.prototype, 'workingDirectory').mockResolvedValue({
      state: 'held',
      reason: 'no-project',
      sentence: 'Pick a folder first.',
    });
    await expect(
      channel(window, 'session:resume', agent, '0199a3f0-1234-7000-8000-123456789abc'),
    ).rejects.toThrow(/not one of/);
    expect(resolve).toHaveBeenCalledWith(canvas, agent);
  });

  it('gets canvas-wide options from the root accessor, keeping the no-project home fallback', async () => {
    const { window, canvas, options } = await setup();
    const root = vi.spyOn(ProjectDirectories.prototype, 'projectRoot').mockReturnValue(undefined);
    await channel(window, 'session:options', 'codex');
    expect(root).toHaveBeenCalledWith(canvas);
    expect(options).toHaveBeenCalledWith({ cwd: profile, env: { HOME: profile } });
  });

  it('gets project.files from the root accessor, returning empty when unavailable', async () => {
    const { window, canvas } = await setup();
    await writeFile(path.join(folder, 'visible.txt'), 'hello');
    const root = vi.spyOn(ProjectDirectories.prototype, 'projectRoot').mockReturnValue(undefined);
    expect(await call(window, 'project.files', { canvas, query: '' })).toEqual({ items: [] });
    expect(root).toHaveBeenCalledWith(canvas);
  });

  it('gets reveal containment from the root accessor, refusing when unavailable', async () => {
    const { window, canvas } = await setup();
    const file = path.join(folder, 'visible.txt');
    await writeFile(file, 'hello');
    const root = vi.spyOn(ProjectDirectories.prototype, 'projectRoot').mockReturnValue(undefined);
    expect(await call(window, 'link.reveal', { url: pathToFileURL(file).href })).toEqual({
      revealed: false,
      revs: {},
    });
    expect(root).toHaveBeenCalledWith(canvas);
  });

  it('uses the root accessor for the headless engine file picker too', async () => {
    const { core, canvas } = await setup();
    const engine = await core.engines.open(canvas);
    await writeFile(path.join(folder, 'visible.txt'), 'hello');
    const root = vi.spyOn(ProjectDirectories.prototype, 'projectRoot').mockReturnValue(undefined);
    expect(await engine.sessions.findFiles('')).toEqual([]);
    expect(root).toHaveBeenCalledWith(canvas);
  });
});

describe('the app’s core and window channels', () => {
  it.each(
    ['codex.app-server', 'codex.terminal', 'claude-code.sdk', 'claude-code.terminal'].flatMap(
      (connection) => ['wake', 'network'].map((trigger) => ({ connection, trigger })),
    ),
  )(
    'warns a silent $connection turn after $trigger and answers its Needs item, on the canvas the core runs',
    async ({ connection, trigger }) => {
      const en0 = (address: string) => ({
        en0: [
          {
            family: 'IPv4' as const,
            address,
            netmask: '255.255.255.0',
            internal: false,
            mac: '',
            cidr: `${address}/24`,
          },
        ],
      });
      let interfaces: ReturnType<NonNullable<CoreConfig['watchdogNetwork']>> = en0('192.0.2.1');
      let now = Date.now();
      let tick: (() => void) | undefined;
      let host: SessionHost | undefined;
      const interrupt = vi.fn(() => {
        host?.emit({
          type: 'end',
          messages: ['m'],
          seconds: 1,
          result: { status: 'cancelled', reason: 'interrupted' },
        });
        return Promise.resolve();
      });
      const { core, connect } = await app(
        {
          connectors: {
            [connection]: {
              start: (_spec, given) => {
                host = given;
                given.emit({ type: 'started', model: null, mode: null, models: [] });
                return Promise.resolve({
                  send: (message) => {
                    given.emit({ type: 'user', id: message.id, text: message.text });
                    given.emit({ type: 'status', status: 'working' });
                    return Promise.resolve();
                  },
                  interrupt,
                  close: () => Promise.resolve(),
                  answer: () => Promise.resolve(),
                  setMode: () => Promise.resolve(),
                  setModel: () => Promise.resolve(),
                });
              },
            },
          },
          environment: () => Promise.resolve({}),
        },
        {
          now: () => now,
          later: (run) => {
            tick = run;
            return () => {
              tick = undefined;
            };
          },
        },
        () => interfaces,
      );
      const window = connect(7);
      const canvas = await created(window);
      await chooseProject(window);
      const a = await agentOn(window, connection);
      await opened(window, a);
      await channel(window, 'session:send', a, { id: 'm', text: 'Hello' });
      await vi.waitFor(() => {
        expect(core.engines.canvas(canvas)?.engine.sessions.of(a).status).toBe('working');
      });
      // The window only views it: the core runs the canvas it shows (B11 Design §8).
      expect(core.engines.opened()).toEqual([canvas]);
      for (let i = 0; i < 79; i++) {
        now += 15_000;
        tick?.();
      }
      host?.activity?.(); // Raw output counts even with no attached terminal view.
      now += 15_000;
      tick?.();
      expect(await core.call('needs', { canvas }, CALLERS.you)).toMatchObject({
        ok: true,
        value: { items: [] },
      });
      // Either host event grants two fresh minutes, never an immediate warning.
      if (trigger === 'wake') {
        now += 3 * 60 * 60_000;
        core.resumed();
      } else {
        interfaces = en0('198.51.100.1'); // Another network: the old address is gone.
      }
      tick?.();
      for (let i = 0; i < 7; i++) {
        now += 15_000;
        tick?.();
      }
      expect(await core.call('needs', { canvas }, CALLERS.you)).toMatchObject({
        ok: true,
        value: { items: [] },
      });
      now += 15_000;
      tick?.();
      await vi.waitFor(() => {
        expect(core.engines.canvas(canvas)?.engine.sessions.of(a).entries).toContainEqual(
          expect.objectContaining({
            kind: 'notice',
            level: 'warning',
            text: expect.stringContaining(
              trigger === 'network'
                ? '2 minutes after the network changed'
                : '2 minutes after waking',
            ) as unknown,
          }),
        );
      });
      expect(await core.call('needs', { canvas }, CALLERS.you)).toMatchObject({
        ok: true,
        value: {
          items: [expect.objectContaining({ id: `stalled/${a}`, agent: a })],
        },
      });
      expect(interrupt).not.toHaveBeenCalled();
      expect(
        await core.call(
          'reply',
          { canvas, to: `stalled/${a}`, answer: { choice: 'interrupt' } },
          CALLERS.you,
        ),
      ).toMatchObject({ ok: true });
      expect(interrupt).toHaveBeenCalledOnce();
      expect(await core.call('needs', { canvas }, CALLERS.you)).toMatchObject({
        ok: true,
        value: { items: [] },
      });
    },
  );
  it('shares usage operations between windows', async () => {
    const { core, connect } = await app();
    const seven = connect(7);
    const eight = connect(8);
    const rule = { window: 'weekly', percent: 80, action: 'ask' };

    await expect(
      seven.request('call', 'usage.setRule', { backend: 'codex', rule }),
    ).resolves.toEqual({
      ok: true,
      value: { ok: true, value: { revs: {} } },
    });
    const state = { readings: [], rules: { codex: rule } };
    expect(await call(eight, 'usage.get', {})).toEqual(state);
    await call(eight, 'usage.setRule', { backend: 'codex', rule: null });
    await expect(core.call('usage.get', {}, CALLERS.you)).resolves.toEqual({
      ok: true,
      value: { readings: [], rules: {} },
    });
  });

  it('runs fake sessions and options in the core, sending session events only to their canvas’s window', async () => {
    const { connect, host } = await app();
    const seven = connect(7);
    const eight = connect(8);
    const own = await created(seven);
    const other = await created(eight);
    expect(own).not.toBe(other);
    await chooseProject(seven);
    expect(host.pickFolder).toHaveBeenCalledWith(7, undefined);
    const options = await channel(seven, 'session:options', 'codex');
    expect(options.models[0]?.value).toBe('default');
    const agent = await agentOn(seven, 'codex.app-server');
    const a = events(seven);
    const b = events(eight);

    await opened(seven, agent);
    await vi.waitFor(() => {
      expect(a).toContainEqual([
        'session:event',
        [agent, 'codex.app-server', expect.objectContaining({ type: 'started' })],
      ]);
    });
    await call(eight, 'usage.get', {});
    expect(b).toEqual([]);
  });

  it('routes an attached terminal’s screen to its canvas’s window', async () => {
    const fake = new FakeConnector({ adapter: 'codex' });
    const start = fake.start.bind(fake);
    vi.spyOn(fake, 'start').mockImplementation(async (spec, host) =>
      Object.assign(await start(spec, host), {
        terminal: {
          show: (view: (event: TerminalEvent) => void) => {
            view({ type: 'screen', data: 'hello', cols: 80, rows: 24 });
            return () => undefined;
          },
          input: () => undefined,
          resize: () => undefined,
          paste: () => undefined,
        },
      }),
    );
    const { connect } = await app({
      connectors: { 'codex.terminal': fake },
      environment: () => Promise.resolve({}),
    });
    const seven = connect(7);
    const eight = connect(8);
    await created(seven);
    await created(eight);
    await chooseProject(seven);
    const agent = await agentOn(seven, 'codex.terminal');
    await opened(seven, agent);
    const a = events(seven);
    const b = events(eight);
    await expect(seven.request('call', 'terminal.attach', { agent })).resolves.toEqual({
      ok: true,
      value: { ok: true, value: { revs: {} } },
    });
    await vi.waitFor(() => {
      expect(a).toEqual([
        ['terminal', [agent, { type: 'screen', data: 'hello', cols: 80, rows: 24 }]],
      ]);
    });
    await call(eight, 'usage.get', {});
    expect(b).toEqual([]);
  });

  it('tells the window a turn’s hit limit with when it lifts, as the core held its backend', async () => {
    const resetsAt = Date.now() + 60 * 60_000;
    // Claude Code's latest reading, as the core keeps it from its status line: its 5-hour window
    // used up.
    await writeFile(
      path.join(profile, 'usage.json'),
      JSON.stringify({
        version: 2,
        readings: [
          {
            backend: 'claude-code',
            windows: { fiveHour: { usedPercent: 100, resetsAt } },
            at: Date.now(),
          },
        ],
      }),
    );
    // In a mode that runs its command without asking, so its turn goes to its end.
    const fake = new FakeConnector({ adapter: 'claude-code', mode: 'acceptEdits' });
    const start = fake.start.bind(fake);
    // Its turn ends as Claude Code's Terminal ends one at its limit: usage-limit, saying no reset.
    vi.spyOn(fake, 'start').mockImplementation((spec, host) =>
      start(spec, {
        ...host,
        emit: (event) => {
          host.emit(
            event.type === 'end'
              ? { ...event, result: { status: 'failed', reason: 'usage-limit', message: 'Limit' } }
              : event,
          );
        },
      }),
    );
    const { connect } = await app({
      connectors: { 'claude-code.terminal': fake },
      environment: () => Promise.resolve({}),
    });
    const seven = connect(7);
    await created(seven);
    await chooseProject(seven);
    const agent = await agentOn(seven, 'claude-code.terminal');
    const heard = events(seven);
    await opened(seven, agent);
    await channel(seven, 'session:send', agent, { id: crypto.randomUUID(), text: 'Hello' });
    await vi.waitFor(() => {
      expect(heard).toContainEqual([
        'session:event',
        [
          agent,
          'claude-code.terminal',
          expect.objectContaining({
            type: 'end',
            result: { status: 'failed', reason: 'usage-limit', message: 'Limit', resetsAt },
          }),
        ],
      ]);
    });
  });

  it('keeps the canvas and its sessions across a reload, a crash or a close: the core runs it', async () => {
    const fake = new FakeConnector({ adapter: 'codex' });
    const { core, connect, served } = await app({
      connectors: { 'codex.app-server': fake },
      environment: () => Promise.resolve({}),
    });
    const before = connect(7);
    const id = await created(before);
    await chooseProject(before);
    const agent = await agentOn(before, 'codex.app-server');
    await opened(before, agent);
    const session = fake.sessions[0];
    if (!session) throw new Error('no session');
    const close = vi.spyOn(session, 'close');
    // Reloaded or crashed: the page that reconnects finds its canvas, and nothing of it ended.
    served.gone(7);
    const after = connect(7);
    expect(await shownIn(after)).toBe(id);
    expect(core.engines.opened()).toEqual([id]);
    // Closed: the window is forgotten, its canvas runs on.
    served.gone(7, true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(core.engines.opened()).toEqual([id]);
    expect(close).not.toHaveBeenCalled();
    expect(core.engines.canvas(id)?.state).toBe('executing');
  });

  it('flushes the core’s journal, usage and conversation ids in the profile it owns', async () => {
    const { core, connect } = await app();
    const window = connect(7);
    const id = await created(window);
    await chooseProject(window);
    await opened(window, await agentOn(window, 'codex.app-server'));
    await call(window, 'usage.setRule', {
      backend: 'codex',
      rule: { window: 'weekly', percent: 80, action: 'ask' },
    });
    await core.flush();

    // The run of the canvas the window shows is the core's, journaled by its engine.
    expect(journaledRun(profile, id)).toMatchObject({ version: 2 });
    expect(JSON.parse(await readFile(path.join(profile, 'usage.json'), 'utf8'))).toMatchObject({
      rules: { codex: { percent: 80 } },
    });
    expect(
      readOnDisk(profile, (disk) =>
        disk.prepare('SELECT adapter FROM conversation WHERE canvas_id = ?').all(id),
      ),
    ).toEqual([{ adapter: 'codex' }]);
  });

  it('refuses a page-supplied window or malformed channel arguments before asking the host', async () => {
    const { connect } = await app();
    const window = connect(7);
    expect(await window.request('channel', 'session:interrupt', ['a', 8])).toEqual({
      ok: false,
      error: { message: expect.stringMatching(/^Expected/) as unknown },
    });
    expect(await window.request('channel', 'session:interrupt', null as never)).toEqual({
      ok: false,
      error: { message: 'Expected channel arguments' },
    });
    expect(await window.request('channel', 'core:connect', [])).toEqual({
      ok: false,
      error: { message: 'corrallm’s window has no channel named core:connect.' },
    });
  });

  it.each(['run:get', 'run:save', 'run:ready', 'session:start', 'session:close', 'session:fresh'])(
    'has no %s: a window reads and drives the core’s run, never its own (B11 Design §8)',
    async (name) => {
      const { core, connect } = await app();
      const window = connect(7);
      const id = await created(window);
      expect(await window.request('channel', name, [])).toEqual({
        ok: false,
        error: { message: `corrallm’s window has no channel named ${name}.` },
      });
      expect(core.engines.canvas(id)?.state).toBe('executing');
    },
  );
});

describe('the canvas’s document, which the core keeps', () => {
  /** A canvas of one agent, `label`, as its file holds it. */
  const canvasText = (id: CanvasId, label = 'Lead', arrange = false) =>
    toFile({
      id,
      arrange,
      nodes: [{ id: 'lead', type: 'agent', position: { x: 0, y: 0 }, data: { label } }],
      links: [],
    });
  const fileIn = (name: string) => path.join(profile, name);
  /** The labels of the nodes a canvas file holds. */
  const labelsIn = async (name: string) =>
    (JSON.parse(await readFile(fileIn(name), 'utf8')) as { nodes: { label: string }[] }).nodes.map(
      (node) => node.label,
    );
  /** Adds an agent named `label` to `canvas`, as you, once the window has read it: its id. */
  async function agentIn(window: WindowLink, canvas: CanvasId, label: string): Promise<string> {
    await call(window, 'canvas.get', { canvas });
    const { id } = await call(window, 'canvas.addAgent', {
      canvas,
      adapter: 'codex',
      at: { x: 0, y: 0 },
    });
    await call(window, 'canvas.rename', { canvas, node: id as string, label });
    return id as string;
  }
  /** Restarts the core on the same profile, as the app does when it starts again. */
  async function restart() {
    for (const close of closing.splice(0)) close();
    await core?.close();
    core = undefined;
    return app();
  }

  it('restores a canvas with its edits since it was saved, from its rows, across a restart', async () => {
    const { connect } = await app();
    const window = connect(7);
    const id = await created(window);
    const lead = await agentIn(window, id, 'Lead');
    dialogs.save = fileIn('team.corral');
    expect(await call(window, 'canvas.saveAs', { canvas: id })).toMatchObject({
      name: 'team.corral',
    });
    await call(window, 'canvas.rename', { canvas: id, node: lead, label: 'Head' });

    const restarted = await restart();
    const restored = restarted.connect(7);
    expect(await call(restored, 'canvas.get', { canvas: id })).toMatchObject({
      // Its file's name, and its edit since that file was saved.
      name: 'team.corral',
      edited: true,
      nodes: [
        expect.objectContaining({
          data: expect.objectContaining({ label: 'Head' }) as unknown,
        }) as unknown,
      ],
    });

    // The window shows it again, the core running it, its run restored as it was kept.
    expect(await shownIn(restored)).toBe(id);
    expect(restarted.core.engines.canvas(id)?.state).toBe('executing');
    expect(await labelsIn('team.corral')).toEqual(['Lead']);
  });

  it('saves each canvas as the core has it, under its own id: the restored one, a draft, one opened', async () => {
    const { connect } = await app();
    const window = connect(7);
    const saves = async (id: CanvasId, name: string) => {
      dialogs.save = fileIn(name);
      expect(await call(window, 'canvas.saveAs', { canvas: id })).toMatchObject({ name });
      expect(canvasIdOf(await readFile(fileIn(name), 'utf8'))).toBe(id);
    };
    const restored = await shownIn(window);
    await agentIn(window, restored, 'Lead');
    await saves(restored, 'restored.corral');
    expect(await labelsIn('restored.corral')).toEqual(['Lead']);
    // Its arrangement too, a saved setting: on, it is written.
    const draft = await created(window);
    await call(window, 'canvas.setArrange', { canvas: draft, on: true });
    await saves(draft, 'draft.corral');
    expect(JSON.parse(await readFile(fileIn('draft.corral'), 'utf8'))).toHaveProperty(
      'arrange',
      true,
    );
    const opened = newCanvasId();
    await writeFile(fileIn('opened.corral'), canvasText(opened, 'Opened'));
    dialogs.open = fileIn('opened.corral');
    expect(await call(window, 'canvas.open', {})).toMatchObject({ canvas: opened });
    expect(await call(window, 'canvas.save', { canvas: opened })).toMatchObject({
      name: 'opened.corral',
    });
    expect(await readFile(fileIn('opened.corral'), 'utf8')).toBe(canvasText(opened, 'Opened'));
  });

  it('reads back on open what a saved arrangement says', async () => {
    const id = newCanvasId();
    await writeFile(fileIn('arranged.corral'), canvasText(id, 'Lead', true));
    const { connect } = await app();
    const window = connect(7);
    dialogs.open = fileIn('arranged.corral');
    await call(window, 'canvas.open', {});
    expect(await call(window, 'canvas.get', { canvas: id })).toMatchObject({ arrange: true });
  });

  it('refuses a file that isn’t a canvas, keeping the canvas shown, never taking the file as its', async () => {
    const { connect } = await app();
    const window = connect(7);
    const id = await created(window);
    const lead = await agentIn(window, id, 'Lead');
    dialogs.save = fileIn('kept.corral');
    await call(window, 'canvas.saveAs', { canvas: id });
    await writeFile(fileIn('notes.corral'), 'Remember the milk');
    dialogs.open = fileIn('notes.corral');

    await expect(call(window, 'canvas.open', {})).rejects.toThrow(
      'notes.corral: This is not a corrallm canvas',
    );

    expect(await shownIn(window)).toBe(id);
    await call(window, 'canvas.rename', { canvas: id, node: lead, label: 'Head' });
    await call(window, 'canvas.save', { canvas: id });
    expect(await labelsIn('kept.corral')).toEqual(['Head']);
    expect(await readFile(fileIn('notes.corral'), 'utf8')).toBe('Remember the milk');
    expect(
      readOnDisk(profile, (disk) =>
        disk.prepare('SELECT id FROM canvas WHERE file = ?').all(fileIn('notes.corral')),
      ),
    ).toEqual([]);
  });

  it('journals the run the core runs of a canvas, never a document revision', async () => {
    const { core, connect } = await app();
    const window = connect(7);
    const id = await created(window);
    const revisions = () =>
      readOnDisk(profile, (disk) =>
        disk.prepare('SELECT rev, op FROM revision WHERE canvas_id = ?').all(id),
      );
    await core.flush();
    expect(journaledRun(profile, id)).toMatchObject({ version: 2 });
    expect(revisions()).toEqual([]);
  });

  it('says why a canvas whose file isn’t one can’t be restored, and begins another', async () => {
    const id = newCanvasId();
    await writeFile(fileIn('broken.corral'), 'Remember the milk');
    await keepCanvases(profile, { [id]: { file: fileIn('broken.corral') } });
    await openedLast(profile, id);
    const { connect } = await app();
    const window = connect(7);

    const failed = await window.request('call', 'canvas.get', { canvas: id });
    expect(failed).toMatchObject({
      ok: true,
      value: {
        ok: false,
        error: {
          sentence: expect.stringContaining(
            'broken.corral: This is not a corrallm canvas',
          ) as unknown,
        },
      },
    });

    const draft = await created(window);
    expect(await shownIn(window)).toBe(draft);
  });
});

it('keeps transitional manual sends in the core mailbox, and refuses them at the shutdown barrier', async () => {
  const { core, connect, served } = await app();
  const window = connect(7);
  const canvas = await created(window);
  const agent = await agentOn(window, 'codex.app-server');
  // Accepted and durable in the core, never a window-owned submission queue.
  const images = [{ mediaType: 'image/png' as const, data: 'AQ==' }];
  const kept = await channel(window, 'session:send', agent, {
    id: crypto.randomUUID(),
    text: 'Keep my input',
    images,
  });
  const messages = await core.engines.messagesOf(canvas);
  expect(messages.get(kept.id)).toMatchObject({
    from: 'you',
    to: `agent:${agent}`,
    body: 'Keep my input',
  });
  expect(
    readOnDisk(profile, (disk) =>
      disk.prepare('SELECT id FROM message WHERE canvas_id = ? AND id = ?').get(canvas, kept.id),
    ),
  ).toEqual({ id: kept.id });
  await core.prepareShutdown('quit');
  await expect(
    channel(window, 'session:send', agent, { id: crypto.randomUUID(), text: 'Too late' }),
  ).rejects.toThrow('quitting');
  await expect(channel(window, 'session:unqueue', agent, kept.id)).rejects.toThrow('quitting');
  core.cancelShutdown();
  await channel(window, 'session:record', agent, { id: crypto.randomUUID(), text: '/mcp' });
  expect(messages.all().some((message) => message.body === '/mcp')).toBe(true);
  served.gone(7, true);
  expect(core.engines.canvas(canvas)?.state).toBe('executing');
});
it('records a view-handled session command durably without dispatching it', async () => {
  const { core, connect } = await app();
  const window = connect(7);
  const canvas = await created(window);
  const agent = await agentOn(window, 'codex.app-server');
  await channel(window, 'session:record', agent, { id: crypto.randomUUID(), text: '/mcp' });
  const recorded = (await core.engines.messagesOf(canvas))
    .all()
    .find((message) => message.body === '/mcp');
  if (!recorded) throw new Error('No command record');
  expect(recorded).toMatchObject({ from: 'you', to: `agent:${agent}`, state: 'replied' });
  expect(
    readOnDisk(profile, (disk) =>
      disk
        .prepare('SELECT id FROM message WHERE canvas_id = ? AND id = ?')
        .get(canvas, recorded.id),
    ),
  ).toEqual({ id: recorded.id });
  expect(core.engines.canvas(canvas)?.engine.sessions.of(agent).status).toBe('idle');
});
