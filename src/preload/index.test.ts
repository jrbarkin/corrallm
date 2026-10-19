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
afterEach(() => {
  for (const port of ports.splice(0)) port.close();
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
function postPort(answer: (op: string, args: unknown) => OpResult<unknown> | Promise<never>) {
  const { port1, port2 } = new MessageChannel();
  ports.push(port1, port2);
  const heard: [op: string, args: unknown][] = [];
  new CoreLink<CoreGuiSide, GuiSide>(
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
      channel: () => null,
    },
  );
  listenerOn('core:port')({ ports: [port1], sender: 'the ipcRenderer' }, { epoch: 1 });
  return heard;
}

/** What every GUI op answers in these tests: corrallm's name and version. */
const INFO = { name: 'corrallm', version: '0.1.0' };
const answerInfo = () => ({ ok: true, value: INFO }) as const;

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

  it('calls each GUI operation over the port, resolving with its value', async () => {
    const api = await exposed();
    const heard = postPort(answerInfo);

    await expect(api.appInfo()).resolves.toEqual(INFO);
    await expect(api.appInfo({})).resolves.toEqual(INFO);

    expect(heard).toEqual([
      ['app.info', undefined],
      ['app.info', {}],
    ]);
  });

  it('holds calls made before the port comes until it does', async () => {
    const api = await exposed();

    const info = api.appInfo();
    postPort(answerInfo);

    await expect(info).resolves.toEqual(INFO);
  });

  it('rejects with the operation’s sentence when it fails', async () => {
    const api = await exposed();
    postPort(() => ({
      ok: false,
      error: { code: 'unavailable', sentence: 'corrallm’s core can’t answer now.' },
    }));

    await expect(api.appInfo()).rejects.toThrow('corrallm’s core can’t answer now.');
  });

  it('takes a new port in place of the one before, failing what waited on the old one', async () => {
    const api = await exposed();
    postPort(() => new Promise<never>(() => undefined));
    const stranded = api.appInfo();

    const heard = postPort(answerInfo);

    await expect(stranded).rejects.toThrow('corrallm’s core restarted.');
    await expect(api.appInfo()).resolves.toEqual(INFO);
    expect(heard).toHaveLength(1);
  });

  it('rejects every call once main refuses the port', async () => {
    invoke.mockRejectedValue(new Error('Rejected core:connect: untrusted sender'));
    const api = await exposed();

    await expect(api.appInfo()).rejects.toThrow('untrusted sender');
  });
});

describe('preload', () => {
  it('invokes the catalog and canvas channels with their arguments', async () => {
    const api = await exposed();

    // The catalog, which the renderer loads before it mounts.
    const catalog = { adapters: [], usageBackends: [] };
    invoke.mockResolvedValue(catalog);
    await expect(api.catalog()).resolves.toBe(catalog);
    expect(invoke).toHaveBeenLastCalledWith('catalog:get');

    // The canvas file functions invoke their channels with their arguments.
    await api.openCanvas();
    expect(invoke).toHaveBeenLastCalledWith('canvas:open');
    await api.saveCanvas('{}', true);
    expect(invoke).toHaveBeenLastCalledWith('canvas:save', '{}', true);
    await api.forgetCanvas();
    expect(invoke).toHaveBeenLastCalledWith('canvas:forget');
    await api.chooseProject();
    expect(invoke).toHaveBeenLastCalledWith('project:choose');
    await api.findProjectFiles('src/ma');
    expect(invoke).toHaveBeenLastCalledWith('project:files', 'src/ma');
  });

  it('invokes the session channels with their arguments', async () => {
    const api = await exposed();
    invoke.mockResolvedValue(null);
    const options = { connection: 'claude-code.sdk', model: null, mode: 'manual' } as const;
    await api.startSession('a', options);
    expect(invoke).toHaveBeenLastCalledWith('session:start', 'a', options);
    await api.sendToSession('a', { id: 'm', text: 'Hi' });
    expect(invoke).toHaveBeenLastCalledWith('session:send', 'a', { id: 'm', text: 'Hi' });
    const image = { mediaType: 'image/png', data: 'iVBORw0KGgo=' } as const;
    await api.sendToSession('a', { id: 'm2', text: '', images: [image] });
    expect(invoke).toHaveBeenLastCalledWith('session:send', 'a', {
      id: 'm2',
      text: '',
      images: [image],
    });
    await api.answerSession('a', 'p', { kind: 'permission', answer: 'deny' });
    expect(invoke).toHaveBeenLastCalledWith('session:answer', 'a', 'p', {
      kind: 'permission',
      answer: 'deny',
    });
    await api.interruptSession('a');
    expect(invoke).toHaveBeenLastCalledWith('session:interrupt', 'a');
    await api.setSessionMode('a', 'plan');
    expect(invoke).toHaveBeenLastCalledWith('session:mode', 'a', 'plan');
    await api.setSessionModel('a', 'opus');
    expect(invoke).toHaveBeenLastCalledWith('session:model', 'a', 'opus');
    await api.setSessionEffort('a', 'high');
    expect(invoke).toHaveBeenLastCalledWith('session:effort', 'a', 'high');
    await api.stopSessionTask('a', 'b1');
    expect(invoke).toHaveBeenLastCalledWith('session:stopTask', 'a', 'b1');
    await api.closeSession('a');
    expect(invoke).toHaveBeenLastCalledWith('session:close', 'a');
    await api.freshSession('a', 'codex');
    expect(invoke).toHaveBeenLastCalledWith('session:fresh', 'a', 'codex');
    await api.listSessions('a');
    expect(invoke).toHaveBeenLastCalledWith('session:list', 'a');
    await api.previewRewind('a', 'm');
    expect(invoke).toHaveBeenLastCalledWith('session:rewind-preview', 'a', 'm');
    await api.rewindSession('a', 'm', 'both');
    expect(invoke).toHaveBeenLastCalledWith('session:rewind', 'a', 'm', 'both');
    await api.mcpServers('a');
    expect(invoke).toHaveBeenLastCalledWith('session:mcp', 'a');
    await api.settingsOptions('claude-code');
    expect(invoke).toHaveBeenLastCalledWith('session:options', 'claude-code');
    await api.changeMcpServer('a', 'github', 'disable');
    expect(invoke).toHaveBeenLastCalledWith('session:mcp-change', 'a', 'github', 'disable');
    await api.resumeSession('a', '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e11');
    expect(invoke).toHaveBeenLastCalledWith(
      'session:resume',
      'a',
      '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e11',
    );
  });

  it('passes session events on without Electron’s event object, until told to stop', async () => {
    const api = await exposed();
    const heard = vi.fn<Parameters<AppApi['onSessionEvent']>[0]>();
    const stop = api.onSessionEvent(heard);
    const receive = listenerOn('session:event');

    const event: SessionEvent = { type: 'status', status: 'working' };
    receive({ sender: 'the ipcRenderer event' }, 'a', 'claude-code.sdk', event);
    expect(heard).toHaveBeenCalledWith('a', 'claude-code.sdk', event);

    stop();
    expect(removeListener).toHaveBeenCalledWith('session:event', receive);
  });

  it('invokes the terminal channels with their arguments', async () => {
    const api = await exposed();
    invoke.mockResolvedValue(null);
    await api.attachTerminal('a');
    expect(invoke).toHaveBeenLastCalledWith('terminal:attach', 'a');
    await api.writeTerminal('a', 'ls\r');
    expect(invoke).toHaveBeenLastCalledWith('terminal:input', 'a', 'ls\r');
    await api.resizeTerminal('a', 120, 40);
    expect(invoke).toHaveBeenLastCalledWith('terminal:resize', 'a', 120, 40);
    await api.detachTerminal('a');
    expect(invoke).toHaveBeenLastCalledWith('terminal:detach', 'a');
  });

  it('asks main to open a link, with only its URL', async () => {
    const api = await exposed();
    invoke.mockResolvedValue(true);
    await expect(api.openLink('https://docs.example.com/a')).resolves.toBe(true);
    expect(invoke).toHaveBeenLastCalledWith('link:open', 'https://docs.example.com/a');
  });

  it('asks main to show a file:// link’s file in the file manager, with only the link', async () => {
    const api = await exposed();
    invoke.mockResolvedValue(true);
    await expect(api.revealFile('file:///work/app/notes.txt')).resolves.toBe(true);
    expect(invoke).toHaveBeenLastCalledWith('link:reveal', 'file:///work/app/notes.txt');
  });

  it('sends the paths of files dropped on a terminal, as the files say, never the page', async () => {
    const api = await exposed();
    invoke.mockResolvedValue(null);
    const shot = new File(['png'], 'Screen Shot.png');
    const made = new File(['made by the page'], 'made.txt');
    getPathForFile.mockImplementation((file) => (file === shot ? '/Users/me/Screen Shot.png' : ''));
    await api.dropOnTerminal('a', [shot, made]);
    expect(invoke).toHaveBeenLastCalledWith('terminal:drop', 'a', ['/Users/me/Screen Shot.png']);
    // Files that are not on disk (made by the page) name no path: nothing is sent.
    invoke.mockClear();
    await expect(api.dropOnTerminal('a', [made])).resolves.toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('passes terminal events on without Electron’s event object, until told to stop', async () => {
    const api = await exposed();
    const heard = vi.fn<Parameters<AppApi['onTerminalEvent']>[0]>();
    const stop = api.onTerminalEvent(heard);
    const receive = listenerOn('terminal:event');

    receive({ sender: 'the ipcRenderer event' }, 'a', { type: 'output', data: 'hi' });
    expect(heard).toHaveBeenCalledWith('a', { type: 'output', data: 'hi' });

    stop();
    expect(removeListener).toHaveBeenCalledWith('terminal:event', receive);
  });

  it('asks main which agents the user has', async () => {
    const api = await exposed();
    invoke.mockResolvedValue({ 'claude-code': true, codex: true });
    await expect(api.installedClis()).resolves.toEqual({ 'claude-code': true, codex: true });
    expect(invoke).toHaveBeenLastCalledWith('session:clis');
  });

  it('invokes the usage channels with their arguments', async () => {
    const api = await exposed();
    invoke.mockResolvedValue({ readings: [], rules: {} });
    await expect(api.getUsage()).resolves.toEqual({ readings: [], rules: {} });
    expect(invoke).toHaveBeenLastCalledWith('usage:get');
    const rule = { window: 'weekly', percent: 90, action: 'warn' } as const;
    await api.setUsageRule('claude-code', rule);
    expect(invoke).toHaveBeenLastCalledWith('usage:rule', 'claude-code', rule);
    const windows = { fiveHour: { usedPercent: 85, resetsAt: null } };
    await api.simulateUsage('claude-code', windows);
    expect(invoke).toHaveBeenLastCalledWith('usage:simulate', 'claude-code', windows);
  });

  it('passes usage changes on without Electron’s event object, until told to stop', async () => {
    const api = await exposed();
    const heard = vi.fn<Parameters<AppApi['onUsageChanged']>[0]>();
    const stop = api.onUsageChanged(heard);
    const receive = listenerOn('usage:changed');

    const state = { readings: [], rules: {} };
    receive({ sender: 'the ipcRenderer event' }, state);
    expect(heard).toHaveBeenCalledWith(state);

    stop();
    expect(removeListener).toHaveBeenCalledWith('usage:changed', receive);
  });
});

describe('run persistence preload', () => {
  it('exposes only typed get/save/ready calls and strips the stopping event object', async () => {
    const api = await exposed();
    const checkpoint = {
      version: 2,
      workflow: '{}',
      state: '{}',
      messages: '[]',
      updatedAt: 1,
    } as const;
    await api.getRun();
    expect(invoke).toHaveBeenLastCalledWith('run:get');
    await api.saveRun('token', checkpoint);
    expect(invoke).toHaveBeenLastCalledWith('run:save', 'token', checkpoint);
    await api.runReady('request', null);
    expect(invoke).toHaveBeenLastCalledWith('run:ready', 'request', null);
    const listener = vi.fn();
    const stop = api.onRunStopping(listener);
    const call = on.mock.calls.find(([channel]) => channel === 'run:stopping');
    call?.[1]({}, 'request');
    expect(listener).toHaveBeenCalledWith('request');
    stop();
    expect(removeListener).toHaveBeenCalledWith('run:stopping', call?.[1]);
  });
});
