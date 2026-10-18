import { afterEach, describe, expect, it, vi } from 'vitest';

import { SessionStore } from './sessions';
import { NEW_SESSION } from './session';
import type { SubmittedMessage } from '../../shared/model/queue';
import { decodeSubmissions, encodeSubmissions } from './submission-state';
import { fakeBackend } from '../test-backend';
import { runCatalog } from '../graph/agents';

/** The run's catalog, as the app gives the sessions. */
const engine = runCatalog();

afterEach(() => {
  vi.useRealTimers();
});

describe('SessionStore', () => {
  it('shows what the run sends in the user’s words as theirs, without taking it for a correction', async () => {
    // An OK's "ask for changes", a repeat's "try this": the run knows which task they are for.
    const { backend, emit, sent } = fakeBackend();
    const submitted = vi.fn();
    const store = new SessionStore(engine, backend, undefined, { submitted });
    store.sync([{ id: 'a', connection: 'claude-code.sdk' }]);
    store.send('a', 'claude-code', 'Use tabs, please', undefined, undefined, undefined, 'run');
    await Promise.resolve();
    await Promise.resolve();
    const id = sent();
    emit('a', 'claude-code.sdk', { type: 'user', id, text: 'Use tabs, please' });
    emit('a', 'claude-code.sdk', {
      type: 'end',
      messages: [id],
      seconds: 1,
      interrupted: false,
      failed: false,
    });
    expect(store.of('a').submissions).toMatchObject([
      { text: 'Use tabs, please', status: 'completed' },
    ]);
    expect(submitted).not.toHaveBeenCalled();
    store.reset();
  });

  describe('held queues', () => {
    it.each(['reset', 'remove', 'rehold'] as const)(
      'does not dispatch a released queue if %s supersedes it in the same call stack',
      async (next) => {
        const { backend } = fakeBackend();
        const store = new SessionStore(engine, backend);
        store.sync([{ id: 'a', connection: 'claude-code.sdk' }]);
        store.holdQueue('a', true);
        store.send(
          'a',
          'claude-code',
          'Waiting automation',
          undefined,
          undefined,
          undefined,
          'queue',
        );
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

    it('finishes the active turn, still sends what the user queued, in order, and holds the run’s own until released', async () => {
      const { backend, emit, sent } = fakeBackend();
      const submitted = vi.fn();
      const store = new SessionStore(engine, backend, undefined, { submitted });
      store.sync([{ id: 'a', connection: 'claude-code.sdk' }]);
      const firstDone = vi.fn();
      store.send('a', 'claude-code', 'Active work', firstDone, undefined, undefined, 'queue');
      await Promise.resolve();
      await Promise.resolve();
      const first = sent();
      const queuedDone = vi.fn();
      store.send('a', 'claude-code', 'Earlier manual message', queuedDone);
      store.send(
        'a',
        'claude-code',
        'Next automated task',
        undefined,
        undefined,
        undefined,
        'queue',
      );
      store.holdQueue('a', true);
      expect(backend.interrupt).not.toHaveBeenCalled();
      const end = (id: string) => {
        emit('a', 'claude-code.sdk', {
          type: 'end',
          messages: [id],
          seconds: 1,
          interrupted: false,
          failed: false,
        });
      };
      end(first);
      await Promise.resolve();
      await Promise.resolve();
      // Held, the session still sends what the user typed, and only the run's own waits.
      expect(firstDone).toHaveBeenCalledOnce();
      expect(backend.send).toHaveBeenLastCalledWith(
        'a',
        expect.objectContaining({ text: 'Earlier manual message' }),
      );
      expect(store.of('a').queued.map(({ text }) => text)).toEqual(['Next automated task']);
      const earlier = sent();

      store.send('a', 'claude-code', 'A fresh correction');
      end(earlier);
      await Promise.resolve();
      await Promise.resolve();
      expect(queuedDone).toHaveBeenCalledOnce();
      expect(backend.send).toHaveBeenLastCalledWith(
        'a',
        expect.objectContaining({ text: 'A fresh correction' }),
      );
      const correction = sent();
      end(correction);
      await Promise.resolve();
      await Promise.resolve();
      expect(store.of('a').submissions).toMatchObject([
        { text: 'Earlier manual message', status: 'completed' },
        { text: 'A fresh correction', status: 'completed' },
      ]);
      expect(submitted).toHaveBeenCalledTimes(2);
      expect(backend.send).toHaveBeenCalledTimes(3);

      store.holdQueue('a', false);
      store.holdQueue('a', false);
      await Promise.resolve();
      await Promise.resolve();
      end(sent());
      expect(backend.send.mock.calls.map(([, message]) => message.text)).toEqual([
        'Active work',
        'Earlier manual message',
        'A fresh correction',
        'Next automated task',
      ]);
      expect(queuedDone).toHaveBeenCalledOnce();
      expect(store.of('a').queued).toEqual([]);
      store.reset();
    });

    it('queues new automation while idle and held without blocking another agent or raw terminal prompts', async () => {
      const { backend, emit } = fakeBackend();
      const store = new SessionStore(engine, backend);
      store.sync([
        { id: 'a', connection: 'claude-code.terminal' },
        { id: 'b', connection: 'claude-code.sdk' },
      ]);
      store.holdQueue('a', true);
      store.send('a', 'claude-code', 'Held automation', undefined, undefined, undefined, 'queue');
      expect(backend.start).not.toHaveBeenCalled();
      expect(store.of('a').queued).toMatchObject([{ text: 'Held automation' }]);
      store.send('b', 'claude-code', 'Other agent', undefined, undefined, undefined, 'queue');
      store.open('a');
      await Promise.resolve();
      await Promise.resolve();
      expect(backend.send.mock.calls.map(([id]) => id)).toEqual(['b']);
      emit('a', 'claude-code.terminal', {
        type: 'user',
        id: 'native',
        text: 'Typed in the native console',
      });
      expect(store.of('a').submissions).toMatchObject([
        { id: 'native', text: 'Typed in the native console', status: 'running' },
      ]);
      emit('a', 'claude-code.terminal', {
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
      const store = new SessionStore(engine, backend);
      store.sync([{ id: 'a', connection: 'claude-code.sdk' }]);
      store.holdQueue('a', true);
      const done = vi.fn();
      store.send('a', 'claude-code', 'Not yet dispatched', done);
      store.send('a', 'claude-code', 'Keep queued');
      store.stop('a');
      store.stop('a');
      expect(done).toHaveBeenCalledOnce();
      expect(store.of('a').status).toBe('idle');
      expect(store.of('a').queued).toMatchObject([{ text: 'Keep queued' }]);
      store.send('a', 'claude-code', 'New intervention');
      ready?.(null);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(backend.send.mock.calls.map(([, message]) => message.text)).toEqual([
        'New intervention',
      ]);
      expect(backend.interrupt).not.toHaveBeenCalled();
      emit('a', 'claude-code.sdk', {
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
      const store = new SessionStore(engine, backend);
      store.sync([{ id: 'a', connection: 'claude-code.sdk' }]);
      store.send('a', 'claude-code', 'Active');
      await Promise.resolve();
      await Promise.resolve();
      const active = sent();
      store.send('a', 'claude-code', 'Waiting');
      store.holdQueue('a', true);
      store.stop('a');
      store.stop('a');
      await Promise.resolve();
      await Promise.resolve();
      expect(backend.interrupt).toHaveBeenCalledExactlyOnceWith('a');
      emit('a', 'claude-code.sdk', {
        type: 'end',
        messages: [active],
        seconds: 1,
        interrupted: true,
        failed: false,
      });
      expect(store.of('a').queued).toMatchObject([{ text: 'Waiting' }]);
      expect(backend.send).toHaveBeenCalledTimes(1);
      store.send('a', 'claude-code', 'Fresh manual turn');
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
        const store = new SessionStore(engine, backend);
        store.sync([{ id: 'a', connection: 'claude-code.sdk' }]);
        store.holdQueue('a', true);
        if (action === 'reset') store.reset();
        else store.sync([]);
        store.sync([{ id: 'a', connection: 'claude-code.sdk' }]);
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
      const store = new SessionStore(engine, backend);
      store.sync([{ id: 'a', connection: 'claude-code.sdk' }]);
      store.send('a', 'claude-code', 'Active');
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
  });

  it('observes the human correction while delivering its wrapped objective, including after queueing', async () => {
    const { backend, emit, sent } = fakeBackend();
    const submitted = vi.fn();
    const ended = vi.fn();
    const store = new SessionStore(engine, backend, undefined, { submitted, ended });
    store.sync([{ id: 'a', connection: 'claude-code.sdk' }]);
    store.send('a', 'claude-code', 'Previous');
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
    emit('a', 'claude-code.sdk', {
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
    const store = new SessionStore(engine, backend);
    store.sync([{ id: 'a', connection: 'claude-code.sdk' }]);
    const done = vi.fn();
    store.send('a', 'claude-code', 'Work', done);
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
      'claude-code.sdk',
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
    const store = new SessionStore(engine, backend, undefined, { submitted, ended });
    store.sync([{ id: 'a', connection: 'claude-code.terminal' }]);
    submitted.mockImplementation((agentId: string, message: { id: string; text: string }) => {
      expect(store.of(agentId).submissions?.some(({ id }) => id === message.id)).toBe(true);
      if (message.text === 'Correction')
        store.tagSubmission(agentId, message.id, 'owner', 'held-task');
    });
    store.send('a', 'claude-code', 'Automation', undefined, undefined, undefined, 'queue');
    await Promise.resolve();
    await Promise.resolve();
    const automated = sent();
    store.send('a', 'claude-code', 'Correction');
    const queued = store.of('a').queued[0];
    if (!queued) throw new Error('No queued correction');
    expect(submitted).toHaveBeenCalledExactlyOnceWith(
      'a',
      expect.objectContaining({ id: queued.id, text: 'Correction', status: 'queued' }),
    );
    store.tagSubmission('a', queued.id, 'owner', 'held-task');
    expect(submitted).toHaveBeenCalledTimes(1);
    emit('a', 'claude-code.terminal', {
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
      'claude-code.terminal',
      { type: 'user', id: queued.id, text: 'Correction' },
      { type: 'user', id: 'native-one', text: 'Native correction' },
      { type: 'user', id: 'native-two', text: 'Still working' },
      { type: 'history', events: [{ type: 'user', id: 'past', text: 'History' }] },
    );
    expect(submitted).toHaveBeenCalledTimes(3);
    const result = { status: 'completed', reason: 'completed' } as const;
    emit(
      'a',
      'claude-code.terminal',
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
    emit('a', 'claude-code.terminal', {
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
    const store = new SessionStore(engine, backend);
    store.sync([{ id: 'a', connection: 'claude-code.sdk' }]);
    store.send('a', 'claude-code', 'Finished');
    await Promise.resolve();
    await Promise.resolve();
    const id = sent();
    emit(
      'a',
      'claude-code.sdk',
      { type: 'text', id: 'private-transcript', text: 'Do not persist this transcript.' },
      {
        type: 'end',
        messages: [id],
        seconds: 1,
        interrupted: false,
        failed: false,
      },
    );
    store.send('a', 'claude-code', 'Unresolved');
    store.send('a', 'claude-code', 'Queued');
    const serialized = store.serializeSubmissions();
    expect(serialized).not.toContain('Do not persist this transcript.');
    const freshBackend = fakeBackend();
    const observer = { submitted: vi.fn(), ended: vi.fn() };
    const restored = new SessionStore(engine, freshBackend.backend, undefined, observer);
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

  it('saves submission text without images and leaves live images intact', () => {
    const store = new SessionStore(engine);
    const images = [{ mediaType: 'image/png', data: 'cGljdHVyZQ==' }] as const;
    store.recordSubmission('a', 'Check this screenshot', [...images]);

    const serialized = store.serializeSubmissions();
    expect(serialized).not.toContain('images');
    expect(serialized).not.toContain(images[0].data);
    expect(store.of('a').submissions?.[0]?.images).toEqual(images);

    const restored = new SessionStore(engine);
    restored.restoreSubmissions(serialized);
    expect(restored.of('a').submissions).toEqual([
      expect.objectContaining({ text: 'Check this screenshot', status: 'completed' }),
    ]);
    expect(restored.of('a').submissions?.[0]?.images).toBeUndefined();
  });

  it.each([1, 101])(
    'saves the newest records while retaining %i old queued records and other unresolved work',
    (queued) => {
      const protectedRecords: SubmittedMessage[] = [
        ...Array.from({ length: queued }, (_, index): SubmittedMessage => ({
          id: `queued-${String(index)}`,
          text: 'Waiting',
          status: 'queued',
        })),
        { id: 'running', text: 'Working', status: 'running' },
        { id: 'unresolved', text: 'Inspect this', status: 'cancelled', unresolved: true },
      ];
      const settled = Array.from({ length: 2100 }, (_, index): SubmittedMessage => ({
        id: `settled-${String(index)}`,
        text: `Message ${String(index)}`,
        status: (['completed', 'failed', 'cancelled'] as const)[index % 3] ?? 'completed',
      }));
      const serialized = encodeSubmissions({
        a: { ...NEW_SESSION, submissions: [...protectedRecords, ...settled] },
        b: { ...NEW_SESSION, submissions: settled },
      });
      const decoded = decodeSubmissions(serialized);
      const room = Math.max(0, 100 - protectedRecords.length);
      expect(decoded.get('a')?.map(({ id }) => id)).toEqual([
        ...protectedRecords.map(({ id }) => id),
        ...(room ? settled.slice(-room).map(({ id }) => id) : []),
      ]);
      expect(decoded.get('a')?.slice(0, protectedRecords.length)).toEqual(
        protectedRecords.map(({ id, text }): unknown =>
          expect.objectContaining({ id, text, unresolved: true }),
        ),
      );
      expect(decoded.get('b')).toEqual(settled.slice(-100));
    },
  );

  it('bounds saved submission text across agents even far beyond the file size limit', () => {
    const text = 'Line with "quotes" あ\n'.repeat(9_000);
    const submissions = Array.from({ length: 100 }, (_, index): SubmittedMessage => ({
      id: `message-${String(index)}`,
      text,
      status: 'completed',
    }));
    const serialized = encodeSubmissions({
      active: {
        ...NEW_SESSION,
        submissions: [{ id: 'active', text, status: 'running' }],
      },
      a: { ...NEW_SESSION, submissions },
      b: { ...NEW_SESSION, submissions },
    });
    expect(new TextEncoder().encode(serialized).length).toBeLessThanOrEqual(4 * 1024 * 1024);
    const restored = new SessionStore(engine);
    restored.restoreSubmissions(serialized);
    expect(restored.of('active').submissions).toMatchObject([
      { id: 'active', text, status: 'cancelled', unresolved: true },
    ]);
    const saved = ['a', 'b'].flatMap((id) => restored.of(id).submissions ?? []);
    expect(saved.length).toBeGreaterThan(0);
    expect(saved.length).toBeLessThan(submissions.length * 2);
    for (const id of ['a', 'b']) {
      const records = restored.of(id).submissions ?? [];
      expect(records).toEqual(records.length ? submissions.slice(-records.length) : []);
    }
  });

  it('keeps saved history readable when many agents reach their record limits', () => {
    const sessions = Object.fromEntries(
      Array.from({ length: 21 }, (_, index) => [
        `agent-${String(index)}`,
        {
          ...NEW_SESSION,
          submissions: Array.from({ length: 100 }, (_, index): SubmittedMessage => ({
            id: `message-${String(index)}`,
            text: 'Finished',
            status: 'completed',
          })),
        },
      ]),
    );
    const restored = decodeSubmissions(encodeSubmissions(sessions));
    const records = [...restored.values()].flat();
    expect(records.length).toBeGreaterThan(0);
    expect(records.length).toBeLessThanOrEqual(2000);
  });

  it('records commands handled locally without sending a turn', () => {
    const { backend } = fakeBackend();
    const store = new SessionStore(engine, backend);
    store.recordSubmission('a', '/mcp');
    expect(store.of('a').submissions).toMatchObject([{ text: '/mcp', status: 'completed' }]);
    expect(backend.send).not.toHaveBeenCalled();
    expect(store.of('a').entries).toEqual([]);
  });

  it('keeps one manual message queued after refusal and sends it once after switching', async () => {
    const { backend, emit, sent } = fakeBackend();
    const store = new SessionStore(engine, backend);
    store.sync([{ id: 'a', connection: 'claude-code.sdk' }]);
    backend.start.mockImplementationOnce(() => {
      emit('a', 'claude-code.sdk', {
        type: 'notice',
        id: 'refusal',
        level: 'error',
        text: 'Use Terminal',
        switchTo: 'claude-code.terminal',
      });
      return Promise.reject(new Error('Use Terminal'));
    });
    store.send('a', 'claude-code', 'Keep this');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const id = store.of('a').submissions?.[0]?.id;
    if (!id) throw new Error('No recorded message');
    expect(store.of('a').submissions).toMatchObject([{ id, text: 'Keep this', status: 'queued' }]);
    store.sync([{ id: 'a', connection: 'claude-code.terminal' }]);
    await Promise.resolve();
    await Promise.resolve();
    expect(sent()).toBe(id);
    expect(store.of('a').submissions).toMatchObject([{ id, status: 'running' }]);
    emit('a', 'claude-code.terminal', {
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
  it('records each manual submission once, including queued images and cancellation', async () => {
    const { backend, emit, sent } = fakeBackend();
    const store = new SessionStore(engine, backend, () => 'held-step');
    store.sync([{ id: 'a', connection: 'claude-code.sdk' }]);
    store.send('a', 'claude-code', 'First');
    store.send('a', 'claude-code', '', undefined, [{ mediaType: 'image/png', data: 'picture' }]);
    const cancel = store.send('a', 'claude-code', 'First');
    cancel();
    expect(store.of('a').submissions).toMatchObject([
      { text: 'First', status: 'running', after: 'held-step' },
      { text: '', status: 'queued', images: [{ data: 'picture' }] },
      { text: 'First', status: 'cancelled' },
    ]);
    for (let turn = 0; turn < 2; turn++) {
      await Promise.resolve();
      await Promise.resolve();
      emit('a', 'claude-code.sdk', {
        type: 'end',
        messages: [sent()],
        seconds: 1,
        interrupted: false,
        failed: false,
      });
    }
    expect(store.of('a').submissions?.map(({ status }) => status)).toEqual([
      'completed',
      'completed',
      'cancelled',
    ]);
    expect(new Set(store.of('a').submissions?.map(({ id }) => id)).size).toBe(3);
    store.send('a', 'claude-code', 'Interrupted');
    await Promise.resolve();
    await Promise.resolve();
    store.stop('a');
    emit('a', 'claude-code.sdk', {
      type: 'end',
      messages: [sent()],
      seconds: 1,
      interrupted: true,
      failed: false,
    });
    expect(store.of('a').submissions?.at(-1)?.status).toBe('cancelled');
    store.reset();
    expect(store.of('a').submissions).toBeUndefined();
  });

  it.each([
    'claude-code.terminal',
    'codex.terminal',
    'claude-code.sdk',
    'codex.app-server',
  ] as const)(
    'records live %s prompts, excludes automation and restored history, and correlates turn ends',
    async (connection) => {
      const { backend, emit, sent } = fakeBackend();
      const store = new SessionStore(engine, backend);
      store.sync([{ id: 'a', connection }]);
      store.send('a', 'claude-code', 'Automated step', undefined, undefined, undefined, 'queue');
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
      store.send('a', 'claude-code', 'Manual');
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
  it('tells whoever sent a message when the native turn it starts ends, queued or not', async () => {
    const { backend, emit, sent } = fakeBackend();
    const store = new SessionStore(engine, backend);
    store.sync([{ id: 'a', connection: 'claude-code.sdk' }]);
    const heard: string[] = [];
    const tell = (text: string) => (interrupted: boolean) => {
      heard.push(`${text}${interrupted ? ' (interrupted)' : ''}`);
    };
    store.send('a', 'claude-code', 'First', tell('First'));
    store.send('a', 'claude-code', 'Second', tell('Second'));
    store.send('a', 'claude-code', 'Third', tell('Third'));
    const third = store.of('a').queued[1];
    if (!third) throw new Error('Third is not queued');
    store.unqueue('a', third.id);
    for (let turn = 0; turn < 2; turn++) {
      await Promise.resolve();
      await Promise.resolve();
      emit('a', 'claude-code.sdk', {
        type: 'end',
        messages: [sent()],
        seconds: 1,
        interrupted: false,
        failed: false,
      });
    }
    expect(heard).toEqual(['Third (interrupted)', 'First', 'Second']);
    store.send('a', 'claude-code', 'Fourth', tell('Fourth'));
    await Promise.resolve();
    await Promise.resolve();
    store.stop('a');
    emit('a', 'claude-code.sdk', {
      type: 'end',
      messages: [sent()],
      seconds: 1,
      interrupted: true,
      failed: false,
    });
    expect(heard.at(-1)).toBe('Fourth (interrupted)');
    store.reset();
  });

  it('tells the user what the run says, in the agent’s session', () => {
    const store = new SessionStore(engine);
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

  it('sends a message sent as a native turn ends after the ones already queued', async () => {
    const { backend, emit, sent } = fakeBackend();
    const store = new SessionStore(engine, backend);
    store.sync([{ id: 'a', connection: 'claude-code.sdk' }]);
    store.send('a', 'claude-code', 'First', () => {
      store.send('a', 'claude-code', 'Next');
    });
    store.send('a', 'claude-code', 'Second');
    for (let turn = 0; turn < 3; turn++) {
      await Promise.resolve();
      await Promise.resolve();
      emit('a', 'claude-code.sdk', {
        type: 'end',
        messages: [sent()],
        seconds: 1,
        interrupted: false,
        failed: false,
      });
    }
    expect(backend.send.mock.calls.map(([, message]) => message.text)).toEqual([
      'First',
      'Second',
      'Next',
    ]);
    store.reset();
  });
});

describe('submission retention', () => {
  it('keeps the newest 100 settled records and every queued, running or unresolved record', () => {
    const { backend } = fakeBackend();
    const store = new SessionStore(engine, backend);
    store.restoreSubmissions(
      JSON.stringify({
        version: 1,
        agents: [
          {
            id: 'a',
            submissions: [
              { id: 'unresolved', text: 'Unresolved', status: 'cancelled', unresolved: true },
            ],
          },
        ],
      }),
    );
    store.sync([{ id: 'a', connection: 'claude-code.sdk' }]);
    store.send('a', 'claude-code', 'Running');
    store.send('a', 'claude-code', 'Queued');
    store.holdQueue('a', true);
    for (let index = 0; index < 105; index++)
      store.recordSubmission('a', `Command ${String(index)}`);
    expect(store.of('a').submissions).toHaveLength(103);
    expect(store.of('a').submissions?.slice(0, 3)).toMatchObject([
      { text: 'Unresolved', status: 'cancelled', unresolved: true },
      { text: 'Running', status: 'running' },
      { text: 'Queued', status: 'queued' },
    ]);
    expect(
      store
        .of('a')
        .submissions?.slice(3)
        .map(({ text }) => text),
    ).toEqual(Array.from({ length: 100 }, (_, index) => `Command ${String(index + 5)}`));
    store.reset();
  });

  it('prunes older settled records when a native prompt is added', () => {
    const { backend, emit } = fakeBackend();
    const store = new SessionStore(engine, backend);
    store.sync([{ id: 'a', connection: 'claude-code.terminal' }]);
    store.open('a');
    for (let index = 0; index < 105; index++) {
      const id = `native-${String(index)}`;
      emit(
        'a',
        'claude-code.terminal',
        { type: 'user', id, text: `Prompt ${String(index)}` },
        { type: 'end', messages: [id], seconds: 1, interrupted: false, failed: false },
      );
    }
    emit('a', 'claude-code.terminal', { type: 'user', id: 'latest', text: 'Still running' });
    expect(store.of('a').submissions).toHaveLength(101);
    expect(
      store
        .of('a')
        .submissions?.slice(0, -1)
        .map(({ text }) => text),
    ).toEqual(Array.from({ length: 100 }, (_, index) => `Prompt ${String(index + 5)}`));
    expect(store.of('a').submissions?.at(-1)).toMatchObject({
      text: 'Still running',
      status: 'running',
    });
    store.reset();
  });
});
