import { beforeEach, describe, expect, it, vi } from 'vitest';

import { newCanvasId } from '../../shared/canvas';
import { MAX_ANSWER_LENGTH, MAX_ID_LENGTH } from '../../shared/session';
import { Channels } from './channels';
import type { ChannelServices } from './channels';

/** The canvas the sender's window shows, as the window map says. */
const CANVAS = newCanvasId();

/** What the handlers act on, faked: every call is recorded. */
function fakeServices() {
  const own = { answered: vi.fn(), applied: vi.fn() };
  return {
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
            } as never)
          : undefined,
      ),
    },
    sessions: {
      availability: vi
        .fn<ChannelServices['sessions']['availability']>()
        .mockResolvedValue({ ready: true }),
      answer: vi.fn<ChannelServices['sessions']['answer']>().mockResolvedValue(undefined),
      interrupt: vi.fn<ChannelServices['sessions']['interrupt']>().mockResolvedValue(undefined),
      setMode: vi.fn<ChannelServices['sessions']['setMode']>().mockResolvedValue(undefined),
      setModel: vi.fn<ChannelServices['sessions']['setModel']>().mockResolvedValue(undefined),
      setEffort: vi.fn<ChannelServices['sessions']['setEffort']>().mockResolvedValue(undefined),
      stopTask: vi.fn<ChannelServices['sessions']['stopTask']>().mockResolvedValue(undefined),
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
    // The agent window's own are its operations since B11 X13: message, session.viewCommand,
    // withdraw, session.conversations/resumeConversation/options/mcpServers/changeMcpServer.
    'session:send',
    'session:record',
    'session:unqueue',
    'session:list',
    'session:resume',
    'session:options',
    'session:mcp',
    'session:mcp-change',
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
  it.each([{ channel: 'session:interrupt', args: ['a'], action: 'interrupt' }] as const)(
    '$channel acts on it once its window has it',
    async ({ channel, args, action }) => {
      const sender = 7;
      const shown = Promise.withResolvers<typeof CANVAS>();
      services.windows.canvasOf.mockReturnValue(shown.promise);
      const called = services.sessions[action];
      const result = Promise.resolve(invoke(channel, [...args], sender)).then(
        (value: unknown) => ({ value }),
        (error: unknown) => ({ error }),
      );
      expect(services.windows.canvasOf).toHaveBeenCalledWith(sender);
      expect(called).not.toHaveBeenCalled();
      shown.resolve(CANVAS);
      expect(await result).toEqual({ value: null });
      expect(called).toHaveBeenCalledOnce();
      expect(called.mock.calls[0]).toContain(CANVAS);
    },
  );
});

describe('session:* handlers', () => {
  it('pass checked arguments on, for the renderer that sent them', async () => {
    const sender = 7;
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
    expect(await invoke('session:availability', ['a'], sender)).toEqual({ ready: true });
    expect(services.sessions.availability).toHaveBeenCalledExactlyOnceWith(CANVAS, 'a');
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
    // A change its CLI refused tells the core's session nothing.
    services.sessions.answer.mockRejectedValueOnce(new Error('No such prompt'));
    await expect(invoke('session:answer', ['a', 'p2', permission])).rejects.toThrow(
      'No such prompt',
    );
    expect(services.own.answered).toHaveBeenCalledOnce();
  });

  it.each([
    // A window runs no queue: no message of its is the run's work (B11 Design §8).
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
    ['session:effort', 'no effort', ['a'], /an agent and a reasoning effort/],
    ['session:effort', 'an effort that is not a word', ['a', 'high; rm -rf'], /reasoning effort/],
    ['session:effort', 'an effort that is not text', ['a', 3], /reasoning effort/],
  ])('%s rejects %s', (channel, _label, args, message) => {
    expect(() => invoke(channel, args)).toThrow(message);
    expect(Object.values(services.sessions).every((fn) => fn.mock.calls.length === 0)).toBe(true);
    expect(services.windows.canvasOf).not.toHaveBeenCalled();
  });
});
