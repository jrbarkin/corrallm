import { describe, expect, it } from 'vitest';

import type { CanvasId } from '../../shared/canvas';
import { catalog } from '../catalog';
import {
  actionsOf,
  CONNECTED_AGENTS,
  connectionInfo,
  connectionOf,
  connectionsOf,
  defaultConnection,
} from './agents';
import { fromFile, toFile } from './file';
import { addAgent, EMPTY_GRAPH, setAgent, spawnAgent } from './graph';

const ID = '7d0c2b9e-4f1a-4c3d-9e8b-2a1f0e6d5c4b' as CanvasId;

/** A canvas with one agent, `worker`, as a file has it, with `fields` of its own. */
const canvas = (fields: Record<string, unknown>) =>
  JSON.stringify({
    format: 'corrallm',
    version: 2,
    id: ID,
    nodes: [
      {
        id: 'worker',
        kind: 'agent',
        label: 'Worker',
        position: { x: 0, y: 0 },
        ...fields,
        queue: [{ id: 'work', message: 'Keep the authored work.' }],
      },
    ],
    links: [],
  });

describe('native agent defaults', () => {
  it('creates and spawns real Terminal agents without waiting for CLI detection', () => {
    const graph = addAgent(EMPTY_GRAPH, 'a', { x: 100, y: 100 });
    expect(connectionOf(graph.nodes[0]?.data ?? {})).toBe('claude-code.terminal');
    const codex = setAgent(graph, 'a', 'codex');
    const spawned = spawnAgent(codex, 'a', 'b', 'peer');
    expect(spawned.nodes.map((node) => connectionOf(node.data))).toEqual([
      'codex.terminal',
      'codex.terminal',
    ]);
  });

  it('offers each adapter its connections, its first by default', () => {
    expect(CONNECTED_AGENTS).toEqual(['claude-code', 'codex']);
    expect(defaultConnection('claude-code')).toBe('claude-code.terminal');
    expect(defaultConnection('codex')).toBe('codex.terminal');
  });

  it('names the connections and actions the catalog declares, as it declares them', () => {
    for (const adapter of catalog().adapters) {
      expect(connectionsOf(adapter.id)).toEqual(adapter.connections.map((one) => one.id));
      for (const { id, label, short, description } of adapter.connections) {
        expect(connectionInfo(id)).toEqual({ label, short, description });
      }
      expect(actionsOf(adapter.id)).toEqual(
        adapter.actions.map(({ name, description }) => ({ name, description })),
      );
    }
  });

  it.each([
    ['claude-code', 'simulated'],
    ['claude-code', 'terminal'],
    ['codex', 'app-server'],
  ])(
    'opens a %s agent with a connection this build lacks (%s) as Not connected',
    (adapter, how) => {
      const graph = fromFile(canvas({ adapter, connection: how }), catalog());
      expect(connectionOf(graph.nodes[0]?.data ?? {})).toBe('unavailable');
      expect(toFile(graph, ID)).toContain(`"connection": "${how}"`);
    },
  );

  it.each(['qwen', 'gemini'])(
    'keeps an agent of an adapter this build lacks (%s) as Not connected, saved back as it was',
    (adapter) => {
      const settings = { [adapter]: { model: 'pro', mode: 'yolo' } };
      const file = canvas({ adapter, connection: `${adapter}.acp`, settings });
      const graph = fromFile(file, catalog());
      expect(graph.nodes[0]?.data).toMatchObject({ adapter, settings });
      expect(connectionOf(graph.nodes[0]?.data ?? {})).toBe('unavailable');
      expect(connectionsOf(adapter)).toEqual([]);
      expect(graph.nodes[0]?.data.queue).toEqual([
        { id: 'work', message: 'Keep the authored work.' },
      ]);
      expect(toFile(graph, ID)).toBe(`${JSON.stringify(JSON.parse(file), null, 2)}\n`);
    },
  );

  it('refuses a connection the catalog has under another adapter', () => {
    expect(() =>
      fromFile(canvas({ adapter: 'codex', connection: 'claude-code.terminal' }), catalog()),
    ).toThrow(/nodes\[0\]\.connection: "claude-code\.terminal" is a connection of claude-code/);
    expect(() => fromFile(canvas({ connection: 'codex.terminal' }), catalog())).toThrow(
      /not of claude-code/,
    );
  });
});
