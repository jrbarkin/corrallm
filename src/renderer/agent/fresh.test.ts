import { describe, expect, it, vi } from 'vitest';

import { adapterOf, catalog } from '../catalog';
import { fakeBackend } from '../test-backend';
import { SessionStore } from './sessions';
import { runCatalog } from '../graph/agents';

/** The run's catalog, as the app gives the sessions. */
const engine = runCatalog();

const settled = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

/** Keeps the durable forget pending so transitions cannot accidentally reopen an obsolete agent. */
function deferred() {
  let resolve!: (value: null) => void;
  const promise = new Promise<null>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('starting a fresh native conversation', () => {
  it.each(catalog().adapters.flatMap((adapter) => adapter.connections.map((one) => one.id)))(
    'opens %s with the latest role and settings without resending any user message',
    async (connection) => {
      const { backend, emit, sent } = fakeBackend();
      const store = new SessionStore(engine, backend);
      store.sync([{ id: 'a', connection, role: 'Old role' }]);
      store.send('a', 'claude-code', 'Earlier manual work');
      await vi.waitFor(() => {
        expect(backend.send).toHaveBeenCalledOnce();
      });
      emit('a', connection, {
        type: 'end',
        messages: [sent()],
        seconds: 1,
        interrupted: false,
        failed: false,
      });
      const submissions = store.of('a').submissions;
      const cli = adapterOf(connection);
      store.sync([
        {
          id: 'a',
          connection,
          role: 'Revised role',
          settings: { [cli]: { model: 'new-model', effort: 'low' } },
        },
      ]);
      await store.fresh('a');
      await vi.waitFor(() => {
        expect(backend.start).toHaveBeenCalledTimes(2);
      });
      expect(backend.fresh).toHaveBeenCalledExactlyOnceWith('a', cli);
      expect(backend.start).toHaveBeenLastCalledWith('a', {
        connection,
        model: 'new-model',
        mode: null,
        effort: 'low',
        role: 'Revised role',
      });
      expect(store.of('a').entries).toEqual([]);
      expect(store.of('a').submissions).toEqual(submissions);
      expect(store.of('a').running).toEqual({
        model: 'new-model',
        effort: 'low',
        role: 'Revised role',
      });
      expect(backend.send).toHaveBeenCalledOnce();
      expect(backend.resume).not.toHaveBeenCalled();
      store.reset();
    },
  );

  it('can replace a restored Codex conversation before any renderer driver exists', async () => {
    const { backend } = fakeBackend();
    const store = new SessionStore(engine, backend);
    store.sync([{ id: 'a', connection: 'codex.app-server', role: 'New role' }]);
    await store.fresh('a');
    await settled();
    expect(backend.fresh).toHaveBeenCalledExactlyOnceWith('a', 'codex');
    expect(backend.start).toHaveBeenCalledExactlyOnceWith('a', {
      connection: 'codex.app-server',
      model: null,
      mode: null,
      role: 'New role',
    });
    expect(backend.send).not.toHaveBeenCalled();
    expect(store.of('a').submissions).toBeUndefined();
    store.reset();
  });

  it.each(['working', 'waiting'] as const)(
    'does not clear or interrupt a %s conversation',
    async (status) => {
      const { backend, emit } = fakeBackend();
      const store = new SessionStore(engine, backend);
      store.sync([{ id: 'a', connection: 'codex.app-server' }]);
      store.send('a', 'codex', 'Current work');
      await settled();
      emit('a', 'codex.app-server', { type: 'status', status });
      await store.fresh('a');
      expect(backend.fresh).not.toHaveBeenCalled();
      expect(backend.close).not.toHaveBeenCalled();
      expect(backend.interrupt).not.toHaveBeenCalled();
      expect(backend.start).toHaveBeenCalledOnce();
      store.reset();
    },
  );

  it('does nothing for unsupported or unknown agents', async () => {
    const { backend } = fakeBackend();
    const store = new SessionStore(engine, backend);
    store.sync([{ id: 'a', connection: 'unavailable', role: 'A role' }]);
    await store.fresh('a');
    await store.fresh('missing');
    expect(backend.fresh).not.toHaveBeenCalled();
    expect(backend.start).not.toHaveBeenCalled();
    store.reset();
  });

  it('leaves the visible conversation intact when the durable clear fails', async () => {
    const { backend } = fakeBackend();
    const store = new SessionStore(engine, backend);
    store.sync([{ id: 'a', connection: 'codex.app-server' }]);
    store.open('a');
    await settled();
    store.notice('a', 'info', 'Keep this conversation visible.');
    const before = store.of('a');
    backend.fresh.mockRejectedValueOnce(new Error('Could not save the conversation change'));
    await expect(store.fresh('a')).rejects.toThrow('Could not save');
    expect(store.of('a')).toBe(before);
    expect(backend.close).not.toHaveBeenCalled();
    expect(backend.start).toHaveBeenCalledOnce();
    store.reset();
  });

  it.each(['reset', 'remove', 'switch'] as const)(
    'does not reopen an obsolete conversation after %s while the durable clear was pending',
    async (change) => {
      const { backend } = fakeBackend();
      const pending = deferred();
      backend.fresh.mockReturnValueOnce(pending.promise);
      const store = new SessionStore(engine, backend);
      store.sync([{ id: 'a', connection: 'codex.app-server' }]);
      const fresh = store.fresh('a');
      await settled();
      expect(backend.fresh).toHaveBeenCalledOnce();
      if (change === 'reset') store.reset();
      else if (change === 'remove') store.sync([]);
      else store.sync([{ id: 'a', connection: 'claude-code.sdk' }]);
      pending.resolve(null);
      await fresh;
      expect(backend.start).not.toHaveBeenCalled();
      expect(backend.send).not.toHaveBeenCalled();
      store.reset();
    },
  );

  it('holds new messages through the durable clear, deduplicates the action, and sends them only to the fresh session', async () => {
    const { backend } = fakeBackend();
    const pending = deferred();
    backend.fresh.mockReturnValueOnce(pending.promise);
    const store = new SessionStore(engine, backend);
    store.sync([{ id: 'a', connection: 'codex.app-server', role: 'Reviewer' }]);
    const fresh = store.fresh('a');
    const again = store.fresh('a');
    store.send('a', 'codex', 'New conversation work');
    store.open('a');
    await settled();
    expect(backend.fresh).toHaveBeenCalledOnce();
    expect(backend.start).not.toHaveBeenCalled();
    expect(backend.send).not.toHaveBeenCalled();
    expect(store.of('a').queued).toMatchObject([{ text: 'New conversation work' }]);
    pending.resolve(null);
    await Promise.all([fresh, again]);
    await vi.waitFor(() => {
      expect(backend.send).toHaveBeenCalledOnce();
    });
    expect(backend.start).toHaveBeenCalledOnce();
    expect(store.of('a').queued).toEqual([]);
    expect(store.of('a').submissions).toMatchObject([
      { text: 'New conversation work', status: 'running' },
    ]);
    store.reset();
  });
});
