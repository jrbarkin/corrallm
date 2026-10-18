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

import { newCanvasId } from '../shared/canvas';
import { API_CHANNELS, MAX_CANVAS_BYTES, MAX_LINK_LENGTH } from '../shared/ipc';
import { MAX_IMAGE_BYTES, MAX_IMAGE_TOTAL, MAX_IMAGES } from '../shared/api/limits';
import {
  MAX_ANSWER_LENGTH,
  MAX_FILE_MATCHES,
  MAX_FILE_QUERY_LENGTH,
  MAX_ID_LENGTH,
  MAX_MESSAGE_LENGTH,
} from '../shared/session';
import { MAX_DROPPED_FILES, MAX_DROPPED_PATH, MAX_TERMINAL_INPUT } from '../shared/terminal';
import { mintTrustedPath } from './core/host';
import { registerIpcHandlers } from './ipc';
import type { IpcServices } from './ipc';
import { CATALOG } from './sessions/adapters';

const TRUSTED_ORIGIN = 'app://main_window';

function frame(origin: string, overrides: Record<string, unknown> = {}) {
  return { origin, detached: false, parent: null, ...overrides };
}

/** The canvas the sender's window shows, as the window map says. */
const CANVAS = newCanvasId();
/** A new draft's id, as the journal gives it. */
const DRAFT = newCanvasId();

/** What the handlers act on, faked: every call is recorded. */
function fakeServices() {
  return {
    catalog: CATALOG,
    windows: {
      canvasOf: vi.fn<IpcServices['windows']['canvasOf']>().mockResolvedValue(CANVAS),
      show: vi.fn<IpcServices['windows']['show']>().mockResolvedValue(undefined),
    },
    canvases: {
      open: vi.fn<IpcServices['canvases']['open']>().mockResolvedValue(null),
      save: vi.fn<IpcServices['canvases']['save']>().mockResolvedValue(null),
    },
    runs: {
      get: vi
        .fn<IpcServices['runs']['get']>()
        .mockResolvedValue({ id: CANVAS, token: 'canvas-token', checkpoint: null, name: null }),
      save: vi.fn<IpcServices['runs']['save']>().mockResolvedValue(undefined),
      opened: vi.fn<IpcServices['runs']['opened']>().mockResolvedValue(undefined),
      saved: vi.fn<IpcServices['runs']['saved']>().mockResolvedValue(undefined),
      draft: vi.fn<IpcServices['runs']['draft']>().mockResolvedValue(DRAFT),
    },
    shutdown: { ready: vi.fn<IpcServices['shutdown']['ready']>() },
    projects: {
      choose: vi.fn<IpcServices['projects']['choose']>().mockResolvedValue(null),
      restore: vi.fn<IpcServices['projects']['restore']>().mockResolvedValue(undefined),
      of: vi.fn<IpcServices['projects']['of']>().mockReturnValue(undefined),
    },
    files: {
      find: vi.fn<IpcServices['files']['find']>().mockResolvedValue([]),
    },
    links: {
      open: vi.fn<IpcServices['links']['open']>().mockResolvedValue(true),
    },
    reveal: {
      reveal: vi.fn<IpcServices['reveal']['reveal']>().mockResolvedValue(true),
    },
    sessions: {
      start: vi.fn<IpcServices['sessions']['start']>().mockResolvedValue(undefined),
      send: vi.fn<IpcServices['sessions']['send']>().mockResolvedValue(undefined),
      answer: vi.fn<IpcServices['sessions']['answer']>().mockResolvedValue(undefined),
      interrupt: vi.fn<IpcServices['sessions']['interrupt']>().mockResolvedValue(undefined),
      setMode: vi.fn<IpcServices['sessions']['setMode']>().mockResolvedValue(undefined),
      setModel: vi.fn<IpcServices['sessions']['setModel']>().mockResolvedValue(undefined),
      setEffort: vi.fn<IpcServices['sessions']['setEffort']>().mockResolvedValue(undefined),
      stopTask: vi.fn<IpcServices['sessions']['stopTask']>().mockResolvedValue(undefined),
      close: vi.fn<IpcServices['sessions']['close']>().mockResolvedValue(undefined),
      fresh: vi.fn<IpcServices['sessions']['fresh']>().mockResolvedValue(undefined),
      listSessions: vi.fn<IpcServices['sessions']['listSessions']>().mockResolvedValue([]),
      resumeSession: vi.fn<IpcServices['sessions']['resumeSession']>().mockResolvedValue(undefined),
      mcpServers: vi.fn<IpcServices['sessions']['mcpServers']>().mockResolvedValue([]),
      previewRewind: vi
        .fn<IpcServices['sessions']['previewRewind']>()
        .mockResolvedValue({ possible: true, files: [], added: 0, removed: 0 }),
      rewind: vi.fn<IpcServices['sessions']['rewind']>().mockResolvedValue({ conversation: false }),
      changeMcpServer: vi.fn<IpcServices['sessions']['changeMcpServer']>().mockResolvedValue([]),
      settingsOptions: vi.fn<IpcServices['sessions']['settingsOptions']>().mockResolvedValue({
        models: [],
        defaults: { model: null, effort: null, mode: null },
      }),
      projectChanged: vi
        .fn<IpcServices['sessions']['projectChanged']>()
        .mockResolvedValue(undefined),
      attachTerminal: vi.fn<IpcServices['sessions']['attachTerminal']>(),
      detachTerminal: vi.fn<IpcServices['sessions']['detachTerminal']>(),
      inputTerminal: vi.fn<IpcServices['sessions']['inputTerminal']>().mockResolvedValue(undefined),
      resizeTerminal: vi
        .fn<IpcServices['sessions']['resizeTerminal']>()
        .mockResolvedValue(undefined),
      dropOnTerminal: vi
        .fn<IpcServices['sessions']['dropOnTerminal']>()
        .mockResolvedValue(undefined),
    },
    clis: {
      installed: vi
        .fn<IpcServices['clis']['installed']>()
        .mockResolvedValue({ 'claude-code': true, codex: false }),
    },
    usage: {
      state: vi.fn<IpcServices['usage']['state']>().mockReturnValue({ readings: [], rules: {} }),
      setRule: vi.fn<IpcServices['usage']['setRule']>(),
      simulate: vi.fn<IpcServices['usage']['simulate']>(),
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
function invoke(name: string, args: unknown[], sender: unknown = { id: 7 }) {
  return listenerFor(name)({ senderFrame: frame(TRUSTED_ORIGIN), sender }, ...args);
}

const pingListener = () => listenerFor('app:ping');

beforeEach(() => {
  handle.mockReset();
  services = fakeServices();
});

describe('catalog:get handler', () => {
  it('answers with the catalog, and takes no arguments', () => {
    expect(invoke('catalog:get', [])).toBe(CATALOG);
    expect(() => invoke('catalog:get', ['claude-code'])).toThrow(/no arguments/);
  });
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
    expect(services.links.open).not.toHaveBeenCalled();
    expect(services.reveal.reveal).not.toHaveBeenCalled();
  });
});

describe('link:open handler', () => {
  it('passes the URL on, for main to check and ask about, for the renderer that sent it', async () => {
    const sender = {};
    await expect(invoke('link:open', ['https://docs.example.com/a'], sender)).resolves.toBe(true);
    expect(services.links.open).toHaveBeenCalledWith(sender, 'https://docs.example.com/a');
  });

  it.each([
    ['no URL', [], /Expected a link/],
    ['a URL that is not a string', [{ href: 'https://x.example' }], /Expected a link/],
    ['an extra argument', ['https://docs.example.com/', true], /Expected a link/],
    ['a URL too long', [`https://x.example/${'a'.repeat(MAX_LINK_LENGTH)}`], /too long/],
  ])('rejects %s', (_label, args, message) => {
    expect(() => invoke('link:open', args)).toThrow(message);
    expect(services.links.open).not.toHaveBeenCalled();
  });
});

describe('link:reveal handler', () => {
  it('passes the link on, for main to check against the sender’s canvas’s project folder', async () => {
    const sender = {};
    const link = 'file:///work/app/notes.txt';
    await expect(invoke('link:reveal', [link], sender)).resolves.toBe(true);
    expect(services.reveal.reveal).toHaveBeenCalledWith(CANVAS, link);
  });

  it.each([
    ['no link', [], /Expected a link/],
    ['a link that is not a string', [{ href: 'file:///work/app' }], /Expected a link/],
    ['an extra argument', ['file:///work/app/notes.txt', true], /Expected a link/],
    ['a link too long', [`file:///work/${'a'.repeat(MAX_LINK_LENGTH)}`], /too long/],
  ])('rejects %s', (_label, args, message) => {
    expect(() => invoke('link:reveal', args)).toThrow(message);
    expect(services.reveal.reveal).not.toHaveBeenCalled();
  });
});

describe('canvas:* handlers', () => {
  it('opens a canvas file in the sender’s window, which shows it, its folder restored', async () => {
    const sender = { id: 7 };
    const id = newCanvasId();
    services.canvases.open.mockResolvedValue({ id, name: 'team.corral', text: '{}' });
    services.projects.restore.mockResolvedValue({ name: 'app', path: '/work/app' });
    await expect(invoke('canvas:open', [], sender)).resolves.toEqual({
      id,
      name: 'team.corral',
      text: '{}',
      project: { name: 'app', path: '/work/app' },
    });
    expect(services.canvases.open).toHaveBeenCalledWith(7);
    expect(services.runs.opened).toHaveBeenCalledWith(id, undefined);
    expect(services.windows.show).toHaveBeenCalledWith(sender, id);
    expect(services.projects.restore).toHaveBeenCalledWith(id);
  });

  it('says once why a file opened as a copy, and opens nothing when cancelled', async () => {
    const id = newCanvasId();
    const copy = 'team.corral is a copy of a canvas saved as other.corral: it opened as its own.';
    services.canvases.open.mockResolvedValueOnce({ id, name: 'team.corral', text: '{}', copy });
    await expect(invoke('canvas:open', [])).resolves.toEqual({
      id,
      name: 'team.corral',
      text: '{}',
    });
    expect(services.runs.opened).toHaveBeenCalledWith(id, copy);
    await expect(invoke('canvas:open', [])).resolves.toBeNull();
    expect(services.windows.show).toHaveBeenCalledOnce();
  });

  it('saves the sender’s canvas, and its record names the file then', async () => {
    services.canvases.save.mockResolvedValueOnce('team.corral').mockResolvedValueOnce(null);
    await expect(invoke('canvas:save', ['{}', true])).resolves.toBe('team.corral');
    expect(services.canvases.save).toHaveBeenCalledWith(7, CANVAS, '{}', true);
    expect(services.runs.saved).toHaveBeenCalledWith(CANVAS);
    // Cancelled: nothing changes.
    await expect(invoke('canvas:save', ['{}', false])).resolves.toBeNull();
    expect(services.runs.saved).toHaveBeenCalledOnce();
  });

  it('begins a new draft in the sender’s window', async () => {
    const sender = { id: 7 };
    await expect(invoke('canvas:forget', [], sender)).resolves.toBe(DRAFT);
    expect(services.windows.show).toHaveBeenCalledWith(sender, DRAFT);
  });
});

describe('canvas replacement after a failed restore', () => {
  it('starts New without requiring the rejected journal to be readable', async () => {
    const sender = { id: 7 };
    services.windows.canvasOf.mockRejectedValue(new Error('Corrupt journal'));
    await expect(invoke('canvas:forget', [], sender)).resolves.toBe(DRAFT);
    expect(services.windows.canvasOf).not.toHaveBeenCalled();
    expect(services.windows.show).toHaveBeenCalledWith(sender, DRAFT);
  });

  it('opens a replacement without reading the rejected journal first', async () => {
    const sender = { id: 7 };
    const id = newCanvasId();
    services.windows.canvasOf.mockRejectedValue(new Error('Corrupt journal'));
    services.canvases.open.mockResolvedValue({ id, name: 'replacement.corral', text: '{}' });
    await expect(invoke('canvas:open', [], sender)).resolves.toEqual({
      id,
      name: 'replacement.corral',
      text: '{}',
    });
    expect(services.windows.canvasOf).not.toHaveBeenCalled();
    expect(services.windows.show).toHaveBeenCalledWith(sender, id);
  });
});

describe('the sender’s canvas', () => {
  it.each([
    { channel: 'canvas:save', args: ['{}', true], action: 'save' },
    { channel: 'project:choose', args: [], action: 'choose' },
    {
      channel: 'session:start',
      args: ['a', { connection: 'claude-code.terminal', model: null, mode: null }],
      action: 'start',
    },
  ])('$channel acts on it once its window has it', async ({ channel, args, action }) => {
    const sender = { id: 7 };
    const shown = Promise.withResolvers<typeof CANVAS>();
    services.windows.canvasOf.mockReturnValue(shown.promise);
    services.canvases.save.mockResolvedValue('rescued.corral');
    const called =
      action === 'save'
        ? services.canvases.save
        : action === 'choose'
          ? services.projects.choose
          : services.sessions.start;
    const result = Promise.resolve(invoke(channel, args, sender)).then(
      (value: unknown) => ({ value }),
      (error: unknown) => ({ error }),
    );
    expect(services.windows.canvasOf).toHaveBeenCalledWith(sender);
    expect(called).not.toHaveBeenCalled();
    shown.resolve(CANVAS);
    expect(await result).toEqual({ value: action === 'save' ? 'rescued.corral' : null });
    expect(called).toHaveBeenCalledOnce();
    expect(called.mock.calls[0]).toContain(CANVAS);
  });

  it('is what run:get restores and run:save journals', async () => {
    await expect(invoke('run:get', [])).resolves.toMatchObject({ id: CANVAS });
    expect(services.runs.get).toHaveBeenCalledWith(CANVAS);
    const checkpoint = { version: 2, workflow: '{}', state: '{}', messages: '[]', updatedAt: 1 };
    await invoke('run:save', ['canvas-token', checkpoint]);
    expect(services.runs.save).toHaveBeenCalledWith(CANVAS, 'canvas-token', checkpoint);
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
    services.projects.of.mockReturnValue(mintTrustedPath('/work/app'));
    services.projects.choose.mockResolvedValueOnce({ name: 'app', path: '/work/app' });
    await invoke('project:choose', [], sender);
    expect(services.sessions.projectChanged).not.toHaveBeenCalled();

    services.projects.choose.mockResolvedValueOnce({ name: 'other', path: '/work/other' });
    await expect(invoke('project:choose', [], sender)).resolves.toEqual({
      name: 'other',
      path: '/work/other',
    });
    expect(services.sessions.projectChanged).toHaveBeenCalledWith(CANVAS);

    services.projects.choose.mockResolvedValueOnce(null);
    await expect(invoke('project:choose', [], sender)).resolves.toBeNull();
    expect(services.sessions.projectChanged).toHaveBeenCalledTimes(1);
  });
});

describe('project:files handler', () => {
  it('searches the files of the sender’s project folder, and of none without one', async () => {
    const sender = {};
    await expect(invoke('project:files', ['ipc'], sender)).resolves.toEqual([]);
    expect(services.files.find).not.toHaveBeenCalled();

    services.projects.of.mockReturnValue(mintTrustedPath('/work/app'));
    services.files.find.mockResolvedValueOnce(['src/main/ipc.ts']);
    await expect(invoke('project:files', ['ipc'], sender)).resolves.toEqual(['src/main/ipc.ts']);
    expect(services.projects.of).toHaveBeenCalledWith(CANVAS);
    expect(services.files.find).toHaveBeenCalledWith('/work/app', 'ipc', MAX_FILE_MATCHES);
  });

  it.each([
    ['nothing to search for', []],
    ['a query that is not text', [42]],
    ['a query too long', ['x'.repeat(MAX_FILE_QUERY_LENGTH + 1)]],
    ['a folder as well', ['ipc', '/etc']],
  ])('rejects %s', (_label, args) => {
    expect(() => invoke('project:files', args)).toThrow(/what to search for/);
    expect(services.files.find).not.toHaveBeenCalled();
  });
});

describe('session:* handlers', () => {
  it('pass checked arguments on, for the renderer that sent them', async () => {
    const sender = {};
    const options = { connection: 'claude-code.sdk', model: 'opus', mode: 'plan' };
    await invoke('session:start', ['a', options], sender);
    const [canvas, agentId, given] = services.sessions.start.mock.calls[0] ?? [];
    expect([canvas, agentId, given]).toEqual([CANVAS, 'a', options]);
    // Built afresh: nothing the renderer sent is passed on as it came.
    expect(given).not.toBe(options);
    // No model or mode chosen: main's to decide (what the agent last chose, or the user's own).
    const unchosen = { connection: 'claude-code.terminal', model: null, mode: null };
    await invoke('session:start', ['b', unchosen], sender);
    expect(services.sessions.start).toHaveBeenLastCalledWith(CANVAS, 'b', unchosen);

    await invoke('session:send', ['a', { id: 'm1', text: 'Hi' }], sender);
    expect(services.sessions.send).toHaveBeenCalledWith(CANVAS, 'a', { id: 'm1', text: 'Hi' });
    // A pasted image may be all a message is.
    const image = { mediaType: 'image/png', data: 'iVBORw0KGgo=' };
    await invoke('session:send', ['a', { id: 'm2', text: '', images: [image] }], sender);
    expect(services.sessions.send).toHaveBeenLastCalledWith(CANVAS, 'a', {
      id: 'm2',
      text: '',
      images: [image],
    });
    // As many images as fit in a message's limit together, each as large as one may be.
    const largest = {
      mediaType: 'image/png',
      data: 'A'.repeat(Math.floor(MAX_IMAGE_BYTES / 3) * 4),
    };
    const images = Array.from(
      { length: Math.floor(MAX_IMAGE_TOTAL / MAX_IMAGE_BYTES) },
      () => largest,
    );
    await invoke('session:send', ['a', { id: 'm3', text: 'Four', images }], sender);
    expect(services.sessions.send).toHaveBeenLastCalledWith(CANVAS, 'a', {
      id: 'm3',
      text: 'Four',
      images,
    });
    await invoke('session:answer', ['a', 'p1', { kind: 'question', answers: ['Yes'] }], sender);
    expect(services.sessions.answer).toHaveBeenCalledWith(CANVAS, 'a', 'p1', {
      kind: 'question',
      answers: ['Yes'],
    });
    const plan = { kind: 'plan', answer: { approve: false, feedback: 'Smaller steps' } };
    await invoke('session:answer', ['a', 'p2', plan], sender);
    expect(services.sessions.answer).toHaveBeenLastCalledWith(CANVAS, 'a', 'p2', plan);
    await invoke('session:interrupt', ['a'], sender);
    expect(services.sessions.interrupt).toHaveBeenCalledWith(CANVAS, 'a');
    await invoke('session:mode', ['a', 'bypassPermissions'], sender);
    expect(services.sessions.setMode).toHaveBeenCalledWith(CANVAS, 'a', 'bypassPermissions');
    await invoke('session:model', ['a', 'claude-haiku-5-5[1m]'], sender);
    expect(services.sessions.setModel).toHaveBeenCalledWith(CANVAS, 'a', 'claude-haiku-5-5[1m]');
    await invoke('session:effort', ['a', 'xhigh'], sender);
    expect(services.sessions.setEffort).toHaveBeenCalledWith(CANVAS, 'a', 'xhigh');
    await invoke('session:effort', ['a', null], sender);
    expect(services.sessions.setEffort).toHaveBeenLastCalledWith(CANVAS, 'a', null);
    await invoke('session:stopTask', ['a', 'b1'], sender);
    expect(services.sessions.stopTask).toHaveBeenCalledWith(CANVAS, 'a', 'b1');
    // Denied, with what to do instead.
    const denied = { kind: 'permission', answer: 'deny', feedback: 'Use pnpm' };
    await invoke('session:answer', ['a', 'p3', denied], sender);
    expect(services.sessions.answer).toHaveBeenLastCalledWith(CANVAS, 'a', 'p3', denied);
    await invoke('session:close', ['a'], sender);
    expect(services.sessions.close).toHaveBeenCalledWith(CANVAS, 'a');
    await invoke('session:fresh', ['a', 'codex'], sender);
    expect(services.sessions.fresh).toHaveBeenCalledWith(CANVAS, 'a', 'codex');
    await invoke('session:fresh', ['a', 'claude-code'], sender);
    expect(services.sessions.fresh).toHaveBeenLastCalledWith(CANVAS, 'a', 'claude-code');
    const form = { kind: 'elicitation', action: 'accept', values: { repo: 'acme/shop', n: 2 } };
    await invoke('session:answer', ['a', 'e1', form], sender);
    expect(services.sessions.answer).toHaveBeenLastCalledWith(CANVAS, 'a', 'e1', form);
    await invoke('session:answer', ['a', 'e2', { kind: 'elicitation', action: 'decline' }], sender);
    expect(services.sessions.answer).toHaveBeenLastCalledWith(CANVAS, 'a', 'e2', {
      kind: 'elicitation',
      action: 'decline',
    });
    await invoke('session:rewind-preview', ['a', 'm1'], sender);
    expect(services.sessions.previewRewind).toHaveBeenCalledWith(CANVAS, 'a', 'm1');
    await invoke('session:rewind', ['a', 'm1', 'conversation'], sender);
    expect(services.sessions.rewind).toHaveBeenCalledWith(CANVAS, 'a', 'm1', 'conversation');
    await invoke('session:mcp', ['a'], sender);
    expect(services.sessions.mcpServers).toHaveBeenCalledWith(CANVAS, 'a');
    await invoke('session:mcp-change', ['a', 'github', 'reconnect'], sender);
    expect(services.sessions.changeMcpServer).toHaveBeenCalledWith(
      CANVAS,
      'a',
      'github',
      'reconnect',
    );
    await invoke('session:list', ['a'], sender);
    expect(services.sessions.listSessions).toHaveBeenCalledWith(CANVAS, 'a');
    // What an adapter's agents can be set to: read for the canvas the renderer shows.
    await invoke('session:options', ['codex'], sender);
    expect(services.sessions.settingsOptions).toHaveBeenCalledWith(CANVAS, 'codex');
    await invoke('session:options', ['claude-code'], sender);
    expect(services.sessions.settingsOptions).toHaveBeenLastCalledWith(CANVAS, 'claude-code');
    // Which conversations it may open is main's to say (it listed them): the id goes on.
    await invoke('session:resume', ['a', '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e11'], sender);
    expect(services.sessions.resumeSession).toHaveBeenCalledWith(
      CANVAS,
      'a',
      '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e11',
    );
  });

  it('start Codex sessions in the modes each connection starts in, and switch to any', async () => {
    const sender = {};
    const options = { connection: 'codex.app-server', model: 'gpt-6-luna', mode: 'plan' };
    await invoke('session:start', ['a', options], sender);
    expect(services.sessions.start).toHaveBeenCalledWith(CANVAS, 'a', options);
    const terminal = { ...options, connection: 'codex.terminal', mode: 'read-only' };
    await invoke('session:start', ['b', terminal], sender);
    expect(services.sessions.start).toHaveBeenLastCalledWith(CANVAS, 'b', terminal);
    // A mode that never asks is the session's, once the user confirms it: never a start's.
    await invoke('session:mode', ['a', 'full-access'], sender);
    expect(services.sessions.setMode).toHaveBeenCalledWith(CANVAS, 'a', 'full-access');
  });

  it('start sessions at a reasoning effort, and switch it (or back to the model’s default)', async () => {
    const sender = {};
    const options = {
      connection: 'codex.app-server',
      model: 'gpt-6-luna',
      mode: 'auto',
      effort: 'xhigh',
    };
    await invoke('session:start', ['a', options], sender);
    expect(services.sessions.start).toHaveBeenCalledWith(CANVAS, 'a', options);
    await invoke('session:effort', ['a', 'low'], sender);
    expect(services.sessions.setEffort).toHaveBeenCalledWith(CANVAS, 'a', 'low');
    await invoke('session:effort', ['a', null], sender);
    expect(services.sessions.setEffort).toHaveBeenLastCalledWith(CANVAS, 'a', null);
  });

  const start = { connection: 'claude-code.terminal', model: null, mode: 'manual' };
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
    // Connections are named by their final ids only.
    [
      'session:start',
      'an old connection id',
      ['a', { ...start, connection: 'terminal' }],
      /connection/,
    ],
    ['session:start', 'an unknown mode', ['a', { ...start, mode: 'yolo' }], /mode/],
    [
      'session:start',
      'a mode of another adapter',
      ['a', { ...start, connection: 'codex.app-server', mode: 'acceptEdits' }],
      /mode codex\.app-server sessions start in/,
    ],
    ['session:start', 'a Codex mode for Claude', ['a', { ...start, mode: 'read-only' }], /mode/],
    [
      'session:start',
      'a mode that never asks',
      ['a', { ...start, mode: 'bypassPermissions' }],
      /mode claude-code\.terminal sessions start in/,
    ],
    [
      'session:start',
      'Full access',
      ['a', { ...start, connection: 'codex.app-server', mode: 'full-access' }],
      /mode codex\.app-server sessions start in/,
    ],
    [
      'session:start',
      'a mode its connection does not start in',
      ['a', { ...start, connection: 'codex.terminal', mode: 'plan' }],
      /mode codex\.terminal sessions start in/,
    ],
    ['session:start', 'a model with spaces', ['a', { ...start, model: 'rm -rf /' }], /model/],
    // A command line would take it for a flag.
    [
      'session:start',
      'a model that reads as a flag',
      ['a', { ...start, model: '--dangerously-skip-permissions' }],
      /model/,
    ],
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
    [
      'session:send',
      'a message naming another party as its sender',
      ['a', { id: 'm', text: 'Hi', from: { party: 'agent:b', name: 'B' } }],
      /message/,
    ],
    [
      'session:send',
      'an image of a kind Claude does not read',
      ['a', { id: 'm', text: 'Hi', images: [{ mediaType: 'image/svg+xml', data: 'PHN2Zz4=' }] }],
      /kind of image/,
    ],
    [
      'session:send',
      'an image that is not base64',
      ['a', { id: 'm', text: 'Hi', images: [{ mediaType: 'image/png', data: 'not base64!' }] }],
      /base64/,
    ],
    [
      'session:send',
      'an image too large',
      [
        'a',
        {
          id: 'm',
          text: 'Hi',
          images: [
            { mediaType: 'image/png', data: 'A'.repeat(Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4) },
          ],
        },
      ],
      /too large/,
    ],
    [
      'session:send',
      'images too large together',
      [
        'a',
        {
          id: 'm',
          text: 'Hi',
          // Each under the limit for one, five over the limit for a message's images together.
          images: Array.from({ length: 5 }, () => ({
            mediaType: 'image/png',
            data: 'A'.repeat(Math.ceil((MAX_IMAGE_TOTAL / 5 + 3) / 3) * 4),
          })),
        },
      ],
      /together/,
    ],
    [
      'session:send',
      'too many images',
      [
        'a',
        {
          id: 'm',
          text: 'Hi',
          images: Array.from({ length: MAX_IMAGES + 1 }, () => ({
            mediaType: 'image/png',
            data: 'AAAA',
          })),
        },
      ],
      /at most/,
    ],
    [
      'session:send',
      'an image with a path',
      [
        'a',
        { id: 'm', text: 'Hi', images: [{ mediaType: 'image/png', data: 'AAAA', path: '/x' }] },
      ],
      /an image/,
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
    ['session:fresh', 'no agent', [], /an agent and an adapter/],
    ['session:fresh', 'no adapter', ['a'], /an agent and an adapter/],
    ['session:fresh', 'an empty agent id', ['', 'codex'], /agent's id/],
    ['session:fresh', 'a non-text agent id', [12, 'codex'], /agent's id/],
    [
      'session:fresh',
      'an oversized agent id',
      ['a'.repeat(MAX_ID_LENGTH + 1), 'codex'],
      /agent's id/,
    ],
    ['session:fresh', 'an unknown adapter', ['a', 'other'], /adapter/],
    ['session:fresh', 'an old adapter id', ['a', 'claude'], /adapter/],
    ['session:fresh', 'a non-text adapter', ['a', {}], /adapter/],
    ['session:fresh', 'an extra argument', ['a', 'codex', 'extra'], /an agent and an adapter/],
    ['session:mode', 'an unknown mode', ['a', 'default'], /mode/],
    ['session:model', 'a model that is not text', ['a', 42], /model/],
    ['session:list', 'no agent', [], /an agent/],
    [
      'session:answer',
      'an MCP answer not offered',
      ['a', 'p', { kind: 'elicitation', action: 'maybe' }],
      /answer to an MCP server/,
    ],
    [
      'session:answer',
      'a form value that is an object',
      ['a', 'p', { kind: 'elicitation', action: 'accept', values: { repo: { path: '/' } } }],
      /form’s values/,
    ],
    [
      'session:answer',
      'a form with too many values',
      [
        'a',
        'p',
        {
          kind: 'elicitation',
          action: 'accept',
          values: Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`f${String(i)}`, 'x'])),
        },
      ],
      /form’s values/,
    ],
    ['session:mcp', 'no agent', [], /an agent/],
    ['session:rewind-preview', 'no message', ['a'], /an agent and a message/],
    ['session:rewind-preview', 'an empty message id', ['a', ''], /message's id/],
    ['session:rewind', 'nothing to restore', ['a', 'm1'], /what to restore/],
    ['session:rewind', 'something else to restore', ['a', 'm1', 'everything'], /thing to restore/],
    ['session:mcp-change', 'an unknown change', ['a', 'github', 'delete'], /change to an MCP/],
    ['session:mcp-change', 'no server', ['a', '', 'reconnect'], /MCP server’s name/],
    [
      'session:mcp-change',
      'a server name with control characters',
      ['a', 'git\nhub', 'reconnect'],
      /MCP server’s name/,
    ],
    ['session:resume', 'no conversation', ['a'], /an agent and a conversation/],
    ['session:resume', 'a path', ['a', '../../etc/passwd'], /conversation's id/],
    [
      'session:resume',
      'a CLI option',
      ['a', '--dangerously-skip-permissions'],
      /conversation's id/,
    ],
    ['session:resume', 'a non-UUID id', ['a', 'session-1'], /conversation's id/],
    [
      'session:resume',
      'a UUID followed by a newline',
      ['a', '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e11\n'],
      /conversation's id/,
    ],
    ['session:resume', 'an id too long', ['a', 'a'.repeat(MAX_ID_LENGTH + 1)], /conversation's id/],
    ['session:stopTask', 'a task that is not named', ['a', ''], /task's id/],
    ['session:stopTask', 'a very long task id', ['a', 't'.repeat(MAX_ID_LENGTH + 1)], /task's id/],
    [
      'session:answer',
      'what to do instead, with a yes',
      ['a', 'p', { kind: 'permission', answer: 'once', feedback: 'Go' }],
      /only with a no/,
    ],
    [
      'session:answer',
      'what to do instead, too long',
      [
        'a',
        'p',
        { kind: 'permission', answer: 'deny', feedback: 'x'.repeat(MAX_ANSWER_LENGTH + 1) },
      ],
      /what to do instead/,
    ],
    ['session:options', 'no adapter', [], /an adapter/],
    ['session:options', 'an adapter corrallm does not run', ['gemini'], /adapter/],
    ['session:options', 'an old adapter id', ['claude'], /adapter/],
    ['session:options', 'a folder as well', ['claude-code', '/etc'], /an adapter/],
    ['session:effort', 'no effort', ['a'], /an agent and a reasoning effort/],
    ['session:effort', 'an effort that is not a word', ['a', 'high; rm -rf'], /reasoning effort/],
    ['session:effort', 'an effort that is not text', ['a', 3], /reasoning effort/],
    [
      'session:start',
      'an effort that is not a word',
      ['a', { connection: 'codex.app-server', model: null, mode: 'auto', effort: '--yolo' }],
      /reasoning effort/,
    ],
  ])('%s rejects %s', (channel, _label, args, message) => {
    expect(() => invoke(channel, args)).toThrow(message);
    expect(Object.values(services.sessions).every((fn) => fn.mock.calls.length === 0)).toBe(true);
    expect(services.links.open).not.toHaveBeenCalled();
    expect(services.reveal.reveal).not.toHaveBeenCalled();
  });
});

describe('terminal:* handlers', () => {
  it('pass checked arguments on, for the renderer that sent them', async () => {
    const sender = {};
    await invoke('terminal:attach', ['a'], sender);
    expect(services.sessions.attachTerminal).toHaveBeenCalledWith(CANVAS, 'a');
    // Keystrokes are keys: control characters included.
    await invoke('terminal:input', ['a', '\x1b[Z\x03'], sender);
    expect(services.sessions.inputTerminal).toHaveBeenCalledWith(CANVAS, 'a', '\x1b[Z\x03');
    await invoke('terminal:resize', ['a', 120, 40], sender);
    expect(services.sessions.resizeTerminal).toHaveBeenCalledWith(CANVAS, 'a', 120, 40);
    await invoke('terminal:detach', ['a'], sender);
    expect(services.sessions.detachTerminal).toHaveBeenCalledWith(CANVAS, 'a');
    // The paths of files dropped (as the preload read them), checked: main sees if they are there.
    await invoke('terminal:drop', ['a', ['/Users/me/Screen Shot.png']], sender);
    expect(services.sessions.dropOnTerminal).toHaveBeenCalledWith(CANVAS, 'a', [
      '/Users/me/Screen Shot.png',
    ]);
  });

  it.each([
    ['terminal:attach', 'no agent', [], /an agent/],
    ['terminal:attach', 'an agent id that is not text', [{}], /agent's id/],
    ['terminal:input', 'nothing typed', ['a', ''], /what was typed/],
    ['terminal:input', 'keys that are not text', ['a', [13]], /what was typed/],
    [
      'terminal:input',
      'too much at once',
      ['a', 'x'.repeat(MAX_TERMINAL_INPUT + 1)],
      /what was typed/,
    ],
    ['terminal:resize', 'no size', ['a'], /an agent and a size/],
    ['terminal:resize', 'a fractional size', ['a', 80.5, 24], /terminal size/],
    ['terminal:resize', 'no rows', ['a', 80, 0], /terminal size/],
    ['terminal:resize', 'a size too large', ['a', 100_000, 24], /terminal size/],
    ['terminal:resize', 'a size that is not a number', ['a', '80', 24], /terminal size/],
    ['terminal:detach', 'an extra argument', ['a', 'b'], /an agent/],
    ['terminal:drop', 'no files', ['a', []], /files dropped/],
    ['terminal:drop', 'a path that is not a list', ['a', '/Users/me/a.png'], /files dropped/],
    [
      'terminal:drop',
      'too many files',
      ['a', Array.from({ length: MAX_DROPPED_FILES + 1 }, (_, i) => `/f${String(i)}`)],
      /files dropped/,
    ],
    ['terminal:drop', 'a relative path', ['a', ['shot.png']], /path of a file/],
    ['terminal:drop', 'a path with a line break', ['a', ['/a\n/b.png']], /path of a file/],
    ['terminal:drop', 'a path that is not text', ['a', [42]], /path of a file/],
    [
      'terminal:drop',
      'a path too long',
      ['a', [`/${'x'.repeat(MAX_DROPPED_PATH)}`]],
      /path of a file/,
    ],
  ])('%s rejects %s', (channel, _label, args, message) => {
    expect(() => invoke(channel, args)).toThrow(message);
    expect(Object.values(services.sessions).every((fn) => fn.mock.calls.length === 0)).toBe(true);
    expect(services.links.open).not.toHaveBeenCalled();
    expect(services.reveal.reveal).not.toHaveBeenCalled();
  });
});

describe('session:clis', () => {
  it('says which agents the user has, by adapter, and takes no arguments', async () => {
    await expect(invoke('session:clis', [])).resolves.toEqual({
      'claude-code': true,
      codex: false,
    });
    expect(() => invoke('session:clis', ['claude-code'])).toThrow(/no arguments/);
  });
});

describe('usage:* handlers', () => {
  it('pass checked arguments on', () => {
    expect(invoke('usage:get', [])).toEqual({ readings: [], rules: {} });
    const rule = { window: 'fiveHour', percent: 80, action: 'ask' };
    invoke('usage:rule', ['claude-code', rule]);
    expect(services.usage.setRule).toHaveBeenCalledWith('claude-code', rule);
    invoke('usage:rule', ['claude-code', null]);
    expect(services.usage.setRule).toHaveBeenLastCalledWith('claude-code', null);
    const resetsAt = Date.now() + 60 * 60 * 1000;
    invoke('usage:simulate', [
      'codex',
      { weekly: { usedPercent: 91, resetsAt, extra: 'dropped' }, other: {} },
    ]);
    expect(services.usage.simulate).toHaveBeenCalledWith('codex', {
      weekly: { usedPercent: 91, resetsAt },
    });
    invoke('usage:simulate', ['claude-code', null]);
    expect(services.usage.simulate).toHaveBeenLastCalledWith('claude-code', null);
  });

  it.each([
    ['usage:get', 'an argument', ['claude-code'], /no arguments/],
    ['usage:rule', 'no rule', ['claude-code'], /a backend and a rule/],
    ['usage:rule', 'a backend corrallm reads no usage of', ['gemini', null], /Expected one of/],
    ['usage:rule', 'an old backend id', ['Claude', null], /Expected one of/],
    [
      'usage:rule',
      'a share out of range',
      ['claude-code', { window: 'weekly', percent: 100, action: 'ask' }],
      /1 to 99/,
    ],
    [
      'usage:rule',
      'an action not built yet',
      ['claude-code', { window: 'weekly', percent: 80, action: 'nextBackend' }],
      /Expected one of/,
    ],
    ['usage:simulate', 'no windows', ['claude-code'], /a backend and its windows/],
    [
      'usage:simulate',
      'a share over 100',
      ['claude-code', { fiveHour: { usedPercent: 150, resetsAt: null } }],
      /from 0 to 100/,
    ],
    [
      'usage:simulate',
      'a reset too far ahead',
      ['claude-code', { fiveHour: { usedPercent: 50, resetsAt: Date.now() + 30 * 86_400_000 } }],
      /reset/,
    ],
  ])('%s rejects %s', (channel, _label, args, message) => {
    expect(() => invoke(channel, args)).toThrow(message);
    expect(services.usage.setRule).not.toHaveBeenCalled();
    expect(services.usage.simulate).not.toHaveBeenCalled();
  });
});

describe('run journal channels', () => {
  const checkpoint = { version: 2, workflow: '{}', state: '{}', messages: '[]', updatedAt: 1 };
  it('uses the sender’s canvas and generation token, never a renderer-supplied path', async () => {
    const sender = { id: 7 };
    await expect(invoke('run:get', [], sender)).resolves.toMatchObject({ token: 'canvas-token' });
    await invoke('run:save', ['canvas-token', checkpoint], sender);
    expect(services.runs.save).toHaveBeenCalledWith(CANVAS, 'canvas-token', checkpoint);
    // The shutdown handshake is the window's.
    await invoke('run:ready', ['request', null], sender);
    expect(services.shutdown.ready).toHaveBeenCalledWith(sender, 'request', null);
  });
  it.each([
    ['run:get', ['/a/path']],
    ['run:save', []],
    ['run:save', ['t', { ...checkpoint, file: '/a/path' }]],
    ['run:save', ['t', { ...checkpoint, state: 'broken' }]],
    ['run:ready', ['request']],
  ])('rejects invalid %s arguments', (channel, args) => {
    expect(() => invoke(channel, args as unknown[])).toThrow();
    expect(services.runs.save).not.toHaveBeenCalled();
  });
  it('surfaces a journal write error to the renderer', async () => {
    services.runs.save.mockRejectedValue(new Error('Disk full'));
    await expect(invoke('run:save', ['canvas-token', checkpoint])).rejects.toThrow('Disk full');
  });
});
