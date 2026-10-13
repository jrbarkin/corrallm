import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppApi } from '../shared/ipc';
import type { SessionEvent } from '../shared/session';

type Listener = (event: unknown, ...args: unknown[]) => void;
const { exposeInMainWorld, invoke, on, removeListener } = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn<(key: string, api: unknown) => void>(),
  invoke: vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>(),
  on: vi.fn<(channel: string, listener: Listener) => void>(),
  removeListener: vi.fn<(channel: string, listener: Listener) => void>(),
}));
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld },
  ipcRenderer: { invoke, on, removeListener },
}));

// Each test loads the preload afresh: Vitest clears mock calls between tests.
beforeEach(() => {
  vi.resetModules();
});

/** The api the preload exposed. */
async function exposed(): Promise<AppApi> {
  await import('./index');
  expect(exposeInMainWorld).toHaveBeenCalledOnce();
  const [key, api] = exposeInMainWorld.mock.calls[0] ?? [];
  expect(key).toBe('api');
  return api as AppApi;
}

describe('preload', () => {
  it('exposes window.api, whose ping() invokes app:ping', async () => {
    const api = await exposed();

    invoke.mockResolvedValue('corrallm 0.1.0');
    await expect(api.ping()).resolves.toBe('corrallm 0.1.0');
    expect(invoke).toHaveBeenCalledWith('app:ping');

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
    const options = { connection: 'sdk', model: null, mode: 'manual' } as const;
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
    await api.closeSession('a');
    expect(invoke).toHaveBeenLastCalledWith('session:close', 'a');
    await api.listSessions('a');
    expect(invoke).toHaveBeenLastCalledWith('session:list', 'a');
    await api.mcpServers('a');
    expect(invoke).toHaveBeenLastCalledWith('session:mcp', 'a');
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
    const [channel, receive] = on.mock.calls[0] ?? [];
    expect(channel).toBe('session:event');
    if (!receive) throw new Error('not listening');

    const event: SessionEvent = { type: 'status', status: 'working' };
    receive({ sender: 'the ipcRenderer event' }, 'a', 'sdk', event);
    expect(heard).toHaveBeenCalledWith('a', 'sdk', event);

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

  it('passes terminal events on without Electron’s event object, until told to stop', async () => {
    const api = await exposed();
    const heard = vi.fn<Parameters<AppApi['onTerminalEvent']>[0]>();
    const stop = api.onTerminalEvent(heard);
    const [channel, receive] = on.mock.calls[0] ?? [];
    expect(channel).toBe('terminal:event');
    if (!receive) throw new Error('not listening');

    receive({ sender: 'the ipcRenderer event' }, 'a', { type: 'output', data: 'hi' });
    expect(heard).toHaveBeenCalledWith('a', { type: 'output', data: 'hi' });

    stop();
    expect(removeListener).toHaveBeenCalledWith('terminal:event', receive);
  });
});
