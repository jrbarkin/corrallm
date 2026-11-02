import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { connectionIn } from '../../shared/adapter';
import { newCanvasId } from '../../shared/canvas';
import type { SessionEvent } from '../../shared/session';
import { Children } from '../core/children';
import type { ChildSystem } from '../core/children';
import { mintTrustedPath } from '../core/host';
import { openTestStore } from '../core/store/test-store';
import type { Store } from '../core/store/store';
import { ProjectDirectories } from '../core/workspaces/resolver';
import { CanvasMemory } from '../memory';
import { CATALOG } from './adapters';
import type { Connector } from './connector';
import { FakeConnector } from './fake';
import { SessionManager } from './manager';
import { beforeSpawn, recordPty, spawn } from './process';

const { spawnProcess } = vi.hoisted(() => ({ spawnProcess: vi.fn() }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  spawn: spawnProcess,
}));

const BOUND = 90_000;
let dir: string;
let store: Store;
let memory: CanvasMemory;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'corrallm-start-bound-'));
  store = await openTestStore(dir);
  memory = new CanvasMemory(store);
});
afterEach(async () => {
  vi.useRealTimers();
  await memory.flush();
  await store.close();
  await rm(dir, { recursive: true, force: true });
});

function fixture(connection: string) {
  const canvas = newCanvasId();
  const adapter = connectionIn(CATALOG, connection);
  if (!adapter) throw new Error('Unknown test connection');
  const events: SessionEvent[] = [];
  const child = Object.assign(new EventEmitter(), { pid: 42, kill: vi.fn() });
  spawnProcess.mockReturnValue(child);
  let alive = true;
  const system: ChildSystem = {
    platform: 'linux',
    inspect: vi.fn(() => (alive ? { started: 1000, group: 42 } : undefined)),
    alive: () => alive,
    signal: vi.fn(() => {
      alive = false;
      child.emit('exit');
    }),
    wait: () => Promise.resolve(),
    pause: () => undefined,
    now: () => 2000,
  };
  const children = new Children(dir, system);
  const starting = Promise.withResolvers<undefined>();
  const finish = Promise.withResolvers<undefined>();
  const fake = new FakeConnector({ adapter: adapter.adapter.id });
  const closed = vi.fn();
  let first = true;
  const connector: Connector = {
    start: async (spec, host) => {
      if (first) {
        first = false;
        if (adapter.connection.view === 'terminal') {
          beforeSpawn();
          recordPty({
            pid: child.pid,
            kill: child.kill,
            onExit: (listener) => child.once('exit', listener),
          });
        } else spawn('fake-agent', [], {});
        starting.resolve(undefined);
        await finish.promise; // A live process whose handshake/ready state never answers.
      }
      const session = await fake.start(spec, host);
      const close = session.close.bind(session);
      session.close = () => {
        closed();
        return close();
      };
      return session;
    },
  };
  const manager = new SessionManager({
    catalog: CATALOG,
    connectors: { [connection]: connector },
    directories: new ProjectDirectories({
      of: () => mintTrustedPath(dir),
      onAvailability: () => () => undefined,
    }),
    memory,
    environment: () => Promise.resolve({}),
    adapterOf: () => Promise.resolve(adapter.adapter.id),
    emit: (_canvas, _agent, _connection, event) => {
      events.push(event);
    },
  });
  const open = () =>
    children.run(() => manager.start(canvas, 'a', { connection, model: null, mode: null }));
  const label = `${adapter.adapter.name} · ${adapter.connection.label}`;
  return { canvas, manager, children, system, events, starting, finish, fake, open, label, closed };
}

describe('a session’s start budget', () => {
  it.each(['codex.app-server', 'claude-code.sdk', 'codex.terminal', 'claude-code.terminal'])(
    'fails a %s start that never becomes ready, ends its group and permits a fresh open',
    async (connection) => {
      const h = fixture(connection);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const results: unknown[] = [];
      const opened = h.open().catch((error: unknown) => {
        results.push(error);
      });
      await h.starting.promise;
      const shared = h.open().catch((error: unknown) => {
        results.push(error);
      });
      try {
        await vi.advanceTimersByTimeAsync(BOUND - 1);
        expect(results).toEqual([]);
        expect(h.system.signal).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        const message = `${h.label} didn't finish starting within 90 seconds`;
        expect(results).toHaveLength(2);
        expect(results).toEqual([new Error(message), new Error(message)]);
        expect(h.events).toEqual([{ type: 'closed', error: message }]);
        expect(h.system.signal).toHaveBeenCalledExactlyOnceWith(42, 'SIGTERM');
        expect(h.system.inspect).toHaveBeenCalledWith(42);
        expect(h.manager.running(h.canvas, 'a')).toBe(false);
        // Even a late connector resolution cannot speak for or replace the next generation.
        await h.open();
        const heard = [...h.events];
        h.finish.resolve(undefined);
        await vi.advanceTimersByTimeAsync(0);
        expect(h.events).toEqual(heard);
        expect(h.closed).toHaveBeenCalledOnce();
        expect(h.manager.running(h.canvas, 'a')).toBe(true);
      } finally {
        h.finish.resolve(undefined);
        await Promise.all([opened, shared]);
        await h.manager.closeEverything();
        await h.children.close();
      }
    },
  );

  it('keeps a start that finishes just under the budget running after the deadline', async () => {
    const h = fixture('codex.app-server');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const opened = h.open();
    await h.starting.promise;
    try {
      await vi.advanceTimersByTimeAsync(BOUND - 1);
      h.finish.resolve(undefined);
      await opened;
      await vi.advanceTimersByTimeAsync(BOUND);
      expect(h.manager.running(h.canvas, 'a')).toBe(true);
      expect(h.events.map((event) => event.type)).toEqual(['started']);
      expect(h.system.signal).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      h.finish.resolve(undefined);
      await opened;
      await h.manager.closeEverything();
      await h.children.close();
    }
  });

  it('returns the pending start’s failure to a restart waiting on it', async () => {
    const h = fixture('codex.app-server');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const results: unknown[] = [];
    const opened = h.open().catch((error: unknown) => {
      results.push(error);
    });
    await h.starting.promise;
    const restarting = h.manager.restarting(h.canvas, 'a', 'codex').catch((error: unknown) => {
      results.push(error);
    });
    try {
      await vi.advanceTimersByTimeAsync(BOUND);
      expect(results).toEqual([
        new Error(`${h.label} didn't finish starting within 90 seconds`),
        new Error(`${h.label} didn't finish starting within 90 seconds`),
      ]);
    } finally {
      h.finish.resolve(undefined);
      await Promise.all([opened, restarting]);
      await vi.advanceTimersByTimeAsync(0);
      await h.manager.closeEverything();
      await h.children.close();
    }
  });
});
