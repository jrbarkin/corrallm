import { afterEach, describe, expect, it, vi } from 'vitest';

import { SessionStore } from './sessions';
import { fakeBackend } from '../test-backend';

afterEach(() => {
  vi.useRealTimers();
});

describe('SessionStore', () => {
  describe('held queues', () => {
    it.each(['reset', 'remove', 'rehold'] as const)(
      'does not dispatch a released queue if %s supersedes it in the same call stack',
      async (next) => {
        const { backend } = fakeBackend();
        const store = new SessionStore(backend);
        store.sync([{ id: 'a', connection: 'sdk' }]);
        store.holdQueue('a', true);
        store.send('a', 'Claude', 'Waiting automation', undefined, undefined, undefined, 'queue');
        store.holdQueue('a', false);
        if (next === 'reset') store.reset();
        else if (next === 'remove') store.sync([]);
        else store.holdQueue('a', true);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(backend.start).not.toHaveBeenCalled();
        expect(backend.send).not.toHaveBeenCalled();
        if (next === 'rehold') {
          expect(store.of('a').queued).toMatchObject([{ text: 'Waiting automation' }]);
          store.holdQueue('a', false);
          await Promise.resolve();
          await Promise.resolve();
          await Promise.resolve();
          expect(backend.send).toHaveBeenCalledExactlyOnceWith(
            'a',
            expect.objectContaining({ text: 'Waiting automation' }),
          );
        }
        store.reset();
      },
    );

    it('finishes the active turn, permits a fresh manual intervention, then resumes waiting messages once in order', async () => {
      const { backend, emit, sent } = fakeBackend();
      const submitted = vi.fn();
      const store = new SessionStore(backend, undefined, { submitted });
      store.sync([{ id: 'a', connection: 'sdk' }]);
      const firstDone = vi.fn();
      store.send('a', 'Claude', 'Active work', firstDone, undefined, undefined, 'queue');
      await Promise.resolve();
      await Promise.resolve();
      const first = sent();
      const queuedDone = vi.fn();
      store.send('a', 'Claude', 'Earlier manual message', queuedDone);
      store.send('a', 'Claude', 'Next automated task', undefined, undefined, undefined, 'queue');
      store.holdQueue('a', true);
      expect(backend.interrupt).not.toHaveBeenCalled();
      emit('a', 'sdk', {
        type: 'end',
        messages: [first],
        seconds: 1,
        interrupted: false,
        failed: false,
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(firstDone).toHaveBeenCalledOnce();
      expect(backend.send).toHaveBeenCalledTimes(1);
      expect(store.of('a').queued.map(({ text }) => text)).toEqual([
        'Earlier manual message',
        'Next automated task',
      ]);

      store.send('a', 'Claude', 'A fresh correction');
      await Promise.resolve();
      await Promise.resolve();
      expect(backend.send).toHaveBeenLastCalledWith(
        'a',
        expect.objectContaining({ text: 'A fresh correction' }),
      );
      const correction = sent();
      emit('a', 'sdk', {
        type: 'end',
        messages: [correction],
        seconds: 1,
        interrupted: false,
        failed: false,
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(store.of('a').submissions).toMatchObject([
        { text: 'Earlier manual message', status: 'queued' },
        { text: 'A fresh correction', status: 'completed' },
      ]);
      expect(submitted).toHaveBeenCalledTimes(2);
      expect(backend.send).toHaveBeenCalledTimes(2);

      store.holdQueue('a', false);
      store.holdQueue('a', false);
      await Promise.resolve();
      await Promise.resolve();
      const manual = sent();
      expect(backend.send).toHaveBeenCalledTimes(3);
      emit('a', 'sdk', {
        type: 'end',
        messages: [manual],
        seconds: 1,
        interrupted: false,
        failed: false,
      });
      await Promise.resolve();
      await Promise.resolve();
      const automated = sent();
      emit('a', 'sdk', {
        type: 'end',
        messages: [automated],
        seconds: 1,
        interrupted: false,
        failed: false,
      });
      expect(backend.send.mock.calls.map(([, message]) => message.text)).toEqual([
        'Active work',
        'A fresh correction',
        'Earlier manual message',
        'Next automated task',
      ]);
      expect(queuedDone).toHaveBeenCalledOnce();
      expect(store.of('a').queued).toEqual([]);
      store.reset();
    });

    it('queues new automation while idle and held without blocking another agent or raw terminal prompts', async () => {
      const { backend, emit } = fakeBackend();
      const store = new SessionStore(backend);
      store.sync([
        { id: 'a', connection: 'terminal' },
        { id: 'b', connection: 'sdk' },
      ]);
      store.holdQueue('a', true);
      store.send('a', 'Claude', 'Held automation', undefined, undefined, undefined, 'queue');
      expect(backend.start).not.toHaveBeenCalled();
      expect(store.of('a').queued).toMatchObject([{ text: 'Held automation' }]);
      store.send('b', 'Claude', 'Other agent', undefined, undefined, undefined, 'queue');
      store.open('a');
      await Promise.resolve();
      await Promise.resolve();
      expect(backend.send.mock.calls.map(([id]) => id)).toEqual(['b']);
      emit('a', 'terminal', { type: 'user', id: 'native', text: 'Typed in the native console' });
      expect(store.of('a').submissions).toMatchObject([
        { id: 'native', text: 'Typed in the native console', status: 'running' },
      ]);
      emit('a', 'terminal', {
        type: 'end',
        messages: ['native'],
        seconds: 1,
        interrupted: false,
        failed: false,
      });
      expect(store.of('a').submissions?.[0]?.status).toBe('completed');
      expect(store.of('a').queued).toHaveLength(1);
      expect(backend.send.mock.calls.map(([id]) => id)).toEqual(['b']);
      store.reset();
    });

    it('does not forward a duplicate stop after an unsent turn ends, so a fresh intervention is safe', async () => {
      const { backend, emit, sent } = fakeBackend();
      let ready: ((value: null) => void) | undefined;
      backend.start.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            ready = resolve;
          }),
      );
      const store = new SessionStore(backend);
      store.sync([{ id: 'a', connection: 'sdk' }]);
      store.holdQueue('a', true);
      const done = vi.fn();
      store.send('a', 'Claude', 'Not yet dispatched', done);
      store.send('a', 'Claude', 'Keep queued');
      store.stop('a');
      store.stop('a');
      expect(done).toHaveBeenCalledOnce();
      expect(store.of('a').status).toBe('idle');
      expect(store.of('a').queued).toMatchObject([{ text: 'Keep queued' }]);
      store.send('a', 'Claude', 'New intervention');
      ready?.(null);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(backend.send.mock.calls.map(([, message]) => message.text)).toEqual([
        'New intervention',
      ]);
      expect(backend.interrupt).not.toHaveBeenCalled();
      emit('a', 'sdk', {
        type: 'end',
        messages: [sent()],
        seconds: 1,
        interrupted: false,
        failed: false,
      });
      expect(store.of('a').submissions).toMatchObject([
        { text: 'Not yet dispatched', status: 'cancelled' },
        { text: 'Keep queued', status: 'queued' },
        { text: 'New intervention', status: 'completed' },
      ]);
      expect(backend.close).not.toHaveBeenCalled();
      store.reset();
    });

    it('interrupts an active turn once and keeps queued work held and the console connected', async () => {
      const { backend, emit, sent } = fakeBackend();
      const store = new SessionStore(backend);
      store.sync([{ id: 'a', connection: 'sdk' }]);
      store.send('a', 'Claude', 'Active');
      await Promise.resolve();
      await Promise.resolve();
      const active = sent();
      store.send('a', 'Claude', 'Waiting');
      store.holdQueue('a', true);
      store.stop('a');
      store.stop('a');
      await Promise.resolve();
      await Promise.resolve();
      expect(backend.interrupt).toHaveBeenCalledExactlyOnceWith('a');
      emit('a', 'sdk', {
        type: 'end',
        messages: [active],
        seconds: 1,
        interrupted: true,
        failed: false,
      });
      expect(store.of('a').queued).toMatchObject([{ text: 'Waiting' }]);
      expect(backend.send).toHaveBeenCalledTimes(1);
      store.send('a', 'Claude', 'Fresh manual turn');
      await Promise.resolve();
      await Promise.resolve();
      store.stop('a');
      await Promise.resolve();
      await Promise.resolve();
      expect(backend.interrupt).toHaveBeenCalledTimes(2);
      expect(backend.close).not.toHaveBeenCalled();
      store.reset();
    });

    it.each(['reset', 'remove'] as const)(
      'clears runtime holds on %s, including agents with no session yet',
      async (action) => {
        const { backend } = fakeBackend();
        const store = new SessionStore(backend);
        store.sync([{ id: 'a', connection: 'sdk' }]);
        store.holdQueue('a', true);
        if (action === 'reset') store.reset();
        else store.sync([]);
        store.sync([{ id: 'a', connection: 'sdk' }]);
        store.send(
          'a',
          'Claude',
          'Runs on the new canvas',
          undefined,
          undefined,
          undefined,
          'queue',
        );
        await Promise.resolve();
        await Promise.resolve();
        expect(backend.send).toHaveBeenCalledExactlyOnceWith(
          'a',
          expect.objectContaining({ text: 'Runs on the new canvas' }),
        );
        store.reset();
      },
    );

    it('allows an interrupt retry after main reports that the first request failed', async () => {
      const { backend } = fakeBackend();
      backend.interrupt.mockRejectedValueOnce(new Error('The interrupt did not reach the CLI'));
      const store = new SessionStore(backend);
      store.sync([{ id: 'a', connection: 'sdk' }]);
      store.send('a', 'Claude', 'Active');
      await Promise.resolve();
      await Promise.resolve();
      store.holdQueue('a', true);
      store.stop('a');
      store.stop('a');
      await vi.waitFor(() => {
        expect(store.of('a').entries.at(-1)).toMatchObject({
          kind: 'notice',
          text: 'The interrupt did not reach the CLI',
        });
      });
      expect(backend.interrupt).toHaveBeenCalledOnce();
      store.stop('a');
      await Promise.resolve();
      await Promise.resolve();
      expect(backend.interrupt).toHaveBeenCalledTimes(2);
      store.reset();
    });

    it('also holds simulated turns after completion and after interruption', async () => {
      vi.useFakeTimers();
      const store = new SessionStore();
      store.setMode('a', 'bypassPermissions');
      const done = vi.fn();
      store.send('a', 'Claude', 'First', done);
      store.send('a', 'Claude', 'Second', done);
      store.holdQueue('a', true);
      vi.runAllTimers();
      expect(done).toHaveBeenCalledOnce();
      expect(store.of('a').queued).toMatchObject([{ text: 'Second' }]);
      store.send('a', 'Claude', 'Intervention', done);
      store.stop('a');
      store.stop('a');
      expect(done).toHaveBeenCalledTimes(2);
      expect(store.of('a').queued).toMatchObject([{ text: 'Second' }]);
      store.holdQueue('a', false);
      await Promise.resolve();
      vi.runAllTimers();
      expect(done).toHaveBeenCalledTimes(3);
      expect(
        store
          .of('a')
          .entries.filter((entry) => entry.kind === 'user')
          .map((entry) => entry.text),
      ).toEqual(['First', 'Intervention', 'Second']);
      store.reset();
    });
  });

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
