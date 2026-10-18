import { describe, expect, it, vi } from 'vitest';

import { fakeBackend } from '../test-backend';
import { SessionStore } from './sessions';
import type { Refusal } from './session';

const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe('sessions without placeholder execution', () => {
  it.each([
    { adapter: 'claude-code', connection: 'claude-code.terminal' },
    { adapter: 'codex', connection: 'codex.terminal' },
  ] as const)(
    'dispatches a default $adapter session through its actual native backend',
    async ({ adapter: agent, connection }) => {
      const { backend, emit, sent } = fakeBackend();
      const store = new SessionStore(backend);
      const done = vi.fn();
      store.send('a', agent, 'Inspect the actual project', done);
      await settle();
      expect(backend.start).toHaveBeenCalledExactlyOnceWith('a', {
        connection,
        model: null,
        mode: null,
      });
      expect(backend.send).toHaveBeenCalledExactlyOnceWith(
        'a',
        expect.objectContaining({ text: 'Inspect the actual project' }),
      );
      expect(store.of('a').entries.map(({ kind }) => kind)).toEqual(['user']);
      expect(done).not.toHaveBeenCalled();
      emit(
        'a',
        connection,
        { type: 'text', id: 'answer', text: 'Native answer.' },
        { type: 'end', messages: [sent()], seconds: 1, interrupted: false, failed: false },
      );
      expect(done).toHaveBeenCalledExactlyOnceWith(false, 'Native answer.', {
        status: 'completed',
        reason: 'completed',
      });
      store.reset();
    },
  );

  it.each(['Qwen', 'Gemini'] as const)(
    'keeps unsupported %s work unsent and refused without inventing a turn or completion',
    async (agent) => {
      const { backend } = fakeBackend();
      const store = new SessionStore(backend);
      store.sync([{ id: 'a', connection: 'unavailable' }]);
      store.open('a');
      const done = vi.fn();
      const refused = vi.fn<(refusal: Refusal) => void>();
      const secondRefused = vi.fn<(refusal: Refusal) => void>();
      store.send('a', agent, 'Keep this work', done, undefined, refused);
      store.send('a', agent, 'Then this', done, undefined, secondRefused);
      expect(refused).not.toHaveBeenCalled();
      await settle();
      expect(refused).toHaveBeenCalled();
      expect(secondRefused).toHaveBeenCalledOnce();
      expect(refused.mock.calls[0]?.[0].text).toMatch(/Choose Claude or Codex/);
      expect(refused.mock.calls[0]?.[0].switchTo).toBeUndefined();
      expect(backend.start).not.toHaveBeenCalled();
      expect(backend.send).not.toHaveBeenCalled();
      expect(store.of('a').status).toBe('idle');
      expect(store.of('a').queued.map(({ text }) => text)).toEqual(['Keep this work', 'Then this']);
      expect(store.of('a').entries).toMatchObject([{ kind: 'notice', level: 'error' }]);
      expect(store.of('a').entries).toHaveLength(1);
      expect(store.of('a').submissions).toMatchObject([
        { text: 'Keep this work', status: 'queued' },
        { text: 'Then this', status: 'queued' },
      ]);
      expect(done).not.toHaveBeenCalled();
      store.reset();
    },
  );

  it('sends refused work once when a supported connection is chosen, including a same-stack switch', async () => {
    const { backend } = fakeBackend();
    const store = new SessionStore(backend);
    store.sync([{ id: 'a', connection: 'unavailable' }]);
    const refused = vi.fn<(refusal: Refusal) => void>();
    store.send('a', 'qwen', 'Preserve the objective', undefined, undefined, refused);
    store.sync([{ id: 'a', connection: 'claude-code.sdk' }]);
    await settle();
    expect(refused).not.toHaveBeenCalled();
    expect(backend.send).toHaveBeenCalledExactlyOnceWith(
      'a',
      expect.objectContaining({ text: 'Preserve the objective' }),
    );
    expect(store.of('a').queued).toEqual([]);
    expect(store.of('a').submissions).toHaveLength(1);
    store.reset();
  });
  it('uses an unsupported agent’s default without starting any native backend', async () => {
    const { backend } = fakeBackend();
    const store = new SessionStore(backend);
    const refused = vi.fn<(refusal: Refusal) => void>();
    store.send('a', 'qwen', 'Keep unsent', undefined, undefined, refused);
    await settle();
    expect(backend.start).not.toHaveBeenCalled();
    expect(refused).toHaveBeenCalledOnce();
    expect(store.of('a').queued).toMatchObject([{ text: 'Keep unsent' }]);
    store.reset();
  });

  it('drops a stale unsupported refusal when a held recipient changes to a native connection', async () => {
    const { backend } = fakeBackend();
    const store = new SessionStore(backend);
    store.sync([{ id: 'a', connection: 'unavailable' }]);
    const refused = vi.fn<(refusal: Refusal) => void>();
    store.send(
      'a',
      'Qwen',
      'Wait for the supported connection',
      undefined,
      undefined,
      refused,
      'queue',
    );
    store.holdQueue('a', true);
    store.sync([{ id: 'a', connection: 'claude-code.sdk' }]);
    await settle();
    expect(refused).not.toHaveBeenCalled();
    expect(backend.send).not.toHaveBeenCalled();
    store.holdQueue('a', false);
    await settle();
    expect(backend.send).toHaveBeenCalledOnce();
    store.reset();
  });
});
