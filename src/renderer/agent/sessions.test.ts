import { afterEach, describe, expect, it, vi } from 'vitest';

import { SessionStore } from './sessions';
import { fakeBackend } from '../test-backend';

afterEach(() => {
  vi.useRealTimers();
});

describe('SessionStore', () => {
  it('records commands handled locally without sending a turn', () => {
    const { backend } = fakeBackend();
    const store = new SessionStore(backend);
    store.recordSubmission('a', '/mcp');
    expect(store.of('a').submissions).toMatchObject([{ text: '/mcp', status: 'completed' }]);
    expect(backend.send).not.toHaveBeenCalled();
    expect(store.of('a').entries).toEqual([]);
  });

  it('keeps one manual message queued after refusal and sends it once after switching', async () => {
    const { backend, emit, sent } = fakeBackend();
    const store = new SessionStore(backend);
    store.sync([{ id: 'a', connection: 'sdk' }]);
    backend.start.mockImplementationOnce(() => {
      emit('a', 'sdk', {
        type: 'notice',
        id: 'refusal',
        level: 'error',
        text: 'Use Terminal',
        switchTo: 'terminal',
      });
      return Promise.reject(new Error('Use Terminal'));
    });
    store.send('a', 'Claude', 'Keep this');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const id = store.of('a').submissions?.[0]?.id;
    if (!id) throw new Error('No recorded message');
    expect(store.of('a').submissions).toMatchObject([{ id, text: 'Keep this', status: 'queued' }]);
    store.sync([{ id: 'a', connection: 'terminal' }]);
    await Promise.resolve();
    await Promise.resolve();
    expect(sent()).toBe(id);
    expect(store.of('a').submissions).toMatchObject([{ id, status: 'running' }]);
    emit('a', 'terminal', {
      type: 'end',
      messages: [id],
      seconds: 1,
      interrupted: false,
      failed: false,
    });
    expect(store.of('a').submissions).toMatchObject([{ id, status: 'completed' }]);
    expect(backend.send).toHaveBeenCalledTimes(1);
    store.reset();
  });
  it('records each manual submission once, including queued images and cancellation', () => {
    vi.useFakeTimers();
    const store = new SessionStore(undefined, () => 'held-step');
    store.setMode('a', 'bypassPermissions');
    store.send('a', 'Claude', 'First');
    store.send('a', 'Claude', '', undefined, [{ mediaType: 'image/png', data: 'picture' }]);
    const cancel = store.send('a', 'Claude', 'First');
    cancel();
    expect(store.of('a').submissions).toMatchObject([
      { text: 'First', status: 'running', after: 'held-step' },
      { text: '', status: 'queued', images: [{ data: 'picture' }] },
      { text: 'First', status: 'cancelled' },
    ]);
    vi.runAllTimers();
    expect(store.of('a').submissions?.map(({ status }) => status)).toEqual([
      'completed',
      'completed',
      'cancelled',
    ]);
    expect(new Set(store.of('a').submissions?.map(({ id }) => id)).size).toBe(3);
    store.send('a', 'Claude', 'Interrupted');
    store.stop('a');
    expect(store.of('a').submissions?.at(-1)?.status).toBe('cancelled');
    store.reset();
    expect(store.of('a').submissions).toBeUndefined();
  });

  it.each(['terminal', 'codex-terminal', 'sdk', 'app-server'] as const)(
    'records live %s prompts, excludes automation and restored history, and correlates turn ends',
    async (connection) => {
      const { backend, emit, sent } = fakeBackend();
      const store = new SessionStore(backend);
      store.sync([{ id: 'a', connection }]);
      store.send('a', 'Claude', 'Automated step', undefined, undefined, undefined, 'queue');
      await Promise.resolve();
      await Promise.resolve();
      const automated = sent();
      emit('a', connection, { type: 'user', id: automated, text: 'Automated step' });
      expect(store.of('a').submissions).toBeUndefined();
      emit('a', connection, {
        type: 'end',
        messages: [automated],
        seconds: 1,
        interrupted: false,
        failed: false,
      });
      store.send('a', 'Claude', 'Manual');
      await Promise.resolve();
      await Promise.resolve();
      const manual = sent();
      emit(
        'a',
        connection,
        { type: 'user', id: manual, text: 'Manual' },
        { type: 'user', id: 'native-1', text: 'Manual' },
        { type: 'user', id: 'native-2', text: 'Steering\nmessage' },
        { type: 'history', events: [{ type: 'user', id: 'old', text: 'Restored' }] },
      );
      expect(store.of('a').submissions?.map(({ text }) => text)).toEqual([
        'Manual',
        'Manual',
        'Steering\nmessage',
      ]);
      expect(backend.send).toHaveBeenCalledTimes(2);
      emit('a', connection, {
        type: 'end',
        messages: [manual, 'native-1', 'native-2'],
        seconds: 1,
        interrupted: false,
        failed: true,
      });
      expect(store.of('a').submissions?.map(({ status }) => status)).toEqual([
        'failed',
        'failed',
        'failed',
      ]);
      emit(
        'a',
        connection,
        { type: 'user', id: 'native-3', text: 'Try again' },
        { type: 'closed' },
      );
      expect(store.of('a').submissions?.at(-1)?.status).toBe('cancelled');
      store.reset();
    },
  );
  it('tells whoever sent a message when the turn it starts ends, queued or not', () => {
    vi.useFakeTimers();
    const store = new SessionStore();
    // Never asks for permission, so every turn plays to its end.
    store.setMode('a', 'bypassPermissions');
    const heard: string[] = [];
    const tell = (text: string) => (interrupted: boolean) => {
      heard.push(`${text}${interrupted ? ' (interrupted)' : ''}`);
    };
    store.send('a', 'Claude', 'First', tell('First'));
    store.send('a', 'Claude', 'Second', tell('Second'));
    store.send('a', 'Claude', 'Third', tell('Third'));
    // Taken off the queue before it is sent: it never runs.
    const third = store.of('a').queued[1];
    if (!third) throw new Error('Third is not queued');
    store.unqueue('a', third.id);
    vi.runAllTimers();
    expect(heard).toEqual(['Third (interrupted)', 'First', 'Second']);
    // Stopped mid-turn.
    store.send('a', 'Claude', 'Fourth', tell('Fourth'));
    store.stop('a');
    expect(heard.at(-1)).toBe('Fourth (interrupted)');
  });

  it('tells the user what the run says, in the agent’s session', () => {
    const store = new SessionStore();
    store.notice('a', 'warning', 'corrallm took that as no: the answer wasn’t a clear yes or no.');
    expect(store.of('a').entries).toMatchObject([
      {
        kind: 'notice',
        level: 'warning',
        text: 'corrallm took that as no: the answer wasn’t a clear yes or no.',
      },
    ]);
    expect(store.of('a').status).toBe('idle');
  });

  it('sends a message sent as a turn ends after the ones already queued', () => {
    vi.useFakeTimers();
    const store = new SessionStore();
    store.setMode('a', 'bypassPermissions');
    store.send('a', 'Claude', 'First', () => {
      store.send('a', 'Claude', 'Next');
    });
    store.send('a', 'Claude', 'Second');
    vi.runAllTimers();
    const asked = store.of('a').entries.flatMap((e) => (e.kind === 'user' ? [e.text] : []));
    expect(asked).toEqual(['First', 'Second', 'Next']);
  });
});
