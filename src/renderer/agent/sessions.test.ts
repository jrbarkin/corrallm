import { afterEach, describe, expect, it, vi } from 'vitest';

import { SessionStore } from './sessions';
import { fakeBackend } from '../test-backend';

afterEach(() => {
  vi.useRealTimers();
});

describe('SessionStore', () => {
  it('observes the human correction while delivering its wrapped objective, including after queueing', async () => {
    const { backend, emit, sent } = fakeBackend();
    const submitted = vi.fn();
    const ended = vi.fn();
    const store = new SessionStore(backend, undefined, { submitted, ended });
    store.sync([{ id: 'a', connection: 'sdk' }]);
    store.send('a', 'Claude', 'Previous');
    await Promise.resolve();
    await Promise.resolve();
    const previous = sent();
    const wrapped =
      'Original objective: ship the feature. Correction: preserve backwards compatibility. Report SUCCEEDED or FAILED.';
    store.send(
      'a',
      'Claude',
      wrapped,
      undefined,
      undefined,
      undefined,
      'user',
      'Preserve backwards compatibility',
    );
    const correction = store.of('a').submissions?.at(-1);
    expect(correction).toMatchObject({
      text: 'Preserve backwards compatibility',
      status: 'queued',
    });
    expect(submitted).toHaveBeenLastCalledWith('a', correction);
    emit('a', 'sdk', {
      type: 'end',
      messages: [previous],
      seconds: 1,
      interrupted: false,
      failed: false,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(backend.send).toHaveBeenLastCalledWith('a', { id: correction?.id, text: wrapped });
    expect(store.of('a').submissions?.at(-1)?.text).toBe('Preserve backwards compatibility');
    expect(submitted).toHaveBeenCalledTimes(2);
    store.reset();
  });

  it('preserves a typed failure and its reset through callbacks and the submitted row', async () => {
    const { backend, emit, sent } = fakeBackend();
    const store = new SessionStore(backend);
    store.sync([{ id: 'a', connection: 'sdk' }]);
    const done = vi.fn();
    store.send('a', 'Claude', 'Work', done);
    await Promise.resolve();
    await Promise.resolve();
    const id = sent();
    const result = {
      status: 'failed',
      reason: 'usage-limit',
      message: 'Weekly limit reached',
      resetsAt: 1_800_000_000_000,
    } as const;
    emit(
      'a',
      'sdk',
      { type: 'text', id: 'reply', text: 'Try after the reset.' },
      {
        type: 'end',
        messages: [id],
        seconds: 1,
        interrupted: false,
        failed: true,
        result,
      },
    );
    expect(done).toHaveBeenCalledWith(true, 'Try after the reset.', result);
    expect(store.of('a').submissions?.[0]).toMatchObject({ result, reply: 'Try after the reset.' });
    expect(store.of('a').entries.at(-1)).toMatchObject({ kind: 'end', result });
    store.reset();
  });

  it('observes manual submissions once at submission time, and ends exact native message ids', async () => {
    const { backend, emit, sent } = fakeBackend();
    const submitted = vi.fn();
    const ended = vi.fn();
    const store = new SessionStore(backend, undefined, { submitted, ended });
    store.sync([{ id: 'a', connection: 'terminal' }]);
    submitted.mockImplementation((agentId: string, message: { id: string; text: string }) => {
      expect(store.of(agentId).submissions?.some(({ id }) => id === message.id)).toBe(true);
      if (message.text === 'Correction')
        store.tagSubmission(agentId, message.id, 'owner', 'held-task');
    });
    store.send('a', 'Claude', 'Automation', undefined, undefined, undefined, 'queue');
    await Promise.resolve();
    await Promise.resolve();
    const automated = sent();
    store.send('a', 'Claude', 'Correction');
    const queued = store.of('a').queued[0];
    if (!queued) throw new Error('No queued correction');
    expect(submitted).toHaveBeenCalledExactlyOnceWith(
      'a',
      expect.objectContaining({ id: queued.id, text: 'Correction', status: 'queued' }),
    );
    store.tagSubmission('a', queued.id, 'owner', 'held-task');
    expect(submitted).toHaveBeenCalledTimes(1);
    emit('a', 'terminal', {
      type: 'end',
      messages: [automated],
      seconds: 1,
      interrupted: false,
      failed: false,
    });
    await Promise.resolve();
    await Promise.resolve();
    emit(
      'a',
      'terminal',
      { type: 'user', id: queued.id, text: 'Correction' },
      { type: 'user', id: 'native-one', text: 'Native correction' },
      { type: 'user', id: 'native-two', text: 'Still working' },
      { type: 'history', events: [{ type: 'user', id: 'past', text: 'History' }] },
    );
    expect(submitted).toHaveBeenCalledTimes(3);
    const result = { status: 'completed', reason: 'completed' } as const;
    emit(
      'a',
      'terminal',
      { type: 'text', id: 'reply', text: 'Updated.' },
      {
        type: 'end',
        messages: [queued.id, 'native-one'],
        seconds: 1,
        interrupted: false,
        failed: false,
        result,
      },
    );
    expect(ended.mock.calls).toEqual([
      ['a', queued.id, 'Updated.', result],
      ['a', 'native-one', 'Updated.', result],
    ]);
    expect(store.of('a').submissions).toMatchObject([
      { id: queued.id, task: { agent: 'owner', item: 'held-task' }, status: 'completed' },
      { id: 'native-one', status: 'completed' },
      { id: 'native-two', status: 'running' },
    ]);
    emit('a', 'terminal', {
      type: 'end',
      messages: ['native-two'],
      seconds: 1,
      interrupted: true,
      failed: false,
    });
    expect(ended).toHaveBeenLastCalledWith('a', 'native-two', 'Updated.', {
      status: 'cancelled',
      reason: 'interrupted',
    });
    expect(ended).toHaveBeenCalledTimes(3);
    store.reset();
  });

  it('serializes only submission records and restores unresolved work without dispatching it', async () => {
    const { backend, emit, sent } = fakeBackend();
    const store = new SessionStore(backend);
    store.sync([{ id: 'a', connection: 'sdk' }]);
    store.send('a', 'Claude', 'Finished');
    await Promise.resolve();
    await Promise.resolve();
    const id = sent();
    emit(
      'a',
      'sdk',
      { type: 'text', id: 'private-transcript', text: 'Do not persist this transcript.' },
      {
        type: 'end',
        messages: [id],
        seconds: 1,
        interrupted: false,
        failed: false,
      },
    );
    store.send('a', 'Claude', 'Unresolved');
    store.send('a', 'Claude', 'Queued');
    const serialized = store.serializeSubmissions();
    expect(serialized).not.toContain('Do not persist this transcript.');
    const freshBackend = fakeBackend();
    const observer = { submitted: vi.fn(), ended: vi.fn() };
    const restored = new SessionStore(freshBackend.backend, undefined, observer);
    restored.restoreSubmissions(serialized);
    expect(restored.of('a').submissions).toMatchObject([
      { text: 'Finished', status: 'completed' },
      { text: 'Unresolved', status: 'cancelled', unresolved: true },
      { text: 'Queued', status: 'cancelled', unresolved: true },
    ]);
    expect(restored.of('a').entries).toEqual([]);
    expect(restored.of('a').queued).toEqual([]);
    expect(freshBackend.backend.start).not.toHaveBeenCalled();
    expect(freshBackend.backend.send).not.toHaveBeenCalled();
    expect(observer.submitted).not.toHaveBeenCalled();
    expect(observer.ended).not.toHaveBeenCalled();
    const before = restored.serializeSubmissions();
    for (const invalid of [
      'not JSON',
      '{"version":99,"agents":[]}',
      '{"version":1,"agents":[{"id":"__proto__","submissions":[]}]}',
    ]) {
      expect(() => {
        restored.restoreSubmissions(invalid);
      }).toThrow();
      expect(restored.serializeSubmissions()).toBe(before);
    }
    const invalidRecord = (submissions: unknown[]) =>
      JSON.stringify({ version: 1, agents: [{ id: 'a', submissions }] });
    const valid = { id: 'valid', text: 'Stored message', status: 'completed' };
    for (const invalid of [
      invalidRecord([{ ...valid, unexpected: true }]),
      invalidRecord([{ ...valid, result: { status: 'failed', reason: 'run-command' } }]),
      invalidRecord([{ ...valid, task: { agent: 'a', item: '__proto__' } }]),
      invalidRecord(
        Array.from({ length: 2001 }, (_, index) => ({ ...valid, id: `record-${String(index)}` })),
      ),
    ]) {
      expect(() => {
        restored.restoreSubmissions(invalid);
      }).toThrow();
      expect(restored.serializeSubmissions()).toBe(before);
    }
    store.reset();
    restored.reset();
  });

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
