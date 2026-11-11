import { describe, expect, it, vi } from 'vitest';

import { ID_PATTERN } from '../../shared/adapter';
import type { AdapterDescriptor } from '../../shared/adapter';
import { OPS } from '../../shared/api/registry';
import type { Adapter } from './adapter';
import type { HostEvent } from './connector';
import { ADAPTERS, CATALOG, catalogOf } from './adapters';
import { createConnectors, createOptions } from './connectors';

/*
 * The catalog every process reads: what holds for every adapter in it. Each adapter's own values
 * are pinned by its contract test (<its folder>/adapter.test.ts).
 */

const ids = (list: readonly { id: string }[]) => list.map((one) => one.id);

describe('the catalog', () => {
  it('lists every adapter, sorted by name whatever order they are registered in', () => {
    expect(ids(CATALOG.adapters)).toEqual(['claude-code', 'codex']);
    const named = (id: string, name: string): Adapter => ({
      descriptor: { ...CATALOG.adapters[0], id, name } as AdapterDescriptor,
      usageBackends: [],
      isConversationId: () => true,
    });
    expect(ids(catalogOf([named('b', 'Zed'), named('a', 'Aider')]).adapters)).toEqual(['a', 'b']);
  });

  it('names every adapter, connection, mode, backend and window by an id of the right shape', () => {
    const all = [
      ...ids(CATALOG.adapters),
      ...CATALOG.adapters.flatMap((adapter) => [
        ...ids(adapter.connections),
        ...ids(adapter.modes),
      ]),
      ...ids(CATALOG.usageBackends),
      ...CATALOG.usageBackends.flatMap((backend) => ids(backend.windows)),
    ];
    for (const id of all) {
      expect(id).toMatch(ID_PATTERN);
    }
  });

  it('keeps ids unique: adapters, connections across adapters, modes and windows within theirs', () => {
    const unique = (list: readonly string[]) => {
      expect(new Set(list).size).toBe(list.length);
    };
    unique(ids(CATALOG.adapters));
    unique(CATALOG.adapters.flatMap((adapter) => ids(adapter.connections)));
    unique(ids(CATALOG.usageBackends));
    for (const adapter of CATALOG.adapters) unique(ids(adapter.modes));
    for (const backend of CATALOG.usageBackends) unique(ids(backend.windows));
  });

  it('gives every adapter a connection, and lists conversations only where it resumes them', () => {
    for (const adapter of CATALOG.adapters) {
      expect(adapter.connections.length).toBeGreaterThan(0);
      if (adapter.list) expect(adapter.resume).toBe(true);
      for (const connection of adapter.connections) {
        if (connection.panels.resume) expect(adapter.list).toBe(true);
      }
    }
  });

  it('starts sessions only in modes that ask, and ranks every mode', () => {
    for (const adapter of CATALOG.adapters) {
      const asking = adapter.modes.filter((mode) => mode.asks).map((mode) => mode.id);
      for (const connection of adapter.connections) {
        for (const mode of connection.startModes) expect(asking).toContain(mode);
      }
      for (const mode of adapter.modes) expect(Number.isInteger(mode.rank)).toBe(true);
    }
  });

  it('spends only declared usage backends, and continues only in its own connections', () => {
    const backends = ids(CATALOG.usageBackends);
    for (const adapter of CATALOG.adapters) {
      for (const connection of adapter.connections) {
        if (connection.usage !== null) expect(backends).toContain(connection.usage);
        if (connection.continueIn) {
          expect(ids(adapter.connections)).toContain(connection.continueIn.connection);
          expect(connection.continueIn.connection).not.toBe(connection.id);
        }
        if (connection.keys) expect(connection.view).toBe('terminal');
      }
    }
  });

  it('has a connector for each of its connections, and reads each adapter’s options', () => {
    const connections = CATALOG.adapters.flatMap((adapter) => ids(adapter.connections)).sort();
    for (const fake of [true, false]) {
      const connectors = createConnectors({
        fake,
        clientApp: 'corrallm/test',
        distribution: 'local',
        consent: () => ({
          generation: () => 0,
          given: () => Promise.resolve(false),
          give: () => Promise.resolve(),
        }),
      });
      expect(Object.keys(connectors).sort()).toEqual(connections);
      expect(Object.keys(createOptions({ fake })).sort()).toEqual(ids(CATALOG.adapters).sort());
    }
  });

  it('declares, by key, exactly the consents its connectors ask for, on its own connections (B22a C3)', () => {
    for (const adapter of ADAPTERS) {
      const { descriptor } = adapter;
      const declared = descriptor.consents ?? [];
      // What its connectors ask for, read as they are built: none may ask by a key it doesn't declare.
      const asked = new Set<string>();
      adapter.connectors?.({
        clientApp: 'corrallm/test',
        distribution: 'local',
        executable: () => Promise.reject(new Error('Tests never find a CLI.')),
        consent: (key) => {
          asked.add(key);
          return {
            generation: () => 0,
            given: () => Promise.resolve(false),
            give: () => Promise.resolve(),
          };
        },
      });
      expect([...asked].sort(), descriptor.id).toEqual(declared.map(({ key }) => key).sort());
      const connections = ids(descriptor.connections);
      for (const consent of declared) {
        expect(consent.connections.length).toBeGreaterThan(0);
        for (const connection of consent.connections) expect(connections).toContain(connection);
      }
    }
    expect(OPS['catalog.get'].output.safeParse(CATALOG).success).toBe(true);
  });

  it('bounds where a registration goes and how long its templates are (B30 C4)', () => {
    const accepts = (change: Partial<AdapterDescriptor>) =>
      OPS['catalog.get'].output.safeParse({
        ...CATALOG,
        adapters: [{ ...CATALOG.adapters[0], ...change }],
      }).success;
    expect(accepts({ registerMcpIn: '.codex/config.toml' })).toBe(true);
    expect(accepts({ registerMcpIn: 'config.toml' })).toBe(true);
    for (const bad of [
      '../config.toml',
      '.codex/../config.toml',
      '-config.toml',
      '.codex/-x',
      '/etc/config.toml',
      '.codex//config.toml',
      '.',
      '..',
      '',
      'a b',
      'a'.repeat(65),
    ]) {
      expect(accepts({ registerMcpIn: bad }), bad).toBe(false);
    }
    expect(accepts({ registerMcp: 'x'.repeat(2048) })).toBe(true);
    expect(accepts({ registerMcp: 'x'.repeat(2049) })).toBe(false);
    expect(accepts({ registerMcpHelper: 'x'.repeat(2049) })).toBe(false);
  });

  it('asks, in a test build, each consent on the connections that declare it, through the core’s owner', async () => {
    const asked: string[] = [];
    const connectors = createConnectors({
      fake: true,
      clientApp: 'corrallm/test',
      distribution: 'local',
      consent: (adapter, key) => {
        asked.push(`${adapter}/${key}`);
        return {
          generation: () => 0,
          given: () => Promise.resolve(false),
          give: () => Promise.resolve(),
        };
      },
    });
    const declared = CATALOG.adapters.flatMap((adapter) =>
      (adapter.consents ?? []).map((consent) => ({ adapter: adapter.id, ...consent })),
    );
    expect(asked.sort()).toEqual(
      declared
        .flatMap(({ adapter, key, connections }) => connections.map(() => `${adapter}/${key}`))
        .sort(),
    );
    for (const adapter of CATALOG.adapters) {
      for (const { id } of adapter.connections) {
        const consent = (adapter.consents ?? []).find((one) => one.connections.includes(id));
        const events: HostEvent[] = [];
        const session = await connectors[id]?.start(
          // A mode in which no fake asks to run its command: only a consent asks.
          { agentId: 'a', cwd: '/unused', env: {}, model: null, mode: 'acceptEdits', resume: null },
          { emit: (event) => events.push(event), remember: () => undefined },
        );
        try {
          await session?.send({ id: 'm1', text: '/consent please' });
          const subject = { type: 'consent', key: consent?.key };
          await vi.waitFor(() => {
            expect(
              events.some(
                (event) =>
                  (event.type === 'prompt' &&
                    event.prompt.kind === 'approval' &&
                    event.prompt.subject?.type === 'consent') ||
                  event.type === 'end',
              ),
            ).toBe(true);
          });
          const raised = events.find((event) => event.type === 'prompt');
          if (consent === undefined) expect(raised, id).toBeUndefined();
          else expect(raised, id).toMatchObject({ prompt: { subject } });
        } finally {
          await session?.close();
        }
      }
    }
  });

  it('is plain data, so that it crosses to the renderer as it is', () => {
    expect(JSON.parse(JSON.stringify(CATALOG))).toEqual(CATALOG);
    expect(ADAPTERS.map((adapter) => adapter.descriptor.id).sort()).toEqual(ids(CATALOG.adapters));
  });

  it('is the catalog the renderer’s and the engine’s tests load', async () => {
    // Neither the renderer nor shared code can import main: their tests read this copy, rewritten
    // with vitest -u.
    await expect(`${JSON.stringify(CATALOG, null, 2)}\n`).toMatchFileSnapshot(
      '../../shared/test-catalog.json',
    );
  });
});
