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
  vi.stubEnv('CORRALLM_CLAUDE_PATH', path.join(profile, 'no-claude'));
  vi.stubEnv('CORRALLM_CODEX_PATH', path.join(profile, 'no-codex'));
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

async function app(sessions?: CoreConfig['sessions']) {
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
  ...args: C extends 'run:save'
    ? [string, RunCheckpoint | null]
    : C extends 'canvas:save'
      ? [string, boolean]
      : IpcArgs<C>
): Promise<C extends 'canvas:save' ? string | null : IpcResult<C>> {
  if (name === 'canvas:save') {
    const own = await window.request('call', 'window.get', {});
    if (!own.ok || !own.value.ok) throw new Error('No window canvas');
    const state = await window.request('call', 'canvas.get', {
      canvas: (own.value.value as { canvas: string }).canvas,
    });
    if (!state.ok || !state.value.ok) throw new Error('No canvas');
    (args as unknown[]).push((state.value.value as { rev: number }).rev);
  }
  const answer = await window.request('channel', name, args);
  if (!answer.ok) throw new Error(answer.error.message);
  if (name === 'canvas:save') {
    const result = answer.value as
      | { ok: true; value: { name?: string | null; rev: number } }
      | { ok: false; error: { sentence: string } };
    if (!result.ok) throw new Error(result.error.sentence);
    return (result.value.name ?? null) as C extends 'canvas:save' ? string | null : IpcResult<C>;
  }
  return answer.value as C extends 'canvas:save' ? string | null : IpcResult<C>;
}

function events(window: WindowLink) {
  const heard: [GuiEvent, GuiEventArgs<GuiEvent>][] = [];
  window.on('event', (name, args) => {
    heard.push([name, args]);
  });
  return heard;
}

describe('the app’s core and window channels', () => {
  it('shares usage between operations and the remaining channels', async () => {
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
    expect(await channel(eight, 'usage:get')).toEqual(state);
    await channel(eight, 'usage:rule', 'codex', null);
    await expect(core.call('usage.get', {}, CALLERS.you)).resolves.toEqual({
      ok: true,
      value: { readings: [], rules: {} },
    });
  });

  it('runs fake sessions and options in the core, sending session events only to their canvas’s window', async () => {
    const { connect, host } = await app();
    const seven = connect(7);
    const eight = connect(8);
    const own = await channel(seven, 'canvas:forget');
    const other = await channel(eight, 'canvas:forget');
    expect(own).not.toBe(other);
    await channel(seven, 'project:choose');
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
    await channel(eight, 'usage:get');
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
    await channel(seven, 'canvas:forget');
    await channel(eight, 'canvas:forget');
    await channel(seven, 'project:choose');
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
    await channel(eight, 'usage:get');
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
    await channel(seven, 'canvas:forget');
    await channel(seven, 'project:choose');
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
    const id = await channel(before, 'canvas:forget');
    await channel(before, 'project:choose');
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
    const id = await channel(window, 'canvas:forget');
    await channel(window, 'project:choose');
    const run = await channel(window, 'run:get');
    const checkpoint = { version: 2, state: '{}', messages: '[]', updatedAt: 1 } as const;
    await channel(window, 'run:save', run.token, checkpoint);
    await channel(window, 'session:start', 'a', {
      connection: 'codex.app-server',
      model: null,
      mode: 'auto',
    });
    await channel(window, 'usage:rule', 'codex', { window: 'weekly', percent: 80, action: 'ask' });
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

  it('refuses a page-supplied window or malformed channel arguments before any dialog', async () => {
    const { connect, host } = await app();
    const window = connect(7);
    expect(await window.request('channel', 'project:choose', [8])).toEqual({
      ok: false,
      error: { message: 'Expected no arguments' },
    });
    expect(await window.request('channel', 'project:choose', null as never)).toEqual({
      ok: false,
      error: { message: 'Expected channel arguments' },
    });
    expect(await window.request('channel', 'core:connect', [])).toEqual({
      ok: false,
      error: { message: 'corrallm’s window has no channel named core:connect.' },
    });
    expect(host.pickFolder).not.toHaveBeenCalled();
  });

  it('cannot save another window’s run by supplying its generation token', async () => {
    const { connect } = await app();
    const seven = connect(7);
    const eight = connect(8);
    await channel(seven, 'canvas:forget');
    await channel(eight, 'canvas:forget');
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
  /** A canvas of one agent, `label`, as the renderer has it: its file's text. */
  const canvasText = (id: CanvasId, label = 'Lead', arrange = false) =>
    toFile({
      id,
      arrange,
      nodes: [{ id: 'lead', type: 'agent', position: { x: 0, y: 0 }, data: { label } }],
      links: [],
    });
  const fileIn = (name: string) => path.join(profile, name);
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
    const id = await channel(window, 'canvas:forget');
    const { token } = await channel(window, 'run:get');
    await channel(window, 'run:save', token, checkpoint);
    dialogs.save = fileIn('team.corral');
    await expect(channel(window, 'canvas:save', canvasText(id), false)).resolves.toBe(
      'team.corral',
    );
    await window.request('call', 'canvas.rename', {
      canvas: id,
      node: 'lead',
      label: 'Head',
      request: crypto.randomUUID(),
    });

    const restarted = await restart();
    const restored = restarted.connect(7);
    const context = await channel(restored, 'run:get');
    expect(await restored.request('call', 'canvas.get', { canvas: id })).toMatchObject({
      ok: true,
      value: {
        ok: true,
        value: {
          // Its file's name, and its edit since that file was saved.
          name: 'team.corral',
          edited: true,
          nodes: expect.arrayContaining([
            expect.objectContaining({
              data: expect.objectContaining({ label: 'Head' }) as unknown,
            }),
          ]) as unknown,
        },
      },
    });

    expect(context).toMatchObject({
      id,
      checkpoint,
    });
    expect(await readFile(fileIn('team.corral'), 'utf8')).toBe(canvasText(id));
  });

  it('saves each canvas as the core has it, under its own id: the restored one, a draft, one opened', async () => {
    const { connect } = await app();
    const window = connect(7);
    const saves = async (id: CanvasId, name: string, text = canvasText(id)) => {
      dialogs.save = fileIn(name);
      await expect(channel(window, 'canvas:save', text, false)).resolves.toBe(name);
      expect(canvasIdOf(await readFile(fileIn(name), 'utf8'))).toBe(id);
    };
    const restored = (await channel(window, 'run:get')).id;
    await saves(restored, 'restored.corral');
    // Its arrangement too, a saved setting: on, it is written.
    const draft = await channel(window, 'canvas:forget');
    await saves(draft, 'draft.corral', canvasText(draft, 'Lead', true));
    expect(JSON.parse(await readFile(fileIn('draft.corral'), 'utf8'))).toHaveProperty(
      'arrange',
      true,
    );
    const opened = newCanvasId();
    await writeFile(fileIn('opened.corral'), canvasText(opened, 'Opened'));
    dialogs.open = fileIn('opened.corral');
    await expect(channel(window, 'canvas:open')).resolves.toMatchObject({
      id: opened,
      name: 'opened.corral',
      text: canvasText(opened, 'Opened'),
    });
    await channel(window, 'canvas:save', canvasText(opened, 'Opened'), false);
    expect(await readFile(fileIn('opened.corral'), 'utf8')).toBe(canvasText(opened, 'Opened'));

    // Text of another canvas is never saved as this one's.
    await expect(channel(window, 'canvas:save', canvasText(draft), false)).rejects.toThrow(
      'This canvas’s text is another canvas’s.',
    );
    expect(await readFile(fileIn('opened.corral'), 'utf8')).toBe(canvasText(opened, 'Opened'));
  });

  it('reads back on open what a saved arrangement says', async () => {
    const id = newCanvasId();
    await writeFile(fileIn('arranged.corral'), canvasText(id, 'Lead', true));
    const { connect } = await app();
    const window = connect(7);
    dialogs.open = fileIn('arranged.corral');
    await channel(window, 'canvas:open');
    expect(await window.request('call', 'canvas.get', { canvas: id })).toMatchObject({
      ok: true,
      value: { ok: true, value: { arrange: true } },
    });
  });

  it('refuses a file that isn’t a canvas, keeping the canvas shown, never taking the file as its', async () => {
    const { connect } = await app();
    const window = connect(7);
    const id = await channel(window, 'canvas:forget');
    const before = await channel(window, 'run:get');
    await channel(window, 'run:save', before.token, checkpoint);
    dialogs.save = fileIn('kept.corral');
    await channel(window, 'canvas:save', canvasText(id), false);
    await writeFile(fileIn('notes.corral'), 'Remember the milk');
    dialogs.open = fileIn('notes.corral');

    await expect(channel(window, 'canvas:open')).rejects.toThrow(
      'notes.corral: This is not a corrallm canvas',
    );

    expect(await channel(window, 'run:get')).toMatchObject({ id, token: before.token });
    await channel(window, 'canvas:save', canvasText(id, 'Head'), false);
    expect(await readFile(fileIn('kept.corral'), 'utf8')).toBe(canvasText(id, 'Head'));
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

    const draft = await channel(window, 'canvas:forget');
    await expect(channel(window, 'run:get')).resolves.toMatchObject({ id: draft });
  });

  it('journals no document revision and refuses an earlier canvas’s token', async () => {
    const { connect } = await app();
    const window = connect(7);
    const id = await channel(window, 'canvas:forget');
    const { token } = await channel(window, 'run:get');
    const revisions = () =>
      readOnDisk(profile, (disk) =>
        disk.prepare('SELECT rev, op FROM revision WHERE canvas_id = ?').all(id),
      );
    await channel(window, 'run:save', token, checkpoint);
    await channel(window, 'run:save', token, { ...checkpoint, updatedAt: 2 });
    expect(revisions()).toEqual([]);

    await channel(window, 'canvas:forget');
    await expect(channel(window, 'run:save', token, checkpoint)).rejects.toThrow(
      'This run belongs to an earlier canvas',
    );
    expect(revisions()).toEqual([]);
  });
});
