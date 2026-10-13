import { describe, expect, it, vi } from 'vitest';

import type { SessionEvent } from '../../shared/session';
import { fakeBackend } from '../test-backend';
import { SessionStore } from './sessions';

/** Lets pending promises (IPC replies) settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A store with agent `a` connected through the Agent SDK, and the backend it talks to. */
function connected() {
  const fake = fakeBackend();
  const store = new SessionStore(fake.backend);
  store.sync([{ id: 'a', connection: 'sdk' }]);
  return { store, ...fake };
}

const end = (messages: string[], extra: Partial<Extract<SessionEvent, { type: 'end' }>> = {}) =>
  ({ type: 'end', messages, seconds: 3, interrupted: false, failed: false, ...extra }) as const;

describe('a connected session', () => {
  it('starts when its view opens, with its mode, and takes the models it offers', async () => {
    const { store, backend, emit } = connected();
    store.setMode('a', 'acceptEdits');
    store.open('a');
    store.open('a');
    expect(backend.start).toHaveBeenCalledOnce();
    expect(backend.start).toHaveBeenCalledWith('a', {
      connection: 'sdk',
      model: null,
      mode: 'acceptEdits',
    });
    const models = [
      { value: 'opus', label: 'Opus' },
      { value: 'haiku', label: 'Haiku' },
    ];
    emit('a', 'sdk', { type: 'started', model: 'opus', mode: 'acceptEdits', models });
    expect(store.of('a')).toMatchObject({ models, model: 'opus', mode: 'acceptEdits' });
    await settle();
  });

  it('starts with only what the user chose here: main fills in what the agent was given before', async () => {
    const { store, backend, emit } = connected();
    // A model picked while it was simulated is not one the CLI offers: not passed on.
    store.setModel('a', 'Opus 5.5');
    store.open('a');
    expect(backend.start).toHaveBeenLastCalledWith('a', {
      connection: 'sdk',
      model: null,
      mode: null,
    });
    const models = [
      { value: 'default', label: 'Default' },
      { value: 'haiku', label: 'Haiku' },
    ];
    // Main started it in the mode it was given last time, which the session shows.
    emit('a', 'sdk', { type: 'started', model: 'default', mode: 'plan', models });
    expect(store.of('a')).toMatchObject({ mode: 'plan', model: 'default' });
    await settle();

    // Once it stops, it starts again with what the user has chosen since.
    store.setModel('a', 'haiku');
    emit('a', 'sdk', { type: 'closed' }, { type: 'mode', mode: 'acceptEdits' });
    store.open('a');
    expect(backend.start).toHaveBeenLastCalledWith('a', {
      connection: 'sdk',
      model: 'haiku',
      mode: null,
    });
    await settle();
  });

  it('sends a message, streams the reply into the transcript, and hears when the turn ends', async () => {
    const { store, backend, emit, sent } = connected();
    const done = vi.fn<(interrupted: boolean) => void>();
    store.send('a', 'Claude', 'Fix the bug', done);
    expect(store.of('a').status).toBe('working');
    await settle();
    const id = sent();
    expect(backend.send).toHaveBeenCalledWith('a', { id, text: 'Fix the bug' });

    emit(
      'a',
      'sdk',
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
      { type: 'usage', usage: { costUsd: 0.02, contextTokens: 5000, contextWindow: 200_000 } },
    );
    expect(done).not.toHaveBeenCalled();
    emit('a', 'sdk', end([id]));

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
    expect(done).toHaveBeenCalledWith(false, 'I’ll fix it.');
  });

  it('tells whoever sent a message what the agent replied in its turn, not its subagents', async () => {
    const { store, emit, sent } = connected();
    const done = vi.fn<(interrupted: boolean, reply: string) => void>();
    store.send('a', 'Claude', 'Is it fixed?', done);
    await settle();
    const id = sent();
    emit(
      'a',
      'sdk',
      { type: 'user', id, text: 'Is it fixed?' },
      { type: 'text', id: 'x', text: 'Let me run the tests.' },
      { type: 'tool', id: 'agent-1', tool: 'Agent', summary: 'Run them', status: 'running' },
      { type: 'text', id: 'sub', text: 'All green.', parent: 'agent-1' },
      { type: 'text', id: 'y', text: 'Yes: all 12 pass.' },
    );
    // A message typed while it worked waits for the turn after.
    store.send('a', 'Claude', 'Thanks');
    emit('a', 'sdk', end([id]));
    expect(done).toHaveBeenCalledWith(false, 'Let me run the tests.\n\nYes: all 12 pass.');
  });

  it('takes a message back: off the queue while it waits there, or interrupting its turn', async () => {
    const { store, backend, emit, sent } = connected();
    const first = vi.fn<(interrupted: boolean, reply: string) => void>();
    const second = vi.fn<(interrupted: boolean, reply: string) => void>();
    const third = vi.fn<(interrupted: boolean, reply: string) => void>();
    const takeFirst = store.send('a', 'Claude', 'First', first);
    const takeSecond = store.send('a', 'Claude', 'Second', second);
    const takeThird = store.send('a', 'Claude', 'Third', third);
    await settle();
    takeThird();
    expect(store.of('a').queued.map((q) => q.text)).toEqual(['Second']);
    expect(third).toHaveBeenCalledWith(true, '');
    expect(backend.interrupt).not.toHaveBeenCalled();

    // Once its turn has ended, there is nothing to take back.
    emit('a', 'sdk', end([sent()]));
    takeFirst();
    await settle();
    expect(backend.interrupt).not.toHaveBeenCalled();
    // A queued message that has started since: its turn is interrupted.
    expect(backend.send.mock.calls.at(-1)?.[1].text).toBe('Second');
    takeSecond();
    await settle();
    expect(backend.interrupt).toHaveBeenCalledWith('a');
    emit('a', 'sdk', end([sent()], { interrupted: true }));
    expect(first).toHaveBeenCalledWith(false, '');
    expect(second).toHaveBeenCalledWith(true, '');
  });

  it('queues messages sent while it works, and sends each once the turn before has ended', async () => {
    const { store, backend, emit, sent } = connected();
    store.send('a', 'Claude', 'First');
    store.send('a', 'Claude', 'Second');
    await settle();
    expect(backend.send).toHaveBeenCalledTimes(1);
    expect(store.of('a').queued.map((q) => q.text)).toEqual(['Second']);
    emit('a', 'sdk', end([sent()]));
    await settle();
    expect(backend.send).toHaveBeenCalledTimes(2);
    expect(backend.send.mock.calls[1]?.[1].text).toBe('Second');
  });

  it('shows a message typed in its terminal, and a turn it started by itself', () => {
    const { store, emit } = connected();
    store.open('a');
    emit('a', 'sdk', { type: 'user', id: 'typed', text: 'Hello from the terminal' });
    expect(store.of('a').status).toBe('working');
    expect(store.of('a').entries[0]).toEqual({
      id: 'typed',
      kind: 'user',
      text: 'Hello from the terminal',
    });
    emit('a', 'sdk', end(['typed']));
    emit('a', 'sdk', { type: 'status', status: 'working' });
    expect(store.of('a').status).toBe('working');
  });

  it('asks permission, and passes the user’s answer on', async () => {
    const { store, backend, emit } = connected();
    store.send('a', 'Claude', 'Go');
    await settle();
    emit('a', 'sdk', {
      type: 'permission',
      id: 'p',
      tool: 'Bash',
      summary: 'npm test',
      always: 'Yes, and don’t ask again for npm test',
    });
    expect(store.of('a').status).toBe('waiting');
    store.answer('a', 'p', 'always');
    expect(store.of('a').status).toBe('working');
    await settle();
    expect(backend.answer).toHaveBeenCalledWith('a', 'p', { kind: 'permission', answer: 'always' });
  });

  it('asks questions, answering once each one has an answer', async () => {
    const { store, backend, emit } = connected();
    store.send('a', 'Claude', 'Go');
    await settle();
    const option = (label: string) => ({ label, description: '' });
    emit('a', 'sdk', {
      type: 'question',
      id: 'q',
      questions: [
        { header: 'Branch', text: 'Which branch?', options: [option('main')], multiple: false },
        { header: 'Tests', text: 'Run them?', options: [option('Yes')], multiple: false },
      ],
    });
    store.answerQuestion('a', 'q', 0, 'main');
    await settle();
    expect(backend.answer).not.toHaveBeenCalled();
    store.answerQuestion('a', 'q', 1, 'Yes');
    expect(store.of('a').status).toBe('working');
    await settle();
    expect(backend.answer).toHaveBeenCalledWith('a', 'q', {
      kind: 'question',
      answers: ['main', 'Yes'],
    });
  });

  it('asks to approve a plan', async () => {
    const { store, backend, emit } = connected();
    store.send('a', 'Claude', 'Plan it');
    await settle();
    emit('a', 'sdk', { type: 'plan', id: 'plan', plan: '1. Read\n2. Change' });
    store.answerPlan('a', 'plan', { approve: false, feedback: 'Add tests' });
    expect(store.of('a').entries.at(-1)).toMatchObject({
      kind: 'plan',
      answer: { approve: false, feedback: 'Add tests' },
    });
    await settle();
    expect(backend.answer).toHaveBeenCalledWith('a', 'plan', {
      kind: 'plan',
      answer: { approve: false, feedback: 'Add tests' },
    });
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
    store.send('a', 'Claude', 'Never mind', done);
    store.stop('a');
    expect(done).toHaveBeenCalledWith(true, '');
    expect(store.of('a').status).toBe('idle');
    started?.();
    await settle();
    expect(backend.send).not.toHaveBeenCalled();

    store.send('a', 'Claude', 'Go');
    await settle();
    store.stop('a');
    await settle();
    expect(backend.interrupt).toHaveBeenCalledWith('a');
    emit('a', 'sdk', end([sent()], { interrupted: true }));
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
    backend.start.mockRejectedValue(
      new Error(
        "Error invoking remote method 'session:start': Error: Choose a project folder first.",
      ),
    );
    const done = vi.fn<(interrupted: boolean) => void>();
    store.send('a', 'Claude', 'Go', done);
    await settle();
    expect(done).toHaveBeenCalledWith(true, '');
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
    store.send('a', 'Claude', 'Go', done);
    await settle();
    emit('a', 'sdk', { type: 'closed', error: 'Claude Code exited (code 1)' });
    expect(done).toHaveBeenCalledWith(true, '');
    expect(store.of('a').entries.slice(1)).toMatchObject([
      { kind: 'notice', level: 'error', text: 'Claude Code exited (code 1)' },
      { kind: 'end', failed: true },
    ]);
    store.send('a', 'Claude', 'Again');
    await settle();
    expect(backend.start).toHaveBeenCalledTimes(2);
  });

  it('hears only its own connection: another one’s late words are dropped', async () => {
    const { store, emit } = connected();
    store.send('a', 'Claude', 'Go');
    await settle();
    emit('a', 'terminal', { type: 'text', id: 'x', text: 'From the old terminal' });
    emit('b', 'sdk', { type: 'text', id: 'y', text: 'For another agent' });
    expect(store.of('a').entries.map((e) => e.kind)).toEqual(['user']);
    expect(store.of('b').entries).toEqual([]);
  });

  it('closes when its agent runs another way, or is gone', async () => {
    const { store, backend, listening } = connected();
    const done = vi.fn<(interrupted: boolean) => void>();
    store.send('a', 'Claude', 'Go', done);
    store.send('a', 'Claude', 'Then this');
    await settle();
    store.sync([{ id: 'a', connection: 'simulated' }]);
    expect(backend.close).toHaveBeenCalledWith('a');
    expect(done).toHaveBeenCalledWith(true, '');
    // The queued message goes on, to the scripted session.
    expect(store.of('a').queued).toEqual([]);
    expect(
      store
        .of('a')
        .entries.filter((e) => e.kind === 'user')
        .map((e) => e.text),
    ).toEqual(['Go', 'Then this']);

    store.sync([{ id: 'a', connection: 'sdk' }]);
    store.open('a');
    store.sync([]);
    expect(backend.close).toHaveBeenCalledTimes(2);
    expect(store.of('a').entries).toEqual([]);
    store.reset();
    expect(listening()).toBe(false);
  });
});

describe('a connected session without the app', () => {
  it('says it needs the app', async () => {
    const store = new SessionStore();
    store.sync([{ id: 'a', connection: 'terminal' }]);
    store.send('a', 'Claude', 'Go');
    await settle();
    expect(store.of('a').entries[1]).toMatchObject({
      kind: 'notice',
      level: 'error',
      text: expect.stringMatching(/only in the corrallm app/) as unknown,
    });
  });
});

describe('a connected session, resumed or completed', () => {
  const past: SessionEvent[] = [
    { type: 'user', id: 'u1', text: 'Fix the bug' },
    { type: 'text', id: 'm1:0', text: 'Fixed.' },
    { type: 'tool', id: 'toolu_1', tool: 'Edit', summary: 'a.ts', status: 'done' },
    { type: 'end', messages: ['u1'], seconds: 4, interrupted: false, failed: false },
  ];

  it('shows what a resumed session did before, ahead of what it does now', async () => {
    const { store, emit, backend } = connected();
    const done = vi.fn<(interrupted: boolean) => void>();
    // A message sent from the queues' run before the view opened: the session resumes for it.
    store.send('a', 'Claude', 'Go on', done);
    await settle();
    emit('a', 'sdk', { type: 'history', events: past });
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
    emit('a', 'sdk', { type: 'history', events: past });
    emit('a', 'sdk', { type: 'closed' }, { type: 'history', events: past });
    expect(store.of('a').entries.filter((e) => e.kind === 'user')).toHaveLength(1);
  });

  it('takes the slash commands the session offers, as they change', () => {
    const { store, emit } = connected();
    store.open('a');
    const compact = { name: 'compact', description: 'Summarize', argumentHint: '<instructions>' };
    emit('a', 'sdk', { type: 'commands', commands: [compact] });
    expect(store.of('a').commands).toEqual([compact]);
    emit('a', 'sdk', { type: 'commands', commands: [] });
    expect(store.of('a').commands).toEqual([]);
  });

  it('sends pasted images with the message, queued or not', async () => {
    const { store, backend, sent } = connected();
    const image = { mediaType: 'image/png', data: 'iVBORw0KGgo=' } as const;
    store.send('a', 'Claude', 'What is this?', undefined, [image]);
    await settle();
    expect(backend.send).toHaveBeenCalledWith('a', {
      id: sent(),
      text: 'What is this?',
      images: [image],
    });
    expect(store.of('a').entries[0]).toMatchObject({ kind: 'user', images: [image] });
    store.send('a', 'Claude', '', undefined, [image]);
    expect(store.of('a').queued).toEqual([
      { id: expect.any(String) as unknown, text: '', images: [image] },
    ]);
  });

  it('shows a permission prompt as the CLI words it', () => {
    const { store, emit } = connected();
    store.open('a');
    emit('a', 'sdk', {
      type: 'permission',
      id: 'p',
      tool: 'WebFetch',
      summary: 'https://example.com',
      always: null,
      title: 'Claude wants to fetch example.com',
    });
    expect(store.of('a').entries[0]).toMatchObject({
      kind: 'permission',
      title: 'Claude wants to fetch example.com',
    });
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
    emit('a', 'sdk', { type: 'started', model: null, mode: 'manual', models: [] });
    store.sendOnceIn('a', 'terminal', 'Claude', '/permissions');
    await settle();
    expect(backend.send).not.toHaveBeenCalled();

    // The canvas switches it: its Agent SDK session closes, and its terminal gets the command.
    store.sync([{ id: 'a', connection: 'terminal' }]);
    await settle();
    expect(backend.close).toHaveBeenCalledWith('a');
    expect(backend.start).toHaveBeenLastCalledWith(
      'a',
      expect.objectContaining({ connection: 'terminal' }),
    );
    expect(backend.send).toHaveBeenCalledExactlyOnceWith('a', {
      id: expect.any(String) as unknown,
      text: '/permissions',
    });
    // Once.
    store.sync([{ id: 'a', connection: 'terminal' }]);
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
    store.send('a', 'Claude', 'Old question');
    await settle();
    emit('a', 'sdk', { type: 'user', id: sent(), text: 'Old question' });
    emit('a', 'sdk', {
      type: 'usage',
      usage: { costUsd: 1, contextTokens: 10, contextWindow: 100 },
    });

    await store.resume('a', 'k1');
    expect(backend.resume).toHaveBeenCalledWith('a', 'k1');
    expect(backend.close).toHaveBeenCalledWith('a');
    expect(store.of('a')).toMatchObject({ entries: [], status: 'idle', mode: 'plan' });
    expect(store.of('a').usage).toBeUndefined();
    expect(backend.start).toHaveBeenCalledTimes(2);
    // Its history fills the transcript.
    emit('a', 'sdk', {
      type: 'history',
      events: [
        { type: 'user', id: 'k1-u', text: 'Earlier' },
        { type: 'end', messages: ['k1-u'], seconds: 2, interrupted: false, failed: false },
      ],
    });
    expect(store.of('a').entries.map((e) => e.kind)).toEqual(['user', 'end']);
    await settle();
  });

  it('keeps its session and transcript when main will not open that conversation', async () => {
    const { store, backend, emit } = connected();
    store.open('a');
    emit('a', 'sdk', { type: 'notice', id: 'n', level: 'info', text: 'Still here' });
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

  it('asks what a server asks for, waiting on the user, and passes the answer on', async () => {
    const { store, backend, emit, sent } = connected();
    store.send('a', 'Claude', 'File an issue');
    await settle();
    emit(
      'a',
      'sdk',
      { type: 'user', id: sent(), text: 'File an issue' },
      {
        type: 'elicitation',
        id: 'e1',
        server: 'github',
        message: 'Which repository?',
        fields: [{ name: 'repo', label: 'Repository', required: true, kind: 'text' }],
      },
    );
    expect(store.of('a').status).toBe('waiting');
    store.answerElicitation('a', 'e1', 'accept', { repo: 'acme/shop' });
    expect(store.of('a').status).toBe('working');
    expect(store.of('a').entries.at(-1)).toMatchObject({ kind: 'elicitation', answer: 'accept' });
    await settle();
    expect(backend.answer).toHaveBeenCalledWith('a', 'e1', {
      kind: 'elicitation',
      action: 'accept',
      values: { repo: 'acme/shop' },
    });
  });
});

describe('a connected session rewound', () => {
  /** A store whose agent `a` has had a turn: "Edit the notes". */
  async function talked() {
    const fake = connected();
    fake.store.send('a', 'Claude', 'Edit the notes');
    await settle();
    const id = fake.sent();
    fake.emit('a', 'sdk', { type: 'user', id, text: 'Edit the notes' }, end([id]));
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
