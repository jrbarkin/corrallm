import { describe, expect, it } from 'vitest';

import { ID_PATTERN } from '../../shared/adapter';
import type { AdapterDescriptor } from '../../shared/adapter';
import type { Adapter } from './adapter';
import { ADAPTERS, CATALOG, catalogOf, DEFAULT_ADAPTER } from './adapters';
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
        consent: () => ({ given: () => Promise.resolve(false), give: () => Promise.resolve() }),
      });
      expect(Object.keys(connectors).sort()).toEqual(connections);
      expect(Object.keys(createOptions({ fake })).sort()).toEqual(ids(CATALOG.adapters).sort());
    }
  });

  it('runs an agent naming no adapter with Claude Code, as the renderer does (DEFAULT_AGENT)', () => {
    expect(DEFAULT_ADAPTER).toBe('claude-code');
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
