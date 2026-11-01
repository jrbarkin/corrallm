import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Catalog, ConnectionId } from '../../shared/adapter';
import { newCanvasId } from '../../shared/canvas';
import type { CanvasId } from '../../shared/canvas';
import type { SessionEvent, SessionMode, SessionOptions } from '../../shared/session';
import { mintTrustedPath } from '../core/host';
import type { Store } from '../core/store/store';
import { openTestStore } from '../core/store/test-store';
import type { DirectoryResolver, WorkingDirectory } from '../core/workspaces/resolver';
import { CanvasMemory } from '../memory';
import { CATALOG } from './adapters';
import type { Connector, SessionApi, SessionHost } from './connector';
import { FakeConnector } from './fake';
import { SessionManager } from './manager';
import { ProcessScope } from './process';
import type { PromptSink } from './manager';

/*
 * The session manager's side of B21's session authority (§9 C1, C2): it asks the core's one
 * issuer for each generation's route as it launches that generation (after its folder is admitted
 * and its conversation claimed, before its connector starts) and hands it to the connector in its
 * spec; and it revokes that generation's credential beside every end of its prompts, as its close
 * begins, so nothing new is authorized once a session is ending.
 */

const SDK: SessionOptions = { connection: 'claude-code.sdk', model: null, mode: null };
const TERMINAL: SessionOptions = { connection: 'claude-code.terminal', model: null, mode: null };

let dir: string;
let store: Store;
let memory: CanvasMemory;
/** What happened, in order: each issue, revoke, prompts' end, and the connector's starts. */
let log: string[];
let heard: [string, SessionEvent][];
/** The working directory agents resolve to: the test may change it. */
let directory: WorkingDirectory;

const ROUTE = (generation: number): SessionApi => ({
  kind: 'http',
  server: 'corrallm',
  url: 'http://127.0.0.1:4100/mcp',
  token: `credential-${String(generation)}`,
  tools: [],
  off: ['corrallm-server', 'corrallm-server-dev'],
});

const sink: PromptSink = {
  raised: () => undefined,
  ended: () => undefined,
  gone: (_canvas, agent, generation) => {
    log.push(`gone ${agent} ${String(generation)}`);
  },
};

const directories: DirectoryResolver = {
  workingDirectory: () => {
    log.push('directory');
    return Promise.resolve(directory);
  },
  onAvailability: () => () => undefined,
  projectRoot: () => mintTrustedPath('/work/app'),
};

/** The shipped catalog, with `connection`'s descriptor declaring an `api` route. */
function routed(connection: ConnectionId): Catalog {
  return {
    ...CATALOG,
    adapters: CATALOG.adapters.map((adapter) => ({
      ...adapter,
      connections: adapter.connections.map((one) =>
        one.id === connection ? { ...one, api: 'http' as const } : one,
      ),
    })),
  };
}

function manager(
  connectors: Partial<Record<ConnectionId, Connector>>,
  {
    issue = (generation: number) => ROUTE(generation),
    catalog = CATALOG,
    environment = () => Promise.resolve({}),
  }: {
    issue?: (generation: number) => SessionApi | undefined;
    catalog?: Catalog;
    environment?: () => Promise<Readonly<Record<string, string>>>;
  } = {},
): SessionManager {
  return new SessionManager({
    catalog,
    connectors,
    environment,
    adapterOf: () => Promise.resolve('claude-code'),
    directories,
    memory,
    closeMs: 20,
    emit: (_canvas, agent, _connection, event) => {
      heard.push([agent, event]);
    },
    prompts: sink,
    api: {
      issue: ({ agent, generation, connection }) => {
        log.push(`issue ${agent} ${String(generation)} ${connection}`);
        return issue(generation);
      },
      revoke: (_canvas, agent, generation) => {
        log.push(`revoke ${agent} ${String(generation)}`);
      },
    },
  });
}

/** A fake connector that logs each start, with the route its spec carried, keeping its hosts. */
function logged(fake = new FakeConnector(), hosts: SessionHost[] = []): Connector<SessionMode> {
  return {
    start: (spec, host) => {
      log.push(`start ${spec.agentId} ${spec.api?.kind === 'http' ? spec.api.token : 'none'}`);
      hosts.push(host);
      return fake.start(spec, host);
    },
  };
}

/** Every generation whose prompts ended has its credential revoked first, beside it. */
function revokedBeside(): void {
  for (const [index, line] of log.entries()) {
    if (!line.startsWith('gone ')) continue;
    const revoke = `revoke ${line.slice('gone '.length)}`;
    expect(log.slice(0, index), `${line} without ${revoke}`).toContain(revoke);
  }
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'corrallm-manager-api-'));
  store = await openTestStore(dir);
  memory = new CanvasMemory(store);
  log = [];
  heard = [];
  directory = {
    state: 'ready',
    cwd: mintTrustedPath('/work/app'),
    workspace: null,
    generation: 0,
    branch: null,
  };
});

afterEach(async () => {
  await memory.flush();
  await store.close();
  await rm(dir, { recursive: true, force: true });
});

describe('a session generation’s route', () => {
  it('is issued once as it launches, after its folder is admitted, and goes to its connector alone', async () => {
    const fake = new FakeConnector();
    const sessions = manager({ 'claude-code.sdk': logged(fake) });
    const canvas = newCanvasId();
    await sessions.start(canvas, 'b', SDK);
    const generation = sessions.generationOf(canvas, 'b') ?? -1;
    const issued = log.indexOf(`issue b ${String(generation)} claude-code.sdk`);
    expect(issued).toBeGreaterThan(log.indexOf('directory'));
    expect(log.indexOf(`start b credential-${String(generation)}`)).toBeGreaterThan(issued);
    expect(log.filter((line) => line.startsWith('issue '))).toHaveLength(1);
    expect(fake.started[0]?.api).toEqual(ROUTE(generation));
    // Never an event: the route stays with the connector.
    expect(JSON.stringify(heard)).not.toContain('credential-');
    await sessions.closeEverything();
  });

  it('is left out of the spec when the core issues none, and the session starts without it', async () => {
    const fake = new FakeConnector();
    const sessions = manager({ 'claude-code.sdk': logged(fake) }, { issue: () => undefined });
    const canvas = newCanvasId();
    await sessions.start(canvas, 'b', SDK);
    expect(fake.started[0]).not.toHaveProperty('api');
    // The descriptor says null: nothing to say about it.
    expect(heard.filter(([, event]) => event.type === 'notice')).toEqual([]);
    await sessions.closeEverything();
  });

  it('says once why, when its connection has a route but the core issued none', async () => {
    const fake = new FakeConnector();
    const sessions = manager(
      { 'claude-code.sdk': logged(fake) },
      { issue: () => undefined, catalog: routed('claude-code.sdk') },
    );
    const canvas = newCanvasId();
    await sessions.start(canvas, 'b', SDK);
    const notices = heard.flatMap(([, event]) => (event.type === 'notice' ? [event.text] : []));
    expect(notices).toEqual([
      'corrallm’s MCP server isn’t listening, so this session started without corrallm’s tools.',
    ]);
    await sessions.closeEverything();
  });

  it('is never issued for a generation whose close began while it launched', async () => {
    const reading = Promise.withResolvers<undefined>();
    const go = Promise.withResolvers<undefined>();
    const sessions = manager(
      { 'claude-code.sdk': logged() },
      {
        environment: async () => {
          reading.resolve(undefined);
          await go.promise;
          return {};
        },
      },
    );
    const canvas = newCanvasId();
    const starting = sessions.start(canvas, 'b', SDK).catch(() => undefined);
    await reading.promise;
    const closing = sessions.close(canvas, 'b');
    go.resolve(undefined);
    await starting;
    await closing;
    expect(log.filter((line) => line.startsWith('issue '))).toEqual([]);
    revokedBeside();
    await sessions.closeEverything();
  });
});

describe('a session generation’s credential', () => {
  it('revokes a failed start’s credential before awaiting child cleanup', async () => {
    const cleaning = Promise.withResolvers<undefined>();
    const go = Promise.withResolvers<undefined>();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Called with the actual scope below.
    const close = ProcessScope.prototype.close;
    const spy = vi.spyOn(ProcessScope.prototype, 'close').mockImplementation(async function (
      this: ProcessScope,
    ) {
      cleaning.resolve(undefined);
      await go.promise;
      return close.call(this);
    });
    const sessions = manager({
      'claude-code.sdk': { start: () => Promise.reject(new Error('It won’t start here.')) },
    });
    const canvas = newCanvasId();
    const pending = sessions.start(canvas, 'b', SDK).catch(() => undefined);
    try {
      await cleaning.promise;
      expect(log.filter((line) => line.startsWith('issue b '))).toHaveLength(1);
      expect(log.some((line) => line.startsWith('revoke b '))).toBe(true);
    } finally {
      go.resolve(undefined);
      await pending;
      await sessions.closeEverything();
      spy.mockRestore();
    }
  });

  it('is revoked beside every end of its prompts: closed, stopped by itself, replaced, never started, its canvas closed', async () => {
    const hosts: SessionHost[] = [];
    const failing: Connector<SessionMode> = {
      start: () => Promise.reject(new Error('It won’t start here.')),
    };
    const sessions = manager({
      'claude-code.sdk': logged(new FakeConnector(), hosts),
      'claude-code.terminal': logged(),
      'codex.app-server': failing,
    });
    const canvas: CanvasId = newCanvasId();
    const revokes = () => log.filter((line) => line.startsWith('revoke '));
    // Closed.
    await sessions.start(canvas, 'b', SDK);
    const closed = sessions.generationOf(canvas, 'b') ?? -1;
    await sessions.close(canvas, 'b');
    expect(revokes()).toContain(`revoke b ${String(closed)}`);
    // Stopped by itself.
    await sessions.start(canvas, 'b', SDK);
    const stopped = sessions.generationOf(canvas, 'b') ?? -1;
    hosts.at(-1)?.emit({ type: 'closed' });
    expect(revokes()).toContain(`revoke b ${String(stopped)}`);
    // Replaced by another connection, and restarted on the same one.
    await sessions.start(canvas, 'b', SDK);
    const replaced = sessions.generationOf(canvas, 'b') ?? -1;
    await sessions.start(canvas, 'b', TERMINAL);
    expect(revokes()).toContain(`revoke b ${String(replaced)}`);
    // Never started.
    await expect(
      sessions.start(canvas, 'c', { connection: 'codex.app-server', model: null, mode: null }),
    ).rejects.toThrow(/won’t start/);
    expect(revokes().some((line) => line.startsWith('revoke c '))).toBe(true);
    // Its canvas closed.
    const last = sessions.generationOf(canvas, 'b') ?? -1;
    await sessions.closeCanvas(canvas);
    expect(revokes()).toContain(`revoke b ${String(last)}`);
    revokedBeside();
  });

  it('is revoked as soon as its install is found unheard, before its session has closed', async () => {
    const fake = new FakeConnector();
    const closing = Promise.withResolvers<undefined>();
    let revokedBeforeClose: boolean | undefined;
    const late: Connector<SessionMode> = {
      start: async (spec, host) => {
        const session = await fake.start(spec, host);
        // The binding changes while the CLI starts.
        directory = {
          state: 'ready',
          cwd: mintTrustedPath('/work/tree-2'),
          workspace: null,
          generation: 2,
          branch: null,
        };
        const close = session.close.bind(session);
        session.close = async () => {
          revokedBeforeClose = log.some((line) => line.startsWith('revoke b '));
          closing.resolve(undefined);
          await close();
        };
        return session;
      },
    };
    const sessions = manager({ 'claude-code.sdk': late });
    const canvas = newCanvasId();
    await expect(sessions.start(canvas, 'b', SDK)).rejects.toThrow();
    await closing.promise;
    expect(revokedBeforeClose).toBe(true);
    revokedBeside();
  });
});
