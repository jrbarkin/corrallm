import { beforeEach, describe, expect, it, vi } from 'vitest';

// Unit tests never load the real 'electron' module (importing it would download the binary).
const { handle } = vi.hoisted(() => ({
  handle:
    vi.fn<(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => void>(),
}));
vi.mock('electron', () => ({
  app: { getName: () => 'corrallm', getVersion: () => '0.1.0' },
  ipcMain: { handle },
}));

import { API_CHANNELS, MAX_CANVAS_BYTES } from '../shared/ipc';
import { MAX_ID_LENGTH, MAX_MESSAGE_LENGTH } from '../shared/session';
import { registerIpcHandlers } from './ipc';
import type { IpcServices } from './ipc';

const TRUSTED_ORIGIN = 'app://main_window';

function frame(origin: string, overrides: Record<string, unknown> = {}) {
  return { origin, detached: false, parent: null, ...overrides };
}

/** What the handlers act on, faked: every call is recorded. */
function fakeServices() {
  return {
    projects: {
      choose: vi.fn<IpcServices['projects']['choose']>().mockResolvedValue(null),
      restore: vi.fn<IpcServices['projects']['restore']>().mockResolvedValue(undefined),
      remember: vi.fn<IpcServices['projects']['remember']>().mockResolvedValue(undefined),
      forget: vi.fn<IpcServices['projects']['forget']>(),
      of: vi.fn<IpcServices['projects']['of']>().mockReturnValue(undefined),
    },
    sessions: {
      start: vi.fn<IpcServices['sessions']['start']>().mockResolvedValue(undefined),
      send: vi.fn<IpcServices['sessions']['send']>().mockResolvedValue(undefined),
      answer: vi.fn<IpcServices['sessions']['answer']>().mockResolvedValue(undefined),
      interrupt: vi.fn<IpcServices['sessions']['interrupt']>().mockResolvedValue(undefined),
      setMode: vi.fn<IpcServices['sessions']['setMode']>().mockResolvedValue(undefined),
      setModel: vi.fn<IpcServices['sessions']['setModel']>().mockResolvedValue(undefined),
      close: vi.fn<IpcServices['sessions']['close']>().mockResolvedValue(undefined),
      canvasOpened: vi.fn<IpcServices['sessions']['canvasOpened']>().mockResolvedValue(undefined),
      canvasForgotten: vi
        .fn<IpcServices['sessions']['canvasForgotten']>()
        .mockResolvedValue(undefined),
      canvasSaved: vi.fn<IpcServices['sessions']['canvasSaved']>().mockResolvedValue(undefined),
      projectChanged: vi
        .fn<IpcServices['sessions']['projectChanged']>()
        .mockResolvedValue(undefined),
    },
  };
}

let services: ReturnType<typeof fakeServices>;

function listenerFor(name: string) {
  registerIpcHandlers(TRUSTED_ORIGIN, services);
  const call = handle.mock.calls.find(([channel]) => channel === name);
  if (call === undefined) throw new Error(`${name} was not registered`);
  return call[1];
}

/** Calls channel `name` as the trusted renderer would, its web contents being `sender`. */
function invoke(name: string, args: unknown[], sender: unknown = {}) {
  return listenerFor(name)({ senderFrame: frame(TRUSTED_ORIGIN), sender }, ...args);
}

const pingListener = () => listenerFor('app:ping');

beforeEach(() => {
  handle.mockReset();
  services = fakeServices();
});

describe('app:ping handler', () => {
  it('returns the version string to the trusted renderer', () => {
    const listener = pingListener();
    const result = listener({ senderFrame: frame(TRUSTED_ORIGIN) });
    expect(result).toMatch(/^corrallm 0\.1\.0 \(Electron .*, Chromium .*, Node .*\)$/);
  });

  it.each([
    ['a null sender frame', null],
    ['another origin', frame('https://evil.example')],
    ['a subframe', frame(TRUSTED_ORIGIN, { parent: {} })],
    ['a detached frame', frame(TRUSTED_ORIGIN, { detached: true })],
  ])('rejects %s', (_label, senderFrame) => {
    const listener = pingListener();
    expect(() => listener({ senderFrame })).toThrow(/untrusted sender/);
  });

  it('rejects unexpected arguments', () => {
    const listener = pingListener();
    expect(() => listener({ senderFrame: frame(TRUSTED_ORIGIN) }, 'extra')).toThrow(
      /Expected no arguments/,
    );
  });
});

describe('every channel', () => {
  it.each(Object.values(API_CHANNELS))('%s rejects an untrusted sender', (channel) => {
    const listener = listenerFor(channel);
    expect(() => listener({ senderFrame: frame('https://evil.example') })).toThrow(
      /untrusted sender/,
    );
    expect(Object.values(services.sessions).every((fn) => fn.mock.calls.length === 0)).toBe(true);
  });
});

describe('canvas:save handler', () => {
  it.each([
    ['no arguments', [], /Expected the canvas text/],
    ['text that is not a string', [42, false], /Expected the canvas text/],
    ['a choice that is not a boolean', ['{}', 'yes'], /Expected the canvas text/],
    ['an extra argument', ['{}', false, 'more'], /Expected the canvas text/],
    ['a canvas too large to save', ['x'.repeat(MAX_CANVAS_BYTES + 1), false], /too large/],
  ])('rejects %s', (_label, args, message) => {
    const listener = listenerFor('canvas:save');
    expect(() => listener({ senderFrame: frame(TRUSTED_ORIGIN) }, ...args)).toThrow(message);
  });
});

describe('project:choose handler', () => {
  it('ends the canvas’s sessions only when another folder is chosen', async () => {
    const sender = {};
    services.projects.of.mockReturnValue('/work/app');
    services.projects.choose.mockResolvedValueOnce({ name: 'app', path: '/work/app' });
    await invoke('project:choose', [], sender);
    expect(services.sessions.projectChanged).not.toHaveBeenCalled();

    services.projects.choose.mockResolvedValueOnce({ name: 'other', path: '/work/other' });
    await expect(invoke('project:choose', [], sender)).resolves.toEqual({
      name: 'other',
      path: '/work/other',
    });
    expect(services.sessions.projectChanged).toHaveBeenCalledWith(sender);

    services.projects.choose.mockResolvedValueOnce(null);
    await expect(invoke('project:choose', [], sender)).resolves.toBeNull();
    expect(services.sessions.projectChanged).toHaveBeenCalledTimes(1);
  });
});

describe('session:* handlers', () => {
  it('pass checked arguments on, for the renderer that sent them', async () => {
    const sender = {};
    const options = { connection: 'sdk', model: 'opus', mode: 'plan' };
    await invoke('session:start', ['a', options], sender);
    const [contents, agentId, given] = services.sessions.start.mock.calls[0] ?? [];
    expect([contents, agentId, given]).toEqual([sender, 'a', options]);
    // Built afresh: nothing the renderer sent is passed on as it came.
    expect(given).not.toBe(options);

    await invoke('session:send', ['a', { id: 'm1', text: 'Hi' }], sender);
    expect(services.sessions.send).toHaveBeenCalledWith(sender, 'a', { id: 'm1', text: 'Hi' });
    await invoke('session:answer', ['a', 'p1', { kind: 'question', answers: ['Yes'] }], sender);
    expect(services.sessions.answer).toHaveBeenCalledWith(sender, 'a', 'p1', {
      kind: 'question',
      answers: ['Yes'],
    });
    const plan = { kind: 'plan', answer: { approve: false, feedback: 'Smaller steps' } };
    await invoke('session:answer', ['a', 'p2', plan], sender);
    expect(services.sessions.answer).toHaveBeenLastCalledWith(sender, 'a', 'p2', plan);
    await invoke('session:interrupt', ['a'], sender);
    expect(services.sessions.interrupt).toHaveBeenCalledWith(sender, 'a');
    await invoke('session:mode', ['a', 'bypassPermissions'], sender);
    expect(services.sessions.setMode).toHaveBeenCalledWith(sender, 'a', 'bypassPermissions');
    await invoke('session:model', ['a', 'claude-haiku-5-5[1m]'], sender);
    expect(services.sessions.setModel).toHaveBeenCalledWith(sender, 'a', 'claude-haiku-5-5[1m]');
    await invoke('session:close', ['a'], sender);
    expect(services.sessions.close).toHaveBeenCalledWith(sender, 'a');
  });

  const start = { connection: 'terminal', model: null, mode: 'manual' };
  it.each([
    ['session:start', 'no options', ['a'], /Expected an agent and how to start/],
    ['session:start', 'an agent id that is not text', [7, start], /agent's id/],
    ['session:start', 'an empty agent id', ['', start], /agent's id/],
    ['session:start', 'a very long agent id', ['a'.repeat(MAX_ID_LENGTH + 1), start], /agent's id/],
    [
      'session:start',
      'an unknown connection',
      ['a', { ...start, connection: 'ssh' }],
      /connection/,
    ],
    ['session:start', 'an unknown mode', ['a', { ...start, mode: 'yolo' }], /mode/],
    ['session:start', 'a model with spaces', ['a', { ...start, model: 'rm -rf /' }], /model/],
    ['session:start', 'a path to resume', ['a', { ...start, resume: '/etc/passwd' }], /options/],
    ['session:send', 'a message without text', ['a', { id: 'm' }], /text/],
    ['session:send', 'a blank message', ['a', { id: 'm', text: '  ' }], /text/],
    ['session:send', 'a message without an id', ['a', { text: 'Hi' }], /message's id/],
    [
      'session:send',
      'a message too long',
      ['a', { id: 'm', text: 'x'.repeat(MAX_MESSAGE_LENGTH + 1) }],
      /too long/,
    ],
    [
      'session:send',
      'a message with more in it',
      ['a', { id: 'm', text: 'Hi', cwd: '/' }],
      /message/,
    ],
    ['session:answer', 'no answer', ['a', 'p'], /an agent, a prompt and an answer/],
    ['session:answer', 'an unknown kind', ['a', 'p', { kind: 'shell' }], /permission, question/],
    [
      'session:answer',
      'a permission answer not offered',
      ['a', 'p', { kind: 'permission', answer: 'forever' }],
      /permission answer/,
    ],
    [
      'session:answer',
      'no answers to questions',
      ['a', 'p', { kind: 'question', answers: [] }],
      /each question/,
    ],
    [
      'session:answer',
      'answers that are not text',
      ['a', 'p', { kind: 'question', answers: [1] }],
      /each question/,
    ],
    [
      'session:answer',
      'a plan approved in no mode',
      ['a', 'p', { kind: 'plan', answer: { approve: true, mode: 'plan' } }],
      /mode to carry out the plan/,
    ],
    [
      'session:answer',
      'a plan turned down without feedback',
      ['a', 'p', { kind: 'plan', answer: { approve: false } }],
      /what to change/,
    ],
    ['session:interrupt', 'no agent', [], /an agent/],
    ['session:close', 'an extra argument', ['a', 'b'], /an agent/],
    ['session:mode', 'an unknown mode', ['a', 'default'], /mode/],
    ['session:model', 'a model that is not text', ['a', 42], /model/],
  ])('%s rejects %s', (channel, _label, args, message) => {
    expect(() => invoke(channel, args)).toThrow(message);
    expect(Object.values(services.sessions).every((fn) => fn.mock.calls.length === 0)).toBe(true);
  });
});
