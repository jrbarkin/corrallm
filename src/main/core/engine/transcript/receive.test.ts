import { describe, expect, it, vi } from 'vitest';

import type { ConnectionId } from '../../../../shared/adapter';
import type { SessionEvent } from '../../../../shared/session';
import { fakeBackend } from '../test-backend';
import { MADE_UP } from '../../../../shared/test-made-up';
import { rewindPointsOf } from '../../../../shared/model/session';
import type { Refusal } from '../../../../shared/model/session';
import { SessionStore } from '../delivery/mailbox';
import { engineCatalog } from '../../../../shared/model/catalog';
import { TEST_ENGINE } from '../test-engine';

/** The run's catalog, as the app gives the sessions. */
const engine = TEST_ENGINE;

/** Lets pending promises (IPC replies) settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A store with agent `a` connected through the Agent SDK, and the backend it talks to. */
function connected(connection: ConnectionId = 'claude-code.sdk') {
  const fake = fakeBackend();
  const store = new SessionStore(engine, fake.backend);
  store.sync([{ id: 'a', connection }]);
  return { store, ...fake };
}

const end = (messages: string[], extra: Partial<Extract<SessionEvent, { type: 'end' }>> = {}) =>
  ({
    type: 'end',
    messages,
    seconds: 3,
    result: { status: 'completed', reason: 'completed' },
    ...extra,
  }) as const;

describe('a connected session', () => {
  it('retains prompt-reply provenance when restoring a native transcript', async () => {
    const { store, emit } = connected('codex.app-server');
    store.open('a');
    await settle();
    emit('a', 'codex.app-server', {
      type: 'history',
      events: [{ type: 'user', id: 'reply', text: 'private-revision', promptReply: true }],
    });
    expect(store.of('a').entries).toContainEqual(
      expect.objectContaining({
        id: 'reply',
        kind: 'user',
        text: 'private-revision',
        promptReply: true,
      }),
    );
  });

  it('starts when its view opens, and takes the models it offers', async () => {
    const { store, backend, emit } = connected();
    store.open('a');
    store.open('a');
    expect(backend.start).toHaveBeenCalledOnce();
    // Nothing set: the user's own defaults.
    expect(backend.start).toHaveBeenCalledWith('a', {
      connection: 'claude-code.sdk',
      model: null,
      mode: null,
    });
    const models = [
      { value: 'opus', label: 'Opus' },
      { value: 'haiku', label: 'Haiku' },
    ];
    emit('a', 'claude-code.sdk', {
      type: 'started',
      role: 'append',
      resume: true,
      list: true,
      model: 'opus',
      mode: 'acceptEdits',
      models,
    });
    expect(store.of('a')).toMatchObject({ models, model: 'opus', mode: 'acceptEdits' });
    await settle();
  });

  it('starts with what the agent is set to in its CLI, as the canvas says, and says so', async () => {
    const { store, backend } = connected();
    store.sync([
      {
        id: 'a',
        connection: 'claude-code.sdk',
        settings: {
          'claude-code': { model: 'haiku', effort: 'low', mode: 'plan' },
          codex: { model: 'gpt-6-luna', mode: 'read-only' },
        },
      },
    ]);
    // A model the user picked before the session started is not what it is set to: not passed on.
    store.setModel('a', 'Opus 5.5');
    store.open('a');
    expect(backend.start).toHaveBeenLastCalledWith('a', {
      connection: 'claude-code.sdk',
      model: 'haiku',
      mode: 'plan',
      effort: 'low',
    });
    await settle();
    // What its running session started with, for its settings to tell apart from what they are.
    expect(store.of('a').running).toEqual({ model: 'haiku', effort: 'low', mode: 'plan' });

    // Its Codex settings, once it runs Codex.
    store.sync([
      {
        id: 'a',
        connection: 'codex.app-server',
        settings: { codex: { model: 'gpt-6-luna', mode: 'read-only' } },
      },
    ]);
    store.open('a');
    expect(backend.start).toHaveBeenLastCalledWith('a', {
      connection: 'codex.app-server',
      model: 'gpt-6-luna',
      mode: 'read-only',
    });
    await settle();
  });

  it('restarts its session with what it is set to now, resuming its conversation', async () => {
    const { store, backend, emit } = connected();
    store.sync([
      {
        id: 'a',
        connection: 'claude-code.terminal',
        settings: { 'claude-code': { model: 'haiku' } },
      },
    ]);
    store.open('a');
    await settle();
    emit('a', 'claude-code.terminal', {
      type: 'started',
      role: 'append',
      resume: true,
      list: true,
      model: 'haiku',
      mode: 'manual',
      models: [],
    });
    store.sync([
      {
        id: 'a',
        connection: 'claude-code.terminal',
        settings: { 'claude-code': { model: 'sonnet' } },
      },
    ]);
    // Settings changed: the session runs on as it started, until restarted.
    expect(backend.start).toHaveBeenCalledOnce();
    expect(store.of('a').running).toEqual({ model: 'haiku' });
    await store.restart('a');
    await settle();
    // Main ends it before it starts again (main resumes the conversation it remembers).
    expect(backend.close).toHaveBeenCalledWith('a');
    expect(backend.close.mock.invocationCallOrder[0] ?? 0).toBeLessThan(
      backend.start.mock.invocationCallOrder[1] ?? 0,
    );
    expect(backend.start).toHaveBeenLastCalledWith('a', {
      connection: 'claude-code.terminal',
      model: 'sonnet',
      mode: null,
    });
    expect(store.of('a').running).toEqual({ model: 'sonnet' });
    // A session that stopped by itself runs with nothing.
    emit('a', 'claude-code.terminal', { type: 'closed' });
    expect(store.of('a').running).toBeUndefined();
  });

  it('warns when it can’t hear the session’s replies, until a session that can starts', async () => {
    const { store, emit } = connected();
    store.sync([{ id: 'a', connection: 'claude-code.terminal' }]);
    store.open('a');
    const text =
      'Claude Code’s settings turn off its hooks (disableAllHooks in ~/.claude/settings.json).';
    emit('a', 'claude-code.terminal', {
      type: 'started',
      role: 'append',
      resume: true,
      list: true,
      model: null,
      mode: 'manual',
      models: [],
    });
    emit('a', 'claude-code.terminal', { type: 'unheard', text });
    expect(store.of('a').unheard).toBe(text);
    expect(store.of('a').entries.at(-1)).toMatchObject({ kind: 'notice', level: 'warning', text });
    // Started again, with the hooks back on: nothing more to say.
    emit('a', 'claude-code.terminal', {
      type: 'started',
      role: 'append',
      resume: true,
      list: true,
      model: null,
      mode: 'manual',
      models: [],
    });
    expect(store.of('a').unheard).toBeUndefined();
    await settle();
  });

  it('sends a message, streams the reply into the transcript, and hears when the turn ends', async () => {
    const { store, backend, emit, sent } = connected();
    const done = vi.fn<(interrupted: boolean) => void>();
    store.send('a', 'claude-code', 'Fix the bug', done);
    expect(store.of('a').status).toBe('working');
    await settle();
    const id = sent();
    expect(backend.send).toHaveBeenCalledWith('a', { id, text: 'Fix the bug' });

    emit(
      'a',
      'claude-code.sdk',
      { type: 'user', id, text: 'Fix the bug' },
      { type: 'thinking', id: 't', text: 'Look at ' },
      { type: 'thinking', id: 't', text: 'the code.' },
      { type: 'text', id: 'x', text: 'I’ll ' },
      { type: 'text', id: 'x', text: 'fix it.' },
      { type: 'tool', id: 'e', tool: 'Edit', summary: 'src/a.ts', status: 'running' },
      {
        type: 'tool',
        id: 'e',
        tool: 'Edit',
        summary: 'src/a.ts',
        status: 'done',
        detail: { kind: 'diff', added: 1, removed: 1, lines: [] },
      },
      { type: 'tool', id: 'sub', tool: 'Read', summary: 'b.ts', status: 'done', parent: 'agent-1' },
      { type: 'todos', id: 'todo', items: [{ text: 'Fix it', status: 'active' }] },
      { type: 'todos', id: 'todo', items: [{ text: 'Fix it', status: 'done' }] },
      {
        type: 'usage',
        usage: { costUsd: 0.02, context: null, contextTokens: 5000, contextWindow: 200_000 },
      },
    );
    expect(done).not.toHaveBeenCalled();
    emit('a', 'claude-code.sdk', end([id]));

    const { entries, status, usage } = store.of('a');
    expect(status).toBe('idle');
    expect(usage?.costUsd).toBe(0.02);
    expect(entries.map((e) => e.kind)).toEqual([
      'user',
      'thinking',
      'text',
      'tool',
      'tool',
      'todos',
      'end',
    ]);
    expect(entries[1]).toMatchObject({ kind: 'thinking', text: 'Look at the code.' });
    expect(entries[2]).toMatchObject({ kind: 'text', text: 'I’ll fix it.' });
    expect(entries[3]).toMatchObject({ status: 'done', detail: { kind: 'diff' } });
    expect(entries[4]).toMatchObject({ parent: 'agent-1' });
    expect(entries[5]).toMatchObject({ items: [{ status: 'done' }] });
    expect(entries[6]).toMatchObject({ kind: 'end', seconds: 3, interrupted: false });
    // Whoever sent it hears what the agent replied in the turn.
    expect(done).toHaveBeenCalledWith(false, 'I’ll fix it.', {
      status: 'completed',
      reason: 'completed',
    });
  });

  it('reads only its newest entries for a streamed word, however long its transcript', () => {
    // G2: a long session's every word was looked up from its transcript's first entry, and its
    // whole transcript rewritten through a callback per entry, for the newest entry of all.
    const { store, emit } = connected();
    store.open('a');
    const older = 2000;
    for (let i = 0; i < older; i++)
      emit('a', 'claude-code.sdk', { type: 'text', id: `older-${String(i)}`, text: 'Done.' });
    emit('a', 'claude-code.sdk', { type: 'thinking', id: 'thought', text: 'Hmm' });
    emit('a', 'claude-code.sdk', { type: 'text', id: 'reply', text: 'Working' });
    let visited = 0;
    const long = (array: unknown) => Array.isArray(array) && array.length > older;
    for (const name of [
      'find',
      'findIndex',
      'findLast',
      'findLastIndex',
      'map',
      'filter',
      'some',
    ] as const) {
      const { value: original } = Object.getOwnPropertyDescriptor(Array.prototype, name) as {
        value: (...args: unknown[]) => unknown;
      };
      vi.spyOn(Array.prototype, name).mockImplementation(function (
        this: unknown[],
        callback: (...args: unknown[]) => unknown,
        ...rest: unknown[]
      ) {
        if (!long(this)) return original.call(this, callback, ...rest);
        return original.call(
          this,
          (...args: unknown[]) => {
            visited += 1;
            return callback(...args);
          },
          ...rest,
        );
      } as never);
    }
    const words = 50;
    try {
      for (let word = 0; word < words; word++) {
        emit('a', 'claude-code.sdk', { type: 'text', id: 'reply', text: ` ${String(word)}` });
        emit('a', 'claude-code.sdk', { type: 'thinking', id: 'thought', text: ` ${String(word)}` });
      }
    } finally {
      vi.restoreAllMocks();
    }
    const { entries } = store.of('a');
    expect(entries).toHaveLength(older + 2);
    expect(entries.at(-2)).toMatchObject({ id: 'thought', kind: 'thinking' });
    expect(entries.at(-1)).toMatchObject({ id: 'reply', kind: 'text' });
    expect((entries.at(-2) as { text: string }).text).toMatch(/^Hmm 0 1 .* 49$/);
    expect((entries.at(-1) as { text: string }).text).toMatch(/^Working 0 1 .* 49$/);
    // A few entries a word, never its transcript's length.
    expect(visited).toBeLessThanOrEqual(2 * words * 6);
  });

  it('keeps an outgoing turn ahead of its queue while a preceding native message ends', async () => {
    const { store, backend, emit, sent } = connected();
    const done = vi.fn();
    store.send('a', 'claude-code', 'The user’s command', done);
    await settle();
    const id = sent();
    store.send('a', 'claude-code', 'After the command');
    // The backend sends a framed withdrawal note before this command, as its own CLI turn.
    emit(
      'a',
      'claude-code.sdk',
      { type: 'user', id: 'note', text: '[corrallm] An earlier instruction was withdrawn.' },
      end(['note']),
    );
    await settle();
    expect(store.of('a').status).toBe('working');
    expect(backend.send).toHaveBeenCalledTimes(1);
    expect(done).not.toHaveBeenCalled();
    expect(
      store
        .of('a')
        .entries.filter((entry) => entry.kind === 'user')
        .map(({ text }) => text),
    ).toEqual(['[corrallm] An earlier instruction was withdrawn.', 'The user’s command']);
    emit('a', 'claude-code.sdk', { type: 'user', id, text: 'The user’s command' }, end([id]));
    await settle();
    expect(backend.send).toHaveBeenLastCalledWith(
      'a',
      expect.objectContaining({ text: 'After the command' }),
    );
    expect(done).toHaveBeenCalledOnce();
  });

  it('shows the echoed text, with backend additions, while keeping the message’s images', async () => {
    const { store, emit, sent } = connected();
    const images = [{ mediaType: 'image/png' as const, data: 'aGVsbG8=' }];
    store.send('a', 'claude-code', 'New work', undefined, images);
    await settle();
    const text = '[corrallm] An earlier instruction was withdrawn.\n\nNew work';
    emit('a', 'claude-code.sdk', { type: 'user', id: sent(), text });
    expect(store.of('a').entries[0]).toMatchObject({ kind: 'user', text, images, reached: true });
  });

  it('tells whoever sent a message what the agent replied in its turn, not its subagents', async () => {
    const { store, emit, sent } = connected();
    const done = vi.fn<(interrupted: boolean, reply: string) => void>();
    store.send('a', 'claude-code', 'Is it fixed?', done);
    await settle();
    const id = sent();
    emit(
      'a',
      'claude-code.sdk',
      { type: 'user', id, text: 'Is it fixed?' },
      { type: 'text', id: 'x', text: 'Let me run the tests.' },
      { type: 'tool', id: 'agent-1', tool: 'Agent', summary: 'Run them', status: 'running' },
      { type: 'text', id: 'sub', text: 'All green.', parent: 'agent-1' },
      { type: 'text', id: 'y', text: 'Yes: all 12 pass.' },
    );
    // A message typed while it worked waits for the turn after.
    store.send('a', 'claude-code', 'Thanks');
    emit('a', 'claude-code.sdk', end([id]));
    expect(done).toHaveBeenCalledWith(false, 'Let me run the tests.\n\nYes: all 12 pass.', {
      status: 'completed',
      reason: 'completed',
    });
  });

  it('takes a message back: off the queue while it waits there, or interrupting its turn', async () => {
    const { store, backend, emit, sent } = connected();
    const first = vi.fn<(interrupted: boolean, reply: string) => void>();
    const second = vi.fn<(interrupted: boolean, reply: string) => void>();
    const third = vi.fn<(interrupted: boolean, reply: string) => void>();
    const takeFirst = store.send('a', 'claude-code', 'First', first);
    const takeSecond = store.send('a', 'claude-code', 'Second', second);
    const takeThird = store.send('a', 'claude-code', 'Third', third);
    await settle();
    takeThird();
    expect(store.of('a').queued.map((q) => q.text)).toEqual(['Second']);
    expect(third).toHaveBeenCalledWith(true, '', { status: 'cancelled', reason: 'taken-back' });
    expect(backend.interrupt).not.toHaveBeenCalled();

    // Once its turn has ended, there is nothing to take back.
    emit('a', 'claude-code.sdk', end([sent()]));
    takeFirst();
    await settle();
    expect(backend.interrupt).not.toHaveBeenCalled();
    // A queued message that has started since: its turn is interrupted.
    expect(backend.send.mock.calls.at(-1)?.[1].text).toBe('Second');
    takeSecond();
    await settle();
    expect(backend.interrupt).toHaveBeenCalledWith('a');
    emit(
      'a',
      'claude-code.sdk',
      end([sent()], { result: { status: 'cancelled', reason: 'interrupted' } }),
    );
    expect(first).toHaveBeenCalledWith(false, '', { status: 'completed', reason: 'completed' });
    expect(second).toHaveBeenCalledWith(true, '', { status: 'cancelled', reason: 'interrupted' });
  });

  it('queues messages sent while it works, and sends each once the turn before has ended', async () => {
    const { store, backend, emit, sent } = connected();
    store.send('a', 'claude-code', 'First');
    store.send('a', 'claude-code', 'Second');
    await settle();
    expect(backend.send).toHaveBeenCalledTimes(1);
    expect(store.of('a').queued.map((q) => q.text)).toEqual(['Second']);
    emit('a', 'claude-code.sdk', end([sent()]));
    await settle();
    expect(backend.send).toHaveBeenCalledTimes(2);
    expect(backend.send.mock.calls[1]?.[1].text).toBe('Second');
  });

  it('shows a message typed in its terminal, and a turn it started by itself', () => {
    const { store, emit } = connected();
    store.open('a');
    emit('a', 'claude-code.sdk', { type: 'user', id: 'typed', text: 'Hello from the terminal' });
    expect(store.of('a').status).toBe('working');
    expect(store.of('a').entries[0]).toEqual({
      id: 'typed',
      kind: 'user',
      text: 'Hello from the terminal',
      reached: true,
      // Of Claude Code's conversation, whichever of its connections the agent runs.
      conversation: 'claude-code',
    });
    emit('a', 'claude-code.sdk', end(['typed']));
    emit('a', 'claude-code.sdk', { type: 'status', status: 'working' });
    expect(store.of('a').status).toBe('working');
  });

  it('interrupts the turn in main; one not sent yet is just dropped', async () => {
    const { store, backend, emit, sent } = connected();
    const done = vi.fn<(interrupted: boolean) => void>();
    // Starting takes a while: stopped before the message goes, it never does.
    let started: (() => void) | undefined;
    backend.start.mockReturnValueOnce(
      new Promise((resolve) => {
        started = () => {
          resolve(null);
        };
      }),
    );
    store.send('a', 'claude-code', 'Never mind', done);
    store.stop('a');
    expect(done).toHaveBeenCalledWith(true, '', expect.objectContaining({ status: 'cancelled' }));
    expect(store.of('a').status).toBe('idle');
    started?.();
    await settle();
    expect(backend.send).not.toHaveBeenCalled();

    store.send('a', 'claude-code', 'Go');
    await settle();
    store.stop('a');
    await settle();
    expect(backend.interrupt).toHaveBeenCalledWith('a');
    emit(
      'a',
      'claude-code.sdk',
      end([sent()], { result: { status: 'cancelled', reason: 'interrupted' } }),
    );
    expect(store.of('a').entries.at(-1)).toMatchObject({ kind: 'end', interrupted: true });
  });

  it('switches mode and model in the running session', async () => {
    const { store, backend } = connected();
    store.open('a');
    await settle();
    store.setMode('a', 'plan');
    store.setModel('a', 'haiku');
    await settle();
    expect(backend.setMode).toHaveBeenCalledWith('a', 'plan');
    expect(backend.setModel).toHaveBeenCalledWith('a', 'haiku');
  });

  it('says why it could not start, and ends the turn as failed', async () => {
    const { store, backend } = connected();
    backend.start.mockRejectedValue(new Error('Choose a project folder first.'));
    const done = vi.fn<(interrupted: boolean) => void>();
    store.send('a', 'claude-code', 'Go', done);
    await settle();
    expect(done).toHaveBeenCalledWith(
      true,
      '',
      expect.objectContaining({
        status: 'failed',
        reason: 'start-failed',
        message: 'Choose a project folder first.',
      }),
    );
    const { entries, status } = store.of('a');
    expect(status).toBe('idle');
    expect(entries.slice(1)).toMatchObject([
      { kind: 'notice', level: 'error', text: 'Choose a project folder first.' },
      { kind: 'end', failed: true },
    ]);
  });

  it('says why it could not start once, however often its view opens', async () => {
    const { store, backend } = connected();
    backend.start.mockRejectedValue(new Error('Choose a project folder first.'));
    store.open('a');
    store.open('a');
    await settle();
    store.open('a');
    await settle();
    expect(store.of('a').entries).toMatchObject([
      { kind: 'notice', text: 'Choose a project folder first.' },
    ]);
  });

  it('ends its turn when main says the session stopped, and starts it again for the next message', async () => {
    const { store, backend, emit } = connected();
    const done = vi.fn<(interrupted: boolean) => void>();
    store.send('a', 'claude-code', 'Go', done);
    await settle();
    emit('a', 'claude-code.sdk', { type: 'closed', error: 'Claude Code exited (code 1)' });
    expect(done).toHaveBeenCalledWith(true, '', {
      status: 'failed',
      reason: 'connection-closed',
      message: 'Claude Code exited (code 1)',
    });
    expect(store.of('a').entries.slice(1)).toMatchObject([
      { kind: 'notice', level: 'error', text: 'Claude Code exited (code 1)' },
      { kind: 'end', failed: true },
    ]);
    store.send('a', 'claude-code', 'Again');
    await settle();
    expect(backend.start).toHaveBeenCalledTimes(2);
  });

  it('hears only its own connection: another one’s late words are dropped', async () => {
    const { store, emit } = connected();
    store.send('a', 'claude-code', 'Go');
    await settle();
    emit('a', 'claude-code.terminal', { type: 'text', id: 'x', text: 'From the old terminal' });
    emit('b', 'claude-code.sdk', { type: 'text', id: 'y', text: 'For another agent' });
    expect(store.of('a').entries.map((e) => e.kind)).toEqual(['user']);
    expect(store.of('b').entries).toEqual([]);
  });

  it('closes when its agent runs another way, or is gone', async () => {
    const { store, backend, listening } = connected();
    const done = vi.fn<(interrupted: boolean) => void>();
    store.send('a', 'claude-code', 'Go', done);
    store.send('a', 'claude-code', 'Then this');
    await settle();
    store.sync([{ id: 'a', connection: 'unavailable' }]);
    expect(backend.close).toHaveBeenCalledWith('a');
    expect(done).toHaveBeenCalledWith(true, '', {
      status: 'cancelled',
      reason: 'connection-closed',
    });
    // Unsupported connections keep remaining work unsent.
    expect(store.of('a').queued).toMatchObject([{ text: 'Then this' }]);
    expect(
      store
        .of('a')
        .entries.filter((e) => e.kind === 'user')
        .map((e) => e.text),
    ).toEqual(['Go']);

    store.sync([{ id: 'a', connection: 'claude-code.sdk' }]);
    store.open('a');
    await settle();
    expect(backend.send).toHaveBeenCalledTimes(2);
    store.sync([]);
    expect(backend.close).toHaveBeenCalledTimes(2);
    expect(store.of('a').entries).toEqual([]);
    store.reset();
    expect(listening()).toBe(false);
  });
});

describe('a connected session without the app', () => {
  it('says it needs the app', async () => {
    const store = new SessionStore(engine);
    store.sync([{ id: 'a', connection: 'claude-code.terminal' }]);
    store.send('a', 'claude-code', 'Go');
    await settle();
    expect(store.of('a').entries[1]).toMatchObject({
      kind: 'notice',
      level: 'error',
      text: expect.stringMatching(/only in the corrallm app/) as unknown,
    });
  });
});

describe('a connected session of an adapter only the catalog it is given declares', () => {
  /** A store over that catalog, with agent `a` on its ACP connection, set to start in Plan. */
  function madeUp() {
    const fake = fakeBackend();
    const store = new SessionStore(engineCatalog(MADE_UP), fake.backend);
    store.sync([{ id: 'a', connection: 'zed.acp', settings: { zed: { mode: 'plan' } } }]);
    return { store, ...fake };
  }

  it('starts in the mode it is set to, which that catalog says its connection starts in', async () => {
    const { store, backend } = madeUp();
    store.open('a');
    expect(backend.start).toHaveBeenCalledWith('a', {
      connection: 'zed.acp',
      model: null,
      mode: 'plan',
    });
    await settle();
  });

  it('marks what it sends, what its CLI tells of, its history and a /clear as its adapter’s', async () => {
    const { store, emit } = madeUp();
    store.send('a', 'zed', 'From corrallm');
    await settle();
    emit('a', 'zed.acp', { type: 'user', id: 'typed', text: 'From its own prompt' });
    emit('a', 'zed.acp', { type: 'cleared', id: 'clear' });
    emit('a', 'zed.acp', {
      type: 'history',
      events: [
        { type: 'user', id: 'past', text: 'Before' },
        {
          type: 'end',
          messages: ['past'],
          seconds: 1,
          result: { status: 'completed', reason: 'completed' },
        },
      ],
    });
    expect(
      store
        .of('a')
        .entries.flatMap((entry) =>
          entry.kind === 'user' || entry.kind === 'cleared' ? [entry.conversation] : [],
        ),
    ).toEqual(['zed', 'zed', 'zed', 'zed']);
  });
});

describe('a connected session, resumed or completed', () => {
  const past: SessionEvent[] = [
    { type: 'user', id: 'u1', text: 'Fix the bug' },
    { type: 'text', id: 'm1:0', text: 'Fixed.' },
    { type: 'tool', id: 'toolu_1', tool: 'Edit', summary: 'a.ts', status: 'done' },
    {
      type: 'end',
      messages: ['u1'],
      seconds: 4,
      result: { status: 'completed', reason: 'completed' },
    },
  ];

  it('shows what a resumed session did before, ahead of what it does now', async () => {
    const { store, emit, backend } = connected();
    const done = vi.fn<(interrupted: boolean) => void>();
    // A message sent from the queues' run before the view opened: the session resumes for it.
    store.send('a', 'claude-code', 'Go on', done);
    await settle();
    emit('a', 'claude-code.sdk', { type: 'history', events: past });
    expect(store.of('a').entries.map((e) => e.kind)).toEqual([
      'user',
      'text',
      'tool',
      'end',
      'user',
    ]);
    expect(store.of('a').entries[3]).toMatchObject({ kind: 'end', seconds: 4 });
    // Still working on the message just sent; history ended nobody's turn.
    expect(store.of('a').status).toBe('working');
    expect(done).not.toHaveBeenCalled();
    expect(backend.send).toHaveBeenCalledOnce();
  });

  it('does not show history again that the transcript already shows', () => {
    const { store, emit } = connected();
    store.open('a');
    emit('a', 'claude-code.sdk', { type: 'history', events: past });
    emit('a', 'claude-code.sdk', { type: 'closed' }, { type: 'history', events: past });
    expect(store.of('a').entries.filter((e) => e.kind === 'user')).toHaveLength(1);
  });

  it('takes the slash commands the session offers, as they change', () => {
    const { store, emit } = connected();
    store.open('a');
    const compact = { name: 'compact', description: 'Summarize', argumentHint: '<instructions>' };
    emit('a', 'claude-code.sdk', { type: 'commands', commands: [compact] });
    expect(store.of('a').commands).toEqual([compact]);
    emit('a', 'claude-code.sdk', { type: 'commands', commands: [] });
    expect(store.of('a').commands).toEqual([]);
  });

  it('sends pasted images with the message, queued or not', async () => {
    const { store, backend, sent } = connected();
    const image = { mediaType: 'image/png', data: 'iVBORw0KGgo=' } as const;
    store.send('a', 'claude-code', 'What is this?', undefined, [image]);
    await settle();
    expect(backend.send).toHaveBeenCalledWith('a', {
      id: sent(),
      text: 'What is this?',
      images: [image],
    });
    expect(store.of('a').entries[0]).toMatchObject({ kind: 'user', images: [image] });
    store.send('a', 'claude-code', '', undefined, [image]);
    expect(store.of('a').queued).toEqual([
      { id: expect.any(String) as unknown, text: '', images: [image] },
    ]);
  });

  it('searches the project folder’s files for @-mentions', async () => {
    const { store, backend } = connected();
    backend.files.mockResolvedValueOnce(['src/main/ipc.ts']);
    await expect(store.findFiles('ipc')).resolves.toEqual(['src/main/ipc.ts']);
    expect(backend.files).toHaveBeenCalledWith('ipc');
  });
});

describe('a connected session continued in Terminal', () => {
  it('sends a command typed for Terminal once the agent runs there, never to its SDK session', async () => {
    const { store, backend, emit } = connected();
    store.open('a');
    emit('a', 'claude-code.sdk', {
      type: 'started',
      role: 'append',
      resume: true,
      list: true,
      model: null,
      mode: 'manual',
      models: [],
    });
    store.sendOnceIn('a', 'claude-code.terminal', 'Claude', '/permissions');
    await settle();
    expect(backend.send).not.toHaveBeenCalled();

    // The canvas switches it: its Agent SDK session closes, and its terminal gets the command.
    store.sync([{ id: 'a', connection: 'claude-code.terminal' }]);
    await settle();
    expect(backend.close).toHaveBeenCalledWith('a');
    expect(backend.start).toHaveBeenLastCalledWith(
      'a',
      expect.objectContaining({ connection: 'claude-code.terminal' }),
    );
    expect(backend.send).toHaveBeenCalledExactlyOnceWith('a', {
      id: expect.any(String) as unknown,
      text: '/permissions',
    });
    // Once.
    store.sync([{ id: 'a', connection: 'claude-code.terminal' }]);
    await settle();
    expect(backend.send).toHaveBeenCalledOnce();
  });
});

describe('a connected session opened on another conversation (/resume)', () => {
  it('lists the project folder’s conversations from main', async () => {
    const { store, backend } = connected();
    const past = [{ id: 'k1', title: 'Fix the login bug', modified: 1000, current: false }];
    backend.sessions.mockResolvedValueOnce(past);
    await expect(store.pastSessions('a')).resolves.toEqual(past);
    expect(backend.sessions).toHaveBeenCalledWith('a');
  });

  it('lets its session go, empties the transcript, and starts again on that conversation', async () => {
    const { store, backend, emit, sent } = connected();
    store.setMode('a', 'plan');
    store.send('a', 'claude-code', 'Old question');
    await settle();
    emit('a', 'claude-code.sdk', { type: 'user', id: sent(), text: 'Old question' });
    emit('a', 'claude-code.sdk', {
      type: 'usage',
      usage: { costUsd: 1, context: null, contextTokens: 10, contextWindow: 100 },
    });

    await store.resume('a', 'k1');
    expect(backend.resume).toHaveBeenCalledWith('a', 'k1');
    expect(backend.close).toHaveBeenCalledWith('a');
    expect(store.of('a')).toMatchObject({ entries: [], status: 'idle', mode: 'plan' });
    expect(store.of('a').usage).toBeUndefined();
    expect(backend.start).toHaveBeenCalledTimes(2);
    // Its history fills the transcript.
    emit('a', 'claude-code.sdk', {
      type: 'history',
      events: [
        { type: 'user', id: 'k1-u', text: 'Earlier' },
        {
          type: 'end',
          messages: ['k1-u'],
          seconds: 2,
          result: { status: 'completed', reason: 'completed' },
        },
      ],
    });
    expect(store.of('a').entries.map((e) => e.kind)).toEqual(['user', 'end']);
    await settle();
  });

  it('keeps its session and transcript when main will not open that conversation', async () => {
    const { store, backend, emit } = connected();
    store.open('a');
    emit('a', 'claude-code.sdk', { type: 'notice', id: 'n', level: 'info', text: 'Still here' });
    backend.resume.mockRejectedValueOnce(new Error('Not listed'));
    await expect(store.resume('a', 'elsewhere')).rejects.toThrow('Not listed');
    expect(backend.close).not.toHaveBeenCalled();
    expect(store.of('a').entries).toHaveLength(1);
  });
});

describe('a connected session’s MCP servers', () => {
  it('lists and changes them in main', async () => {
    const { store, backend } = connected();
    const servers = [{ name: 'github', status: 'connected' as const }];
    backend.mcp.mockResolvedValue(servers);
    backend.changeMcp.mockResolvedValue(servers);
    await expect(store.mcpServers('a')).resolves.toEqual(servers);
    await expect(store.changeMcpServer('a', 'github', 'reconnect')).resolves.toEqual(servers);
    expect(backend.mcp).toHaveBeenCalledWith('a');
    expect(backend.changeMcp).toHaveBeenCalledWith('a', 'github', 'reconnect');
  });
});

describe('a connected session that would not start', () => {
  const why =
    "Claude Code is logged in with your Claude subscription, which Anthropic doesn't allow other " +
    'products to use through the Agent SDK: run this agent in Terminal, or give Claude Code an ' +
    'API key or a cloud provider.';
  const connections = [
    {
      connection: 'claude-code.sdk' as const,
      switchTo: 'claude-code.terminal' as const,
      adapter: 'claude-code' as const,
      reason: why,
    },
    {
      connection: 'codex.app-server' as const,
      switchTo: 'codex.terminal' as const,
      adapter: 'codex' as const,
      reason: "Codex isn't logged in. Switch this agent to Codex · Terminal and log in there.",
    },
  ];

  /** A store whose agent `a` main refuses to start, offering its CLI's Terminal connection. */
  function refused(
    connection: ConnectionId = 'claude-code.sdk',
    switchTo: ConnectionId = 'claude-code.terminal',
    reason = why,
  ) {
    const fake = connected(connection);
    fake.backend.start.mockImplementation((_agent, options) => {
      if (options.connection !== connection) return Promise.resolve(null);
      fake.emit('a', connection, {
        type: 'notice',
        id: crypto.randomUUID(),
        level: 'error',
        text: reason,
        switchTo,
      });
      return Promise.reject(new Error(reason));
    });
    return fake;
  }

  it.each(connections)(
    'keeps the $connection message, queued, says why once, and tells whoever sent it',
    async ({ connection, switchTo, adapter: agent, reason }) => {
      const { store, backend } = refused(connection, switchTo, reason);
      const done = vi.fn<(interrupted: boolean, reply: string) => void>();
      const held = vi.fn<(refusal: Refusal) => void>();
      store.send('a', agent, 'Fix the bug', done, undefined, held);
      await settle();
      expect(held).toHaveBeenCalledExactlyOnceWith({ text: reason, switchTo });
      expect(done).not.toHaveBeenCalled();
      expect(backend.send).not.toHaveBeenCalled();
      // Never sent: not a turn of the transcript (nor its end, failed), but a message still to send.
      const session = store.of('a');
      expect(session.status).toBe('idle');
      expect(session.entries).toEqual([
        {
          id: expect.any(String) as unknown,
          kind: 'notice',
          level: 'error',
          text: reason,
          switchTo,
        },
      ]);
      expect(session.queued.map((q) => q.text)).toEqual(['Fix the bug']);

      // Another message tries the session again, and waits behind the first; the refusal is said once.
      store.send('a', agent, 'And the tests');
      await settle();
      expect(backend.start).toHaveBeenCalledTimes(2);
      expect(store.of('a').queued.map((q) => q.text)).toEqual(['Fix the bug', 'And the tests']);
      expect(store.of('a').entries.map((e) => e.kind)).toEqual(['notice']);
    },
  );

  it.each(connections)(
    'delivers the kept $connection message after opening $switchTo with asynchronous directory readiness',
    async ({ connection, switchTo, adapter: agent, reason }) => {
      const fake = fakeBackend();
      const store = new SessionStore(engine, {
        ...fake.backend,
        availability: () => Promise.resolve({ ready: true }),
      });
      store.sync([{ id: 'a', connection }]);
      fake.backend.start.mockImplementation((_agent, options) => {
        if (options.connection !== connection) return Promise.resolve(null);
        fake.emit('a', connection, {
          type: 'notice',
          id: crypto.randomUUID(),
          level: 'error',
          text: reason,
          switchTo,
        });
        return Promise.reject(new Error(reason));
      });
      store.open('a');
      await settle();
      store.send('a', agent, 'Fix the login bug');
      await settle();
      expect(store.of('a').queued.map(({ text }) => text)).toEqual(['Fix the login bug']);
      expect(fake.backend.send).not.toHaveBeenCalled();
      store.sync([{ id: 'a', connection: switchTo }]);
      store.open('a');
      await settle();
      expect(fake.backend.start).toHaveBeenLastCalledWith(
        'a',
        expect.objectContaining({ connection: switchTo }),
      );
      expect(fake.backend.send).toHaveBeenCalledOnce();
      expect(store.of('a').queued).toEqual([]);
      store.reset();
    },
  );

  it.each(connections)(
    'sends what $connection kept once the agent runs in $switchTo, and whoever sent it hears the turn end',
    async ({ connection, switchTo, adapter: agent, reason }) => {
      const { store, backend, emit } = refused(connection, switchTo, reason);
      const done = vi.fn<(interrupted: boolean, reply: string) => void>();
      store.send('a', agent, 'Fix the bug', done);
      await settle();
      const [kept] = store.of('a').queued;

      store.sync([{ id: 'a', connection: switchTo }]);
      await settle();
      expect(backend.start).toHaveBeenLastCalledWith(
        'a',
        expect.objectContaining({ connection: switchTo }),
      );
      expect(backend.send).toHaveBeenCalledExactlyOnceWith('a', {
        id: kept?.id,
        text: 'Fix the bug',
      });
      expect(store.of('a').queued).toEqual([]);
      emit(
        'a',
        switchTo,
        { type: 'user', id: kept?.id ?? '', text: 'Fix the bug' },
        { type: 'text', id: 'x', text: 'Fixed.' },
        end([kept?.id ?? '']),
      );
      expect(done).toHaveBeenCalledExactlyOnceWith(false, 'Fixed.', {
        status: 'completed',
        reason: 'completed',
      });
    },
  );

  it('keeps an unsent refused submission through a switch while its startup retry is pending', async () => {
    const fake = fakeBackend();
    const store = new SessionStore(engine, {
      ...fake.backend,
      availability: () => Promise.resolve({ ready: true }),
    });
    store.sync([{ id: 'a', connection: 'claude-code.sdk' }]);
    const retry = Promise.withResolvers<null>();
    fake.backend.start
      .mockImplementationOnce(() => {
        fake.emit('a', 'claude-code.sdk', {
          type: 'notice',
          id: 'refusal',
          level: 'error',
          text: why,
          switchTo: 'claude-code.terminal',
        });
        return Promise.reject(new Error(why));
      })
      .mockImplementationOnce(() => retry.promise);
    store.open('a');
    await settle();
    const done = vi.fn();
    store.send('a', 'claude-code', 'Fix the login bug', done);
    const id = store.of('a').queued[0]?.id;
    await settle();
    expect(fake.backend.start).toHaveBeenCalledTimes(2);
    expect(fake.backend.send).not.toHaveBeenCalled();

    store.sync([{ id: 'a', connection: 'claude-code.terminal' }]);
    store.open('a');
    await settle();
    expect(fake.backend.send).toHaveBeenCalledExactlyOnceWith('a', {
      id,
      text: 'Fix the login bug',
    });
    expect(done).not.toHaveBeenCalled();
    retry.resolve(null);
    await settle();
    expect(fake.backend.send).toHaveBeenCalledOnce();
    fake.emit('a', 'claude-code.terminal', end([id ?? '']));
    expect(done).toHaveBeenCalledExactlyOnceWith(false, '', {
      status: 'completed',
      reason: 'completed',
    });
    store.reset();
  });

  it('keeps a submission whole and unsent, its images with it, on a connection that takes none (B16 C3)', async () => {
    const fake = fakeBackend();
    const store = new SessionStore(engine, {
      ...fake.backend,
      availability: () => Promise.resolve({ ready: true }),
    });
    store.sync([{ id: 'a', connection: 'claude-code.terminal' }]);
    const done = vi.fn();
    const refused = vi.fn();
    const images = [{ mediaType: 'image/png' as const, data: 'iVBORw0KGgo=' }];
    store.send('a', 'claude-code', 'Look at this', done, images, refused);
    await settle();
    expect(fake.backend.send).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
    // Refused for its images, not for the session: delivery holds it until the agent runs another way.
    expect(refused).toHaveBeenCalledExactlyOnceWith({
      text: 'Claude Code · Terminal takes no images.',
      images: true,
    });
    expect(store.of('a').queued).toEqual([
      expect.objectContaining({ text: 'Look at this', images }),
    ]);
    expect(store.of('a').entries.at(-1)).toMatchObject({
      kind: 'notice',
      text: 'Claude Code · Terminal takes no images.',
    });
    store.reset();
  });

  it('takes a kept message back off the queue', async () => {
    const { store } = refused();
    const done = vi.fn<(interrupted: boolean, reply: string) => void>();
    const takeBack = store.send('a', 'claude-code', 'Fix the bug', done);
    await settle();
    takeBack();
    expect(store.of('a').queued).toEqual([]);
    expect(done).toHaveBeenCalledExactlyOnceWith(true, '', {
      status: 'cancelled',
      reason: 'taken-back',
    });
  });

  it('marks the messages the CLI has, which a rewind can go back to', async () => {
    const { store, emit, sent } = connected();
    store.send('a', 'claude-code', 'Edit the notes');
    await settle();
    // Not yet: main has not said it went to the CLI.
    expect(rewindPointsOf(store.of('a').entries, 'claude-code')).toEqual([]);
    emit(
      'a',
      'claude-code.sdk',
      { type: 'user', id: sent(), text: 'Edit the notes' },
      end([sent()]),
    );
    expect(rewindPointsOf(store.of('a').entries, 'claude-code')).toEqual([
      { id: sent(), text: 'Edit the notes' },
    ]);
  });
});

describe('a connected session rewound', () => {
  /** A store whose agent `a` has had a turn: "Edit the notes". */
  async function talked() {
    const fake = connected();
    fake.store.send('a', 'claude-code', 'Edit the notes');
    await settle();
    const id = fake.sent();
    fake.emit('a', 'claude-code.sdk', { type: 'user', id, text: 'Edit the notes' }, end([id]));
    return { ...fake, id };
  }

  it('previews what restoring its files would change, from main', async () => {
    const { store, backend, id } = await talked();
    const preview = { possible: true, files: ['notes.txt'], added: 1, removed: 1 };
    backend.previewRewind.mockResolvedValue(preview);
    await expect(store.previewRewind('a', id)).resolves.toEqual(preview);
    expect(backend.previewRewind).toHaveBeenCalledWith('a', id);
  });

  it('restores its files alone, saying which, and leaves the conversation as it is', async () => {
    const { store, backend, id } = await talked();
    backend.rewind.mockResolvedValue({
      files: { possible: true, files: ['notes.txt'], added: 1, removed: 1 },
      conversation: false,
    });
    await store.rewind('a', id, 'code');
    expect(backend.rewind).toHaveBeenCalledWith('a', id, 'code');
    expect(backend.close).not.toHaveBeenCalled();
    expect(store.of('a').entries.map((e) => e.kind)).toEqual(['user', 'end', 'notice']);
    expect(store.of('a').entries.at(-1)).toMatchObject({
      level: 'info',
      text: 'Restored notes.txt (+1 −1) to how it was before “Edit the notes”.',
    });
  });

  it('rewinds the conversation: its session starts again on the copy, the transcript empty', async () => {
    const { store, backend, id } = await talked();
    backend.rewind.mockResolvedValue({
      files: { possible: true, files: ['a.ts', 'b.ts', 'c.ts', 'd.ts'], added: 4, removed: 2 },
      conversation: true,
    });
    await store.rewind('a', id, 'both');
    expect(backend.close).toHaveBeenCalledWith('a');
    expect(backend.start).toHaveBeenCalledTimes(2);
    expect(store.of('a').entries).toMatchObject([
      {
        kind: 'notice',
        text: 'Rewound the conversation to before “Edit the notes”, and restored 4 files (a.ts, b.ts, c.ts and 1 more; +4 −2).',
      },
    ]);
  });
});

it('keeps a workspace-held submission queued and resumes once availability changes, without failing a turn', async () => {
  const fake = fakeBackend();
  let ready = false;
  let changed: (() => void) | undefined;
  const store = new SessionStore(engine, {
    ...fake.backend,
    availability: () =>
      Promise.resolve(
        ready ? { ready: true } : { ready: false, sentence: 'Run or skip setup first.' },
      ),
    onAvailability: (listener) => {
      changed = listener;
      return () => {
        changed = undefined;
      };
    },
  });
  store.sync([{ id: 'a', connection: 'claude-code.sdk' }]);
  const done = vi.fn();
  store.send('a', 'claude-code', 'hello', done);
  await settle();
  expect(fake.backend.start).not.toHaveBeenCalled();
  expect(store.of('a').queued.map((one) => one.text)).toEqual(['hello']);
  expect(done).not.toHaveBeenCalled();
  expect(store.of('a').entries).toContainEqual(
    expect.objectContaining({ kind: 'notice', text: 'Run or skip setup first.' }),
  );
  ready = true;
  changed?.();
  await settle();
  expect(fake.backend.start).toHaveBeenCalledOnce();
  expect(fake.backend.send).toHaveBeenCalledOnce();
  store.reset();
});
