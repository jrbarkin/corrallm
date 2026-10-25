import { beforeEach, describe, expect, it, vi } from 'vitest';

import { newCanvasId } from '../../shared/canvas';
import { MAX_IMAGE_BYTES, MAX_IMAGE_TOTAL, MAX_IMAGES } from '../../shared/api/limits';
import { MAX_ANSWER_LENGTH, MAX_ID_LENGTH, MAX_MESSAGE_LENGTH } from '../../shared/session';
import { Channels } from './channels';
import type { ChannelServices } from './channels';
import { CATALOG } from '../sessions/adapters';

/** The canvas the sender's window shows, as the window map says. */
const CANVAS = newCanvasId();

/** What the handlers act on, faked: every call is recorded. */
function fakeServices() {
  const delivery = {
    send: vi.fn().mockResolvedValue({ id: 'kept' }),
    withdraw: vi.fn().mockResolvedValue({ reached: false, interrupted: false }),
  };
  const messages = { get: vi.fn() };
  const own = { answered: vi.fn(), applied: vi.fn(), resumed: vi.fn() };
  return {
    catalog: CATALOG,
    delivery,
    messages,
    windows: {
      canvasOf: vi.fn<ChannelServices['windows']['canvasOf']>().mockResolvedValue(CANVAS),
      showing: vi.fn<ChannelServices['windows']['showing']>().mockReturnValue([7]),
      gone: vi.fn<ChannelServices['windows']['gone']>().mockResolvedValue(undefined),
    },
    /** The core's own sessions of the canvas it runs, which hear what a channel changed. */
    own,
    engines: {
      canvas: vi.fn((canvas: string) =>
        canvas === CANVAS
          ? ({
              engine: { sessions: own },
              document: { nodes: [{ id: 'a', type: 'agent' }] },
              delivery,
              messages,
            } as never)
          : undefined,
      ),
    },
    sessions: {
<<<<<<< HEAD
=======
      availability: vi
        .fn<ChannelServices['sessions']['availability']>()
        .mockResolvedValue({ ready: true }),
      start: vi.fn<ChannelServices['sessions']['start']>().mockResolvedValue(undefined),
>>>>>>> origin/main
      send: vi.fn<ChannelServices['sessions']['send']>().mockResolvedValue(undefined),
      answer: vi.fn<ChannelServices['sessions']['answer']>().mockResolvedValue(undefined),
      interrupt: vi.fn<ChannelServices['sessions']['interrupt']>().mockResolvedValue(undefined),
      setMode: vi.fn<ChannelServices['sessions']['setMode']>().mockResolvedValue(undefined),
      setModel: vi.fn<ChannelServices['sessions']['setModel']>().mockResolvedValue(undefined),
      setEffort: vi.fn<ChannelServices['sessions']['setEffort']>().mockResolvedValue(undefined),
      stopTask: vi.fn<ChannelServices['sessions']['stopTask']>().mockResolvedValue(undefined),
      listSessions: vi.fn<ChannelServices['sessions']['listSessions']>().mockResolvedValue([]),
      resumeSession: vi
        .fn<ChannelServices['sessions']['resumeSession']>()
        .mockResolvedValue(undefined),
      mcpServers: vi.fn<ChannelServices['sessions']['mcpServers']>().mockResolvedValue([]),
      changeMcpServer: vi
        .fn<ChannelServices['sessions']['changeMcpServer']>()
        .mockResolvedValue([]),
      settingsOptions: vi.fn<ChannelServices['sessions']['settingsOptions']>().mockResolvedValue({
        models: [],
        defaults: { model: null, effort: null, mode: null },
      }),
    },
  };
}

let services: ReturnType<typeof fakeServices>;

let channels: Channels;

/** Calls a channel as the window its port was handed to, never one named in its arguments. */
function invoke(name: string, args: unknown[], sender = 7) {
  return channels.call(sender, name, args);
}

beforeEach(() => {
  services = fakeServices();
  channels = new Channels(services);
});

describe('the channel surface', () => {
  it.each([
    'core:connect',
    // A canvas's file, folder and document are operations' (canvas.open, canvas.save,
    // canvas.saveAs, canvas.create, project.choose): no channel commits or saves a page's text.
    'canvas:open',
    'canvas:save',
    'canvas:forget',
    'project:choose',
    'usage:get',
    'usage:rule',
    'usage:simulate',
    'catalog:get',
    'session:clis',
    'link:open',
    'link:reveal',
    'terminal:attach',
    'terminal:detach',
    'terminal:input',
    'terminal:resize',
    'terminal:drop',
    'toString',
    '__proto__',
    'unknown',
    // A canvas's run is the core's (B11 Design §8): no window reads, saves or freezes one, and no
    // window starts, ends or replaces a session but through the session's operations.
    'run:get',
    'run:save',
    'run:ready',
    'session:start',
    'session:close',
    'session:fresh',
    'session:rewind-preview',
    'session:rewind',
  ])('refuses %s', (name) => {
    expect(() => invoke(name, [])).toThrow(/no channel/);
    expect(services.windows.canvasOf).not.toHaveBeenCalled();
  });

  it('refuses arguments that are not a tuple before running a parser or handler', () => {
    expect(() => channels.call(7, 'session:interrupt', null as never)).toThrow(/arguments/);
    expect(services.windows.canvasOf).not.toHaveBeenCalled();
    expect(services.sessions.interrupt).not.toHaveBeenCalled();
  });
});

describe('the sender’s canvas', () => {
  it.each([
    { channel: 'session:send', args: ['a', { id: 'm', text: 'Hi' }], action: 'send' },
    { channel: 'session:interrupt', args: ['a'], action: 'interrupt' },
  ] as const)('$channel acts on it once its window has it', async ({ channel, args, action }) => {
    const sender = 7;
    const shown = Promise.withResolvers<typeof CANVAS>();
    services.windows.canvasOf.mockReturnValue(shown.promise);
    const called = action === 'send' ? services.delivery.send : services.sessions[action];
    const result = Promise.resolve(invoke(channel, [...args], sender)).then(
      (value: unknown) => ({ value }),
      (error: unknown) => ({ error }),
    );
    expect(services.windows.canvasOf).toHaveBeenCalledWith(sender);
    expect(called).not.toHaveBeenCalled();
    shown.resolve(CANVAS);
    expect(await result).toEqual({ value: action === 'send' ? { id: 'kept' } : null });
    expect(called).toHaveBeenCalledOnce();
    if (action === 'send') expect(services.engines.canvas).toHaveBeenCalledWith(CANVAS);
    else expect(called.mock.calls[0]).toContain(CANVAS);
  });
});

describe('session:* handlers', () => {
  it('checks the platform’s native-id minimum before dispatch, leaving the adapter’s shape to the manager', async () => {
    await invoke('session:resume', ['a', 's'.repeat(128)]);
    expect(services.sessions.resumeSession).toHaveBeenCalledExactlyOnceWith(
      CANVAS,
      'a',
      's'.repeat(128),
      'window:7',
    );
    for (const id of ['--resume', 's'.repeat(129), 's\n']) {
      expect(() => invoke('session:resume', ['a', id])).toThrow(/conversation's id/);
    }
    expect(services.sessions.resumeSession).toHaveBeenCalledOnce();
  });
  it('pass checked arguments on, for the renderer that sent them', async () => {
    const sender = 7;
    await invoke('session:send', ['a', { id: 'm1', text: 'Hi' }], sender);
    expect(services.delivery.send).toHaveBeenCalledWith('you', 'a', 'Hi', undefined, {
      images: undefined,
      told: 'manual-channel:m1',
    });
    // A pasted image may be all a message is.
    const image = { mediaType: 'image/png', data: 'iVBORw0KGgo=' };
    await invoke('session:send', ['a', { id: 'm2', text: '', images: [image] }], sender);
    expect(services.delivery.send).toHaveBeenLastCalledWith('you', 'a', '', undefined, {
      images: [image],
      told: 'manual-channel:m2',
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
    expect(services.delivery.send).toHaveBeenLastCalledWith('you', 'a', 'Four', undefined, {
      images,
      told: 'manual-channel:m3',
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
    const form = { kind: 'elicitation', action: 'accept', values: { repo: 'acme/shop', n: 2 } };
    await invoke('session:answer', ['a', 'e1', form], sender);
    expect(services.sessions.answer).toHaveBeenLastCalledWith(CANVAS, 'a', 'e1', form);
    await invoke('session:answer', ['a', 'e2', { kind: 'elicitation', action: 'decline' }], sender);
    expect(services.sessions.answer).toHaveBeenLastCalledWith(CANVAS, 'a', 'e2', {
      kind: 'elicitation',
      action: 'decline',
    });
    await invoke('session:mcp', ['a'], sender);
    expect(services.sessions.mcpServers).toHaveBeenCalledWith(CANVAS, 'a');
    await invoke('session:mcp-change', ['a', 'github', 'reconnect'], sender);
    expect(services.sessions.changeMcpServer).toHaveBeenCalledWith(
      CANVAS,
      'a',
      'github',
      'reconnect',
    );
    // Listed for the window that asked, the one caller that may then open what it lists.
    await invoke('session:list', ['a'], sender);
    expect(services.sessions.listSessions).toHaveBeenCalledWith(CANVAS, 'a', 'window:7');
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
      'window:7',
    );
  });

  it('tells the core’s own session what a window’s channel changed of it, once its CLI took it', async () => {
    const permission = { kind: 'permission', answer: 'once' } as const;
    await invoke('session:answer', ['a', 'p1', permission]);
    expect(services.own.answered).toHaveBeenCalledExactlyOnceWith('a', 'p1', permission);
    await invoke('session:mode', ['a', 'plan']);
    expect(services.own.applied).toHaveBeenLastCalledWith('a', { mode: 'plan' });
    await invoke('session:model', ['a', 'opus']);
    expect(services.own.applied).toHaveBeenLastCalledWith('a', { model: 'opus' });
    await invoke('session:effort', ['a', null]);
    expect(services.own.applied).toHaveBeenLastCalledWith('a', { effort: null });
    const conversation = '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e11';
    await invoke('session:resume', ['a', conversation]);
    expect(services.own.resumed).toHaveBeenCalledExactlyOnceWith('a');
    // A change its CLI refused tells the core's session nothing.
    services.sessions.answer.mockRejectedValueOnce(new Error('No such prompt'));
    await expect(invoke('session:answer', ['a', 'p2', permission])).rejects.toThrow(
      'No such prompt',
    );
    expect(services.own.answered).toHaveBeenCalledOnce();
  });

  it.each([
    ['session:send', 'a message without text', ['a', { id: 'm' }], /text/],
    ['session:send', 'a blank message', ['a', { id: 'm', text: '  ' }], /text/],
    ['session:send', 'a message without an id', ['a', { text: 'Hi' }], /message's id/],
    // A window runs no queue: no message of its is the run's work (B11 Design §8).
    [
      'session:send',
      'a task of the run',
      ['a', { id: 'm', text: 'Work', task: { agent: 'a', item: 'i', attempt: 't' } }],
      /message/,
    ],
    [
      'session:send',
      'a queue origin',
      [
        'a',
        { id: 'm', text: 'Work', origin: 'queue', task: { agent: 'a', item: 'i', attempt: 't' } },
      ],
      /message/,
    ],
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
    ['session:interrupt', 'an extra argument', ['a', 'b'], /an agent/],
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
    [
      'session:resume',
      'an id outside the platform minimum',
      ['a', 'session!1'],
      /conversation's id/,
    ],
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
    ['session:options', 'a folder as well', ['claude-code', 'a', '/etc'], /an adapter/],
    ['session:effort', 'no effort', ['a'], /an agent and a reasoning effort/],
    ['session:effort', 'an effort that is not a word', ['a', 'high; rm -rf'], /reasoning effort/],
    ['session:effort', 'an effort that is not text', ['a', 3], /reasoning effort/],
  ])('%s rejects %s', (channel, _label, args, message) => {
    expect(() => invoke(channel, args)).toThrow(message);
    expect(Object.values(services.sessions).every((fn) => fn.mock.calls.length === 0)).toBe(true);
    expect(services.windows.canvasOf).not.toHaveBeenCalled();
  });
});

it('takes back only a manual message to the named agent on the sender window canvas', async () => {
  const id = crypto.randomUUID();
  services.messages.get.mockReturnValue({ id, from: 'you', to: 'agent:a' });
  expect(await invoke('session:unqueue', ['a', id])).toBeNull();
  expect(services.delivery.withdraw).toHaveBeenCalledExactlyOnceWith(id, 'you');
  for (const message of [
    { id, from: 'you', to: 'agent:b' },
    { id, from: 'outside:bot', to: 'agent:a' },
    undefined,
  ]) {
    services.messages.get.mockReturnValue(message);
    await expect(invoke('session:unqueue', ['a', id])).rejects.toThrow(/manual message/);
  }
  expect(services.delivery.withdraw).toHaveBeenCalledOnce();
  expect(() => invoke('session:unqueue', ['a', 'not-a-message'])).toThrow();
});

it('validates a view-handled command before recording anything', async () => {
  for (const args of [
    [],
    ['a'],
    ['a', { id: 'm', text: 'x', cwd: '/' }],
    ['a', { id: 'm', text: 'x'.repeat(MAX_MESSAGE_LENGTH + 1) }],
  ]) {
    await expect(Promise.resolve().then(() => invoke('session:record', args))).rejects.toThrow();
  }
  expect(services.engines.canvas).not.toHaveBeenCalled();
  expect(services.delivery.send).not.toHaveBeenCalled();
});
