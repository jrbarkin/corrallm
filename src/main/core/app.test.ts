import type { OpResult } from '../../shared/api/errors';
import type { RunCheckpoint } from '../../shared/run';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

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
  ...args: C extends 'run:save' ? [string, RunCheckpoint | null] : IpcArgs<C>
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

function events(window: WindowLink) {
  const heard: [GuiEvent, GuiEventArgs<GuiEvent>][] = [];
  window.on('event', (name, args) => {
    heard.push([name, args]);
  });
  return heard;
}

describe('the app’s core and window channels', () => {
  it.each(
    ['codex.app-server', 'codex.terminal', 'claude-code.sdk', 'claude-code.terminal'].flatMap(
      (connection) => ['wake', 'network'].map((trigger) => ({ connection, trigger })),
    ),
  )(
    'warns a silent $connection turn after $trigger and answers its Needs item without opening a core run',
    async ({ connection, trigger }) => {
      let interfaces: ReturnType<NonNullable<CoreConfig['watchdogNetwork']>> = {};
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
      const heard = events(window);
      await channel(window, 'session:start', 'a', { connection, model: null, mode: null });
      await channel(window, 'session:send', 'a', { id: 'm', text: 'Hello' });
      expect(core.engines.opened()).toEqual([]);
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
        interfaces = {
          en0: [
            {
              family: 'IPv4',
              address: '192.0.2.1',
              netmask: '255.255.255.0',
              internal: false,
              mac: '',
              cidr: '192.0.2.1/24',
            },
          ],
        };
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
        expect(heard).toContainEqual([
          'session:event',
          [
            'a',
            connection,
            expect.objectContaining({
              type: 'notice',
              level: 'warning',
              text: expect.stringContaining(
                trigger === 'network'
                  ? '2 minutes after the network changed'
                  : '2 minutes after waking',
              ) as unknown,
            }),
          ],
        ]);
      });
      expect(await core.call('needs', { canvas }, CALLERS.you)).toMatchObject({
        ok: true,
        value: {
          items: [expect.objectContaining({ id: 'stalled/a', agent: 'a' })],
        },
      });
      expect(interrupt).not.toHaveBeenCalled();
      expect(
        await core.call(
          'reply',
          { canvas, to: 'stalled/a', answer: { choice: 'interrupt' } },
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
    const a = events(seven);
    const b = events(eight);

    await channel(seven, 'session:start', 'a', {
      connection: 'codex.app-server',
      model: null,
      mode: 'auto',
    });
    await vi.waitFor(() => {
      expect(a).toContainEqual([
        'session:event',
        ['a', 'codex.app-server', expect.objectContaining({ type: 'started' })],
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
    await channel(seven, 'session:start', 'a', {
      connection: 'codex.terminal',
      model: null,
      mode: null,
    });
    const a = events(seven);
    const b = events(eight);
    await expect(seven.request('call', 'terminal.attach', { agent: 'a' })).resolves.toEqual({
      ok: true,
      value: { ok: true, value: { revs: {} } },
    });
    await vi.waitFor(() => {
      expect(a).toEqual([
        ['terminal', ['a', { type: 'screen', data: 'hello', cols: 80, rows: 24 }]],
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
    const heard = events(seven);
    await channel(seven, 'session:start', 'a', {
      connection: 'claude-code.terminal',
      model: null,
      mode: null,
    });
    await channel(seven, 'session:send', 'a', { id: crypto.randomUUID(), text: 'Hello' });
    await vi.waitFor(() => {
      expect(heard).toContainEqual([
        'session:event',
        [
          'a',
          'claude-code.terminal',
          expect.objectContaining({
            type: 'end',
            result: { status: 'failed', reason: 'usage-limit', message: 'Limit', resetsAt },
          }),
        ],
      ]);
    });
  });

  it('keeps the canvas across reload, closes its sessions, and forgets only a destroyed window', async () => {
    const fake = new FakeConnector({ adapter: 'codex' });
    const { core, connect, served } = await app({
      connectors: { 'codex.app-server': fake },
      environment: () => Promise.resolve({}),
    });
    const before = connect(7);
    const id = await created(before);
    await chooseProject(before);
    await channel(before, 'session:start', 'a', {
      connection: 'codex.app-server',
      model: null,
      mode: 'auto',
    });
    const session = fake.sessions[0];
    if (!session) throw new Error('no session');
    const close = vi.spyOn(session, 'close');
    served.gone(7);
    const after = connect(7);
    expect((await channel(after, 'run:get')).id).toBe(id);
    expect(close).toHaveBeenCalledOnce();
    expect(core.shown([7, 8])).toEqual([7]);
    served.gone(7, true);
    expect(core.shown([7, 8])).toEqual([]);
  });

  it('flushes the renderer’s journal, usage and conversation ids in the profile it owns', async () => {
    const { core, connect } = await app();
    const window = connect(7);
    const id = await created(window);
    await chooseProject(window);
    const run = await channel(window, 'run:get');
    const checkpoint = { version: 2, state: '{}', messages: '[]', updatedAt: 1 } as const;
    await channel(window, 'run:save', run.token, checkpoint);
    await channel(window, 'session:start', 'a', {
      connection: 'codex.app-server',
      model: null,
      mode: 'auto',
    });
    await call(window, 'usage.setRule', {
      backend: 'codex',
      rule: { window: 'weekly', percent: 80, action: 'ask' },
    });
    await core.flush();

    expect(journaledRun(profile, id)).toEqual(checkpoint);
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
    const { connect, host } = await app();
    const window = connect(7);
    expect(await window.request('channel', 'run:ready', ['request-1', null, 8])).toEqual({
      ok: false,
      error: { message: 'Expected a shutdown request and error (or null)' },
    });
    expect(await window.request('channel', 'run:ready', null as never)).toEqual({
      ok: false,
      error: { message: 'Expected channel arguments' },
    });
    expect(await window.request('channel', 'core:connect', [])).toEqual({
      ok: false,
      error: { message: 'corrallm’s window has no channel named core:connect.' },
    });
    expect(host.runReady).not.toHaveBeenCalled();
  });

  it('cannot save another window’s run by supplying its generation token', async () => {
    const { connect } = await app();
    const seven = connect(7);
    const eight = connect(8);
    await created(seven);
    await created(eight);
    const other = await channel(eight, 'run:get');
    expect(await seven.request('channel', 'run:save', [other.token, null])).toEqual({
      ok: false,
      error: { message: 'This run belongs to an earlier canvas' },
    });
    expect((await channel(eight, 'run:get')).token).toBe(other.token);
  });

  it('acknowledges main’s freeze/save request through the core with the port’s window id', async () => {
    const { host, connect } = await app();
    const window = connect(7);
    await channel(window, 'run:ready', 'request-1', null);
    expect(host.runReady).toHaveBeenCalledExactlyOnceWith(7, 'request-1', null);
  });
});

describe('the canvas’s document, which the core keeps', () => {
  const checkpoint = { version: 2, state: '{}', messages: '[]', updatedAt: 1 } as const;
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
    const { token } = await channel(window, 'run:get');
    await channel(window, 'run:save', token, checkpoint);
    const lead = await agentIn(window, id, 'Lead');
    dialogs.save = fileIn('team.corral');
    expect(await call(window, 'canvas.saveAs', { canvas: id })).toMatchObject({
      name: 'team.corral',
    });
    await call(window, 'canvas.rename', { canvas: id, node: lead, label: 'Head' });

    const restarted = await restart();
    const restored = restarted.connect(7);
    const context = await channel(restored, 'run:get');
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

    expect(context).toMatchObject({ id, checkpoint });
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
    const restored = (await channel(window, 'run:get')).id;
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
    const before = await channel(window, 'run:get');
    await channel(window, 'run:save', before.token, checkpoint);
    const lead = await agentIn(window, id, 'Lead');
    dialogs.save = fileIn('kept.corral');
    await call(window, 'canvas.saveAs', { canvas: id });
    await writeFile(fileIn('notes.corral'), 'Remember the milk');
    dialogs.open = fileIn('notes.corral');

    await expect(call(window, 'canvas.open', {})).rejects.toThrow(
      'notes.corral: This is not a corrallm canvas',
    );

    expect(await channel(window, 'run:get')).toMatchObject({ id, token: before.token });
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
    await expect(channel(window, 'run:get')).resolves.toMatchObject({ id: draft });
  });

  it('journals no document revision and refuses an earlier canvas’s token', async () => {
    const { connect } = await app();
    const window = connect(7);
    const id = await created(window);
    const { token } = await channel(window, 'run:get');
    const revisions = () =>
      readOnDisk(profile, (disk) =>
        disk.prepare('SELECT rev, op FROM revision WHERE canvas_id = ?').all(id),
      );
    await channel(window, 'run:save', token, checkpoint);
    await channel(window, 'run:save', token, { ...checkpoint, updatedAt: 2 });
    expect(revisions()).toEqual([]);

    await created(window);
    await expect(channel(window, 'run:save', token, checkpoint)).rejects.toThrow(
      'This run belongs to an earlier canvas',
    );
    expect(revisions()).toEqual([]);
  });
});
