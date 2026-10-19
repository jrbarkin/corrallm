import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CoreGuiSide, GuiSide } from '../../shared/gui-link';
import type { CoreChannel, CoreEvent, IpcArgs, IpcEventArgs, IpcResult } from '../../shared/ipc';
import type { CoreLink } from '../../shared/link';
import type { TerminalEvent } from '../../shared/terminal';
import { FakeConnector } from '../sessions/fake';
import { createCore } from './core';
import type { Core, CoreConfig } from './core';
import { WindowPorts } from './gui';
import { mintTrustedPath } from './host';
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
  for (const close of closing.splice(0)) close();
  await core?.close();
  core = undefined;
  vi.unstubAllEnvs();
  await rm(profile, { recursive: true, force: true });
});

async function app(sessions?: CoreConfig['sessions']) {
  const host = {
    ...NO_DESKTOP,
    pickFolder: vi.fn(() => Promise.resolve(mintTrustedPath(folder))),
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
  ...args: IpcArgs<C>
): Promise<IpcResult<C>> {
  const answer = await window.request('channel', name, args);
  if (!answer.ok) throw new Error(answer.error.message);
  return answer.value as IpcResult<C>;
}

function events(window: WindowLink) {
  const heard: [CoreEvent, IpcEventArgs<CoreEvent>][] = [];
  window.on('event', (name, args) => {
    heard.push([name, args]);
  });
  return heard;
}

describe('the app’s core and window channels', () => {
  it('shares usage between operations and channels, broadcasting changes to every window', async () => {
    const { core, connect } = await app();
    const seven = connect(7);
    const eight = connect(8);
    const a = events(seven);
    const b = events(eight);
    const rule = { window: 'weekly', percent: 80, action: 'ask' };

    await expect(
      seven.request('call', 'usage.setRule', { backend: 'codex', rule }),
    ).resolves.toEqual({
      ok: true,
      value: { ok: true, value: {} },
    });
    const state = { readings: [], rules: { codex: rule } };
    expect(await channel(eight, 'usage:get')).toEqual(state);
    await vi.waitFor(() => {
      expect(a).toEqual([['usage:changed', [state]]]);
      expect(b).toEqual(a);
    });
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
    await channel(seven, 'terminal:attach', 'a');
    await vi.waitFor(() => {
      expect(a).toEqual([
        ['terminal:event', ['a', { type: 'screen', data: 'hello', cols: 80, rows: 24 }]],
      ]);
    });
    await channel(eight, 'usage:get');
    expect(b).toEqual([]);
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
    const checkpoint = {
      version: 2,
      workflow: '{}',
      state: '{}',
      messages: '[]',
      updatedAt: 1,
    } as const;
    await channel(window, 'run:save', run.token, checkpoint);
    await channel(window, 'session:start', 'a', {
      connection: 'codex.app-server',
      model: null,
      mode: 'auto',
    });
    await channel(window, 'usage:rule', 'codex', { window: 'weekly', percent: 80, action: 'ask' });
    await core.flush();

    expect(
      JSON.parse(await readFile(path.join(profile, 'runs', id, 'record.json'), 'utf8')),
    ).toMatchObject({ checkpoint });
    expect(JSON.parse(await readFile(path.join(profile, 'usage.json'), 'utf8'))).toMatchObject({
      rules: { codex: { percent: 80 } },
    });
    expect(await readFile(path.join(profile, 'canvases.json'), 'utf8')).toContain('codex');
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
