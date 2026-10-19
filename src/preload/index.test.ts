import { MessageChannel } from 'node:worker_threads';
import type { MessagePort } from 'node:worker_threads';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OpResult } from '../shared/api/errors';
import { GUI_OPS } from '../shared/api/surface';
import { guiFunction } from '../shared/gui-link';
import type { CoreGuiSide, GuiSide } from '../shared/gui-link';
import { API_CHANNELS, API_EVENTS } from '../shared/ipc';
import type { AppApi } from '../shared/ipc';
import { CoreLink } from '../shared/link';
import type { SessionEvent } from '../shared/session';

type Listener = (event: unknown, ...args: unknown[]) => void;
const { exposeInMainWorld, invoke, on, removeListener, getPathForFile } = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn<(key: string, api: unknown) => void>(),
  invoke: vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>(),
  on: vi.fn<(channel: string, listener: Listener) => void>(),
  removeListener: vi.fn<(channel: string, listener: Listener) => void>(),
  getPathForFile: vi.fn<(file: File) => string>(),
}));
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld },
  ipcRenderer: { invoke, on, removeListener },
  webUtils: { getPathForFile },
}));

// Each test loads the preload afresh: Vitest clears mock calls between tests.
beforeEach(() => {
  vi.resetModules();
  invoke.mockReset();
  invoke.mockResolvedValue(null);
});

const ports: MessagePort[] = [];
const channel = vi.fn<(name: string, ...args: unknown[]) => Promise<unknown>>();
let remote: CoreLink<CoreGuiSide, GuiSide>;
beforeEach(() => {
  channel.mockReset();
  channel.mockResolvedValue(null);
});
afterEach(() => {
  for (const port of ports.splice(0)) port.close();
  vi.useRealTimers();
});

/** The listener the preload added for `channel`. */
function listenerOn(channel: string): Listener {
  const listener = on.mock.calls.find(([name]) => name === channel)?.[1];
  if (!listener) throw new Error(`not listening for ${channel}`);
  return listener;
}

/**
 * Main posts the preload a port to a core answering each call with `answer` (as core/gui.ts does):
 * the calls it heard.
 */
function postPort(
  answer: (op: string, args: unknown) => OpResult<unknown> | Promise<OpResult<unknown>>,
) {
  const { port1, port2 } = new MessageChannel();
  ports.push(port1, port2);
  const heard: [op: string, args: unknown][] = [];
  remote = new CoreLink<CoreGuiSide, GuiSide>(
    {
      post: (message) => {
        port2.postMessage(message);
      },
      start: (receive) => {
        port2.on('message', receive);
      },
    },
    {
      call: (op, args) => {
        heard.push([op, args]);
        return answer(op, args);
      },
      channel: (name, args) => channel(name, ...args),
    },
  );
  listenerOn('core:port')({ ports: [port1], sender: 'the ipcRenderer' }, { epoch: 1 });
  return heard;
}

/** The core's end closes, as it does when the core stops before its replacement is ready. */
async function closePort(): Promise<void> {
  const local = ports.at(-2);
  const remote = ports.at(-1);
  if (!local || !remote) throw new Error('no port to close');
  const closed = new Promise<void>((resolve) => local.once('close', resolve));
  remote.close();
  await closed;
}

/** What every GUI op answers in these tests: corrallm's name and version. */
const INFO = { name: 'corrallm', version: '0.1.0' };
const answerInfo = () => ({ ok: true, value: INFO }) as const;
const UNAVAILABLE = {
  ok: false,
  error: { code: 'unavailable', sentence: 'corrallm’s core isn’t answering yet.' },
};

/** The api the preload exposed. */
async function exposed(): Promise<AppApi> {
  await import('./index');
  expect(exposeInMainWorld).toHaveBeenCalledOnce();
  const [key, api] = exposeInMainWorld.mock.calls[0] ?? [];
  expect(key).toBe('api');
  return api as AppApi;
}

describe('the window’s port to the core', () => {
  it('is asked of main as the preload loads, and kept from the page', async () => {
    const api = await exposed();

    expect(invoke).toHaveBeenCalledExactlyOnceWith('core:connect');
    listenerOn('core:port');
    // Only functions: a function per channel and event, and one per GUI operation, never the
    // port, ipcRenderer, a function that takes a channel or an operation, or an event object.
    expect(Object.keys(api).sort()).toEqual(
      [
        ...Object.keys(API_CHANNELS),
        ...Object.keys(API_EVENTS),
        ...GUI_OPS.map((op) => guiFunction(op)),
      ].sort(),
    );
    expect(Object.values(api).every((value) => typeof value === 'function')).toBe(true);
    expect(api).toHaveProperty('appInfo');
  });

  it('calls each GUI operation over the port, passing its whole result through the bridge', async () => {
    const api = await exposed();
    const heard = postPort(answerInfo);

    await expect(api.appInfo()).resolves.toEqual(answerInfo());
    await expect(api.appInfo({})).resolves.toEqual(answerInfo());

    expect(heard).toEqual([
      ['app.info', undefined],
      ['app.info', {}],
    ]);
  });

  it('holds calls made before the port comes until it does', async () => {
    const api = await exposed();
    vi.useFakeTimers();

    const info = api.appInfo();
    await vi.advanceTimersByTimeAsync(9999);
    postPort(answerInfo);

    await expect(info).resolves.toEqual(answerInfo());
    expect(vi.getTimerCount()).toBe(0);
  });

  it('passes an operation’s error code and sentence through the bridge as plain data', async () => {
    const api = await exposed();
    postPort(() => ({
      ok: false,
      error: { code: 'refused', sentence: 'This operation was refused.' },
    }));

    await expect(api.appInfo()).resolves.toEqual({
      ok: false,
      error: { code: 'refused', sentence: 'This operation was refused.' },
    });
  });

  it('times out a queued write after 10 seconds and never sends it on a late port', async () => {
    const api = await exposed();
    vi.useFakeTimers();
    const settled = vi.fn();
    void api.usageSetRule({ backend: 'codex', rule: null }).then(settled);

    await vi.advanceTimersByTimeAsync(9999);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toHaveBeenCalledExactlyOnceWith(UNAVAILABLE);

    const heard = postPort(answerInfo);
    await expect(api.appInfo()).resolves.toEqual(answerInfo());
    expect(heard).toEqual([['app.info', undefined]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives each queued call its own 10 seconds to get a port', async () => {
    const api = await exposed();
    vi.useFakeTimers();
    const first = vi.fn();
    void api.appInfo().then(first);
    await vi.advanceTimersByTimeAsync(5000);
    const second = api.appInfo();

    await vi.advanceTimersByTimeAsync(5000);
    expect(first).toHaveBeenCalledExactlyOnceWith(UNAVAILABLE);
    const heard = postPort(answerInfo);
    await expect(second).resolves.toEqual(answerInfo());
    expect(heard).toHaveLength(1);
  });

  it('holds calls while the core restarts, then takes the replacement port', async () => {
    const api = await exposed();
    postPort(answerInfo);
    await expect(api.appInfo()).resolves.toEqual(answerInfo());
    await closePort();
    vi.useFakeTimers();

    const pending = api.appInfo();
    await vi.advanceTimersByTimeAsync(9999);
    const heard = postPort(answerInfo);
    await expect(pending).resolves.toEqual(answerInfo());
    expect(heard).toEqual([['app.info', undefined]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out after 10 seconds when no replacement port arrives', async () => {
    const api = await exposed();
    postPort(answerInfo);
    await closePort();
    vi.useFakeTimers();
    const settled = vi.fn();
    void api.appInfo().then(settled);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(settled).toHaveBeenCalledExactlyOnceWith(UNAVAILABLE);
  });

  it('passes a link handler’s failure through as an unavailable result', async () => {
    const api = await exposed();
    postPort(() => {
      throw new Error('The core could not handle the call.');
    });
    await expect(api.appInfo()).resolves.toEqual({
      ok: false,
      error: { code: 'unavailable', sentence: 'The core could not handle the call.' },
    });
  });

  it('takes a new port in place of the one before, failing what waited on the old one', async () => {
    const api = await exposed();
    postPort(() => new Promise<never>(() => undefined));
    const stranded = api.appInfo();

    const heard = postPort(answerInfo);

    await expect(stranded).resolves.toEqual({
      ok: false,
      error: { code: 'unavailable', sentence: 'corrallm’s core restarted.' },
    });
    await expect(api.appInfo()).resolves.toEqual(answerInfo());
    expect(heard).toHaveLength(1);
  });

  it('passes main’s refusal of the port through as an unavailable result', async () => {
    invoke.mockRejectedValue(new Error('Rejected core:connect: untrusted sender'));
    const api = await exposed();

    await expect(api.appInfo()).resolves.toEqual({
      ok: false,
      error: { code: 'unavailable', sentence: 'Rejected core:connect: untrusted sender' },
    });
  });
});

describe('preload', () => {
  afterEach(() => {
    expect(invoke.mock.calls.map(([name]) => name)).toEqual(['core:connect']);
  });

  it('calls the catalog and canvas channels with their arguments', async () => {
    const api = await exposed();
    postPort(answerInfo);

    // The catalog, which the renderer loads before it mounts.
    const catalog = { adapters: [], usageBackends: [] };
    channel.mockResolvedValue(catalog);
    await expect(api.catalog()).resolves.toEqual(catalog);
    expect(channel).toHaveBeenLastCalledWith('catalog:get');

    // The canvas file functions channel their channels with their arguments.
    await api.openCanvas();
    expect(channel).toHaveBeenLastCalledWith('canvas:open');
    await api.saveCanvas('{}', true);
    expect(channel).toHaveBeenLastCalledWith('canvas:save', '{}', true);
    await api.forgetCanvas();
    expect(channel).toHaveBeenLastCalledWith('canvas:forget');
    await api.chooseProject();
    expect(channel).toHaveBeenLastCalledWith('project:choose');
    await api.findProjectFiles('src/ma');
    expect(channel).toHaveBeenLastCalledWith('project:files', 'src/ma');
  });

  it('calls the session channels with their arguments', async () => {
    const api = await exposed();
    postPort(answerInfo);
    channel.mockResolvedValue(null);
    const options = { connection: 'claude-code.sdk', model: null, mode: 'manual' } as const;
    await api.startSession('a', options);
    expect(channel).toHaveBeenLastCalledWith('session:start', 'a', options);
    await api.sendToSession('a', { id: 'm', text: 'Hi' });
    expect(channel).toHaveBeenLastCalledWith('session:send', 'a', { id: 'm', text: 'Hi' });
    const image = { mediaType: 'image/png', data: 'iVBORw0KGgo=' } as const;
    await api.sendToSession('a', { id: 'm2', text: '', images: [image] });
    expect(channel).toHaveBeenLastCalledWith('session:send', 'a', {
      id: 'm2',
      text: '',
      images: [image],
    });
    await api.answerSession('a', 'p', { kind: 'permission', answer: 'deny' });
    expect(channel).toHaveBeenLastCalledWith('session:answer', 'a', 'p', {
      kind: 'permission',
      answer: 'deny',
    });
    await api.interruptSession('a');
    expect(channel).toHaveBeenLastCalledWith('session:interrupt', 'a');
    await api.setSessionMode('a', 'plan');
    expect(channel).toHaveBeenLastCalledWith('session:mode', 'a', 'plan');
    await api.setSessionModel('a', 'opus');
    expect(channel).toHaveBeenLastCalledWith('session:model', 'a', 'opus');
    await api.setSessionEffort('a', 'high');
    expect(channel).toHaveBeenLastCalledWith('session:effort', 'a', 'high');
    await api.stopSessionTask('a', 'b1');
    expect(channel).toHaveBeenLastCalledWith('session:stopTask', 'a', 'b1');
    await api.closeSession('a');
    expect(channel).toHaveBeenLastCalledWith('session:close', 'a');
    await api.freshSession('a', 'codex');
    expect(channel).toHaveBeenLastCalledWith('session:fresh', 'a', 'codex');
    await api.listSessions('a');
    expect(channel).toHaveBeenLastCalledWith('session:list', 'a');
    await api.previewRewind('a', 'm');
    expect(channel).toHaveBeenLastCalledWith('session:rewind-preview', 'a', 'm');
    await api.rewindSession('a', 'm', 'both');
    expect(channel).toHaveBeenLastCalledWith('session:rewind', 'a', 'm', 'both');
    await api.mcpServers('a');
    expect(channel).toHaveBeenLastCalledWith('session:mcp', 'a');
    await api.settingsOptions('claude-code');
    expect(channel).toHaveBeenLastCalledWith('session:options', 'claude-code');
    await api.changeMcpServer('a', 'github', 'disable');
    expect(channel).toHaveBeenLastCalledWith('session:mcp-change', 'a', 'github', 'disable');
    await api.resumeSession('a', '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e11');
    expect(channel).toHaveBeenLastCalledWith(
      'session:resume',
      'a',
      '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e11',
    );
  });

  it('passes session events on without Electron’s event object, until told to stop', async () => {
    const api = await exposed();
    postPort(answerInfo);
    const heard = vi.fn<Parameters<AppApi['onSessionEvent']>[0]>();
    const stop = api.onSessionEvent(heard);

    const event: SessionEvent = { type: 'status', status: 'working' };
    remote.emit('event', 'session:event', ['a', 'claude-code.sdk', event]);
    await vi.waitFor(() => {
      expect(heard).toHaveBeenCalledOnce();
    });
    expect(heard).toHaveBeenCalledWith('a', 'claude-code.sdk', event);

    stop();
    remote.emit('event', 'session:event', ['a', 'claude-code.sdk', event]);
    await api.getUsage();
    expect(heard).toHaveBeenCalledOnce();
  });

  it('calls the terminal channels with their arguments', async () => {
    const api = await exposed();
    postPort(answerInfo);
    channel.mockResolvedValue(null);
    await api.attachTerminal('a');
    expect(channel).toHaveBeenLastCalledWith('terminal:attach', 'a');
    await api.writeTerminal('a', 'ls\r');
    expect(channel).toHaveBeenLastCalledWith('terminal:input', 'a', 'ls\r');
    await api.resizeTerminal('a', 120, 40);
    expect(channel).toHaveBeenLastCalledWith('terminal:resize', 'a', 120, 40);
    await api.detachTerminal('a');
    expect(channel).toHaveBeenLastCalledWith('terminal:detach', 'a');
  });

  it('calls link.open and link.reveal over the generated operation bridge, with only the URL', async () => {
    const api = await exposed();
    const heard = postPort(answerInfo);
    await expect(api.linkOpen({ url: 'https://docs.example.com/a' })).resolves.toEqual(
      answerInfo(),
    );
    await expect(api.linkReveal({ url: 'file:///work/app/notes.txt' })).resolves.toEqual(
      answerInfo(),
    );
    expect(heard).toEqual([
      ['link.open', { url: 'https://docs.example.com/a' }],
      ['link.reveal', { url: 'file:///work/app/notes.txt' }],
    ]);
    expect(channel).not.toHaveBeenCalled();
    expect(api).not.toHaveProperty('openLink');
    expect(api).not.toHaveProperty('revealFile');
  });

  it('calls window.get without accepting a window id from the page', async () => {
    const api = await exposed();
    const heard = postPort(answerInfo);
    await api.windowGet();
    expect(heard).toEqual([['window.get', undefined]]);
    expect(channel).not.toHaveBeenCalled();
  });

  it('sends the paths of files dropped on a terminal, as the files say, never the page', async () => {
    const api = await exposed();
    postPort(answerInfo);
    channel.mockResolvedValue(null);
    const shot = new File(['png'], 'Screen Shot.png');
    const made = new File(['made by the page'], 'made.txt');
    getPathForFile.mockImplementation((file) => (file === shot ? '/Users/me/Screen Shot.png' : ''));
    await api.dropOnTerminal('a', [shot, made]);
    expect(channel).toHaveBeenLastCalledWith('terminal:drop', 'a', ['/Users/me/Screen Shot.png']);
    // Files that are not on disk (made by the page) name no path: nothing is sent.
    channel.mockClear();
    await expect(api.dropOnTerminal('a', [made])).resolves.toBeNull();
    expect(channel).not.toHaveBeenCalled();
  });

  it('passes terminal events on without Electron’s event object, until told to stop', async () => {
    const api = await exposed();
    postPort(answerInfo);
    const heard = vi.fn<Parameters<AppApi['onTerminalEvent']>[0]>();
    const stop = api.onTerminalEvent(heard);

    remote.emit('event', 'terminal:event', ['a', { type: 'output', data: 'hi' }]);
    await vi.waitFor(() => {
      expect(heard).toHaveBeenCalledOnce();
    });
    expect(heard).toHaveBeenCalledWith('a', { type: 'output', data: 'hi' });

    stop();
    remote.emit('event', 'terminal:event', ['a', { type: 'output', data: 'hi' }]);
    await api.getUsage();
    expect(heard).toHaveBeenCalledOnce();
  });

  it('asks main which agents the user has', async () => {
    const api = await exposed();
    postPort(answerInfo);
    channel.mockResolvedValue({ 'claude-code': true, codex: true });
    await expect(api.installedClis()).resolves.toEqual({ 'claude-code': true, codex: true });
    expect(channel).toHaveBeenLastCalledWith('session:clis');
  });

  it('calls the usage channels with their arguments', async () => {
    const api = await exposed();
    postPort(answerInfo);
    channel.mockResolvedValue({ readings: [], rules: {} });
    await expect(api.getUsage()).resolves.toEqual({ readings: [], rules: {} });
    expect(channel).toHaveBeenLastCalledWith('usage:get');
    const rule = { window: 'weekly', percent: 90, action: 'warn' } as const;
    await api.setUsageRule('claude-code', rule);
    expect(channel).toHaveBeenLastCalledWith('usage:rule', 'claude-code', rule);
    const windows = { fiveHour: { usedPercent: 85, resetsAt: null } };
    await api.simulateUsage('claude-code', windows);
    expect(channel).toHaveBeenLastCalledWith('usage:simulate', 'claude-code', windows);
  });

  it('passes usage changes on without Electron’s event object, until told to stop', async () => {
    const api = await exposed();
    postPort(answerInfo);
    const heard = vi.fn<Parameters<AppApi['onUsageChanged']>[0]>();
    const stop = api.onUsageChanged(heard);

    const state = { readings: [], rules: {} };
    remote.emit('event', 'usage:changed', [state]);
    await vi.waitFor(() => {
      expect(heard).toHaveBeenCalledOnce();
    });
    expect(heard).toHaveBeenCalledWith(state);

    stop();
    remote.emit('event', 'usage:changed', [state]);
    await api.getUsage();
    expect(heard).toHaveBeenCalledOnce();
  });
});

describe('run persistence preload', () => {
  it('exposes only typed get/save/ready calls and strips the stopping event object', async () => {
    const api = await exposed();
    postPort(answerInfo);
    const checkpoint = {
      version: 2,
      workflow: '{}',
      state: '{}',
      messages: '[]',
      updatedAt: 1,
    } as const;
    await api.getRun();
    expect(channel).toHaveBeenLastCalledWith('run:get');
    await api.saveRun('token', checkpoint);
    expect(channel).toHaveBeenLastCalledWith('run:save', 'token', checkpoint);
    await api.runReady('request', null);
    expect(channel).toHaveBeenLastCalledWith('run:ready', 'request', null);
    const listener = vi.fn();
    const stop = api.onRunStopping(listener);
    const call = on.mock.calls.find(([channel]) => channel === 'run:stopping');
    call?.[1]({}, 'request');
    expect(listener).toHaveBeenCalledWith('request');
    stop();
    expect(removeListener).toHaveBeenCalledWith('run:stopping', call?.[1]);
  });
});

describe('channels waiting for the core', () => {
  it('queues a channel until the port comes, and preserves a handler’s error message', async () => {
    const api = await exposed();
    const pending = api.openCanvas();
    channel.mockRejectedValue(new Error('The file could not open.'));
    postPort(answerInfo);
    await expect(pending).rejects.toThrow('The file could not open.');
    expect(channel).toHaveBeenCalledExactlyOnceWith('canvas:open');
    expect(invoke).toHaveBeenCalledExactlyOnceWith('core:connect');
  });

  it('expires a queued channel after 10 seconds without replaying it on a late port', async () => {
    const api = await exposed();
    vi.useFakeTimers();
    const failed = expect(api.forgetCanvas()).rejects.toThrow(
      'corrallm’s core isn’t answering yet.',
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await failed;
    postPort(answerInfo);
    await api.appInfo();
    expect(channel).not.toHaveBeenCalled();
  });

  it('keeps event subscriptions across replacement ports', async () => {
    const api = await exposed();
    const heard = vi.fn();
    const stop = api.onUsageChanged(heard);
    postPort(answerInfo);
    remote.emit('event', 'usage:changed', [{ readings: [], rules: {} }]);
    await vi.waitFor(() => {
      expect(heard).toHaveBeenCalledOnce();
    });
    await closePort();
    postPort(answerInfo);
    remote.emit('event', 'usage:changed', [{ readings: [], rules: {} }]);
    await vi.waitFor(() => {
      expect(heard).toHaveBeenCalledTimes(2);
    });
    stop();
  });
});
