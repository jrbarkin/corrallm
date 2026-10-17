import { describe, expect, it, vi } from 'vitest';

import { CONNECTIONS } from '../../shared/session';
import { fakeBackend } from '../test-backend';
import { SessionStore } from './sessions';

describe('authored session roles', () => {
  it('does not record the role as a manual submission or send it as a user message', async () => {
    const { backend } = fakeBackend();
    const store = new SessionStore(backend);
    store.sync([{ id: 'a', connection: 'sdk', role: 'Persistent release reviewer instructions' }]);
    store.send('a', 'Claude', 'Review this change');
    await vi.waitFor(() => {
      expect(backend.send).toHaveBeenCalledOnce();
    });
    expect(backend.send).toHaveBeenLastCalledWith(
      'a',
      expect.objectContaining({ text: 'Review this change' }),
    );
    expect(store.of('a').submissions).toMatchObject([{ text: 'Review this change' }]);
    expect(
      store
        .of('a')
        .entries.some(
          (entry) =>
            entry.kind === 'user' &&
            entry.text.includes('Persistent release reviewer instructions'),
        ),
    ).toBe(false);
    expect(store.serializeSubmissions()).not.toContain('Persistent release reviewer instructions');
    store.reset();
  });

  it('does not interrupt active work when its desired role changes', async () => {
    const { backend, emit, sent } = fakeBackend();
    const store = new SessionStore(backend);
    store.sync([{ id: 'a', connection: 'sdk', role: 'Original role' }]);
    store.send('a', 'Claude', 'Current task');
    await vi.waitFor(() => {
      expect(backend.send).toHaveBeenCalledOnce();
    });
    store.sync([{ id: 'a', connection: 'sdk', role: 'Revised role' }]);
    expect(store.of('a').running).toEqual({ role: 'Original role' });
    expect(backend.start).toHaveBeenCalledOnce();
    expect(backend.close).not.toHaveBeenCalled();
    expect(backend.interrupt).not.toHaveBeenCalled();
    emit('a', 'sdk', {
      type: 'end',
      messages: [sent()],
      seconds: 1,
      interrupted: false,
      failed: false,
    });
    await store.restart('a');
    await vi.waitFor(() => {
      expect(store.of('a').running).toEqual({ role: 'Revised role' });
    });
    store.reset();
  });

  it.each(CONNECTIONS)(
    'starts %s with the role and captures it with its running settings',
    async (connection) => {
      const { backend } = fakeBackend();
      const store = new SessionStore(backend);
      store.sync([{ id: 'a', connection, role: '  Review releases.\n\tCheck the rollout.  ' }]);
      store.open('a');
      expect(backend.start).toHaveBeenCalledExactlyOnceWith('a', {
        connection,
        model: null,
        mode: null,
        role: 'Review releases.\n\tCheck the rollout.',
      });
      await vi.waitFor(() => {
        expect(store.of('a').running).toEqual({ role: 'Review releases.\n\tCheck the rollout.' });
      });
      store.reset();
    },
  );

  it('keeps the startup role until an explicit restart, even if editing while its start is pending', async () => {
    const { backend } = fakeBackend();
    let started: (() => void) | undefined;
    backend.start.mockImplementationOnce(
      () =>
        new Promise<null>((resolve) => {
          started = () => {
            resolve(null);
          };
        }),
    );
    const store = new SessionStore(backend);
    store.sync([{ id: 'a', connection: 'sdk', role: 'Original role' }]);
    store.open('a');
    store.sync([{ id: 'a', connection: 'sdk', role: 'New role' }]);
    store.open('a');
    expect(backend.start).toHaveBeenCalledTimes(1);
    expect(backend.close).not.toHaveBeenCalled();
    expect(backend.interrupt).not.toHaveBeenCalled();
    started?.();
    await vi.waitFor(() => {
      expect(store.of('a').running).toEqual({ role: 'Original role' });
    });
    await store.restart('a');
    await vi.waitFor(() => {
      expect(store.of('a').running).toEqual({ role: 'New role' });
    });
    expect(backend.start).toHaveBeenLastCalledWith('a', {
      connection: 'sdk',
      model: null,
      mode: null,
      role: 'New role',
    });
    store.reset();
  });

  it('keeps the role separate while switching CLIs and resuming another native conversation', async () => {
    const { backend } = fakeBackend();
    const store = new SessionStore(backend);
    const settings = { claude: { model: 'haiku' }, codex: { model: 'gpt-6-luna' } };
    store.sync([{ id: 'a', connection: 'sdk', settings, role: 'Release reviewer' }]);
    store.open('a');
    await vi.waitFor(() => {
      expect(store.of('a').running).toEqual({ model: 'haiku', role: 'Release reviewer' });
    });
    store.sync([{ id: 'a', connection: 'app-server', settings, role: 'Release reviewer' }]);
    store.open('a');
    await vi.waitFor(() => {
      expect(store.of('a').running).toEqual({ model: 'gpt-6-luna', role: 'Release reviewer' });
    });
    await store.resume('a', '11111111-1111-4111-8111-111111111111');
    await vi.waitFor(() => {
      expect(backend.start).toHaveBeenCalledTimes(3);
    });
    expect(backend.start).toHaveBeenLastCalledWith('a', {
      connection: 'app-server',
      model: 'gpt-6-luna',
      mode: null,
      role: 'Release reviewer',
    });
    expect(settings).toEqual({ claude: { model: 'haiku' }, codex: { model: 'gpt-6-luna' } });
    store.reset();
  });

  it('clears a removed role on restart, removal and reset without leaking into another agent', async () => {
    const { backend } = fakeBackend();
    const store = new SessionStore(backend);
    store.sync([
      { id: 'a', connection: 'sdk', role: 'Reviewer' },
      { id: 'b', connection: 'sdk' },
    ]);
    store.open('a');
    store.open('b');
    expect(backend.start).toHaveBeenLastCalledWith('b', {
      connection: 'sdk',
      model: null,
      mode: null,
    });
    store.sync([{ id: 'a', connection: 'sdk', role: ' \n ' }]);
    await store.restart('a');
    await vi.waitFor(() => {
      expect(store.of('a').running).toEqual({});
    });
    expect(backend.start).toHaveBeenLastCalledWith('a', {
      connection: 'sdk',
      model: null,
      mode: null,
    });
    store.sync([{ id: 'a', connection: 'sdk', role: 'Old role' }]);
    store.sync([]);
    store.sync([{ id: 'a', connection: 'sdk' }]);
    store.open('a');
    expect(backend.start).toHaveBeenLastCalledWith('a', {
      connection: 'sdk',
      model: null,
      mode: null,
    });
    store.sync([{ id: 'a', connection: 'sdk', role: 'Old role' }]);
    store.reset();
    store.open('a');
    expect(backend.start).toHaveBeenLastCalledWith('a', {
      connection: 'sdk',
      model: null,
      mode: null,
    });
    store.reset();
  });
});
