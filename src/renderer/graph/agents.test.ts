import * as Structure from '../../shared/model/structure';
import { describe, expect, it } from 'vitest';

import type { CanvasId } from '../../shared/canvas';
import { catalog } from '../catalog';
import {
  actionsOf,
  adapterCli,
  adapterName,
  agentLabel,
  CONNECTED_AGENTS,
  connectionInfo,
  connectionOf,
  connectionsOf,
  DEFAULT_AGENT,
  defaultConnection,
} from './agents';
import { fromFile, toFile } from '../../shared/model/file';
import { documentOf, EMPTY_GRAPH, graphOf } from '../test-graph-data';
import { setType } from '../../shared/model/agent-ops';

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

function setAgent(graph: typeof EMPTY_GRAPH, agent: string, adapter: string) {
  return graphOf(
    setType(
      documentOf(graph, ID),
      { agent, adapter },
      { catalog: catalog(), defaultAdapter: DEFAULT_AGENT },
    ).next,
  );
}
function addAgent(graph: typeof EMPTY_GRAPH, id: string, at: { x: number; y: number }) {
  let n = 0;
  return graphOf(
    Structure.addAgent(
      documentOf(graph, ID),
      { adapter: DEFAULT_AGENT, at },
      { defaultAdapter: DEFAULT_AGENT, newId: () => (n++ === 0 ? id : `${id}/message`) },
    ).next,
  );
}
function spawnAgent(
  graph: typeof EMPTY_GRAPH,
  from: string,
  id: string,
  relation: 'peer' | 'linked',
) {
  let n = 0;
  return graphOf(
    Structure.spawnAgent(
      documentOf(graph, ID),
      { from, relation },
      { defaultAdapter: DEFAULT_AGENT, newId: () => (n++ === 0 ? id : `${id}/message`) },
    ).next,
  );
}

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

  it('runs a node naming no adapter with Claude Code, as the core does (DEFAULT_ADAPTER)', () => {
    expect(DEFAULT_AGENT).toBe('claude-code');
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
      const graph = graphOf(
        fromFile(canvas({ adapter, connection: how }), catalog(), DEFAULT_AGENT),
      );
      expect(connectionOf(graph.nodes[0]?.data ?? {})).toBe('unavailable');
      expect(toFile(documentOf(graph, ID))).toContain(`"connection": "${how}"`);
    },
  );

  it.each(['qwen', 'gemini'])(
    'keeps an agent of an adapter this build lacks (%s) as Not connected, saved back as it was',
    (adapter) => {
      const settings = { [adapter]: { model: 'pro', mode: 'yolo' } };
      const file = canvas({ adapter, connection: `${adapter}.acp`, settings });
      const graph = graphOf(fromFile(file, catalog(), DEFAULT_AGENT));
      expect(graph.nodes[0]?.data).toMatchObject({ adapter, settings });
      expect(connectionOf(graph.nodes[0]?.data ?? {})).toBe('unavailable');
      expect(connectionsOf(adapter)).toEqual([]);
      expect(graph.nodes[0]?.data.queue).toEqual([
        { id: 'work', message: 'Keep the authored work.' },
      ]);
      expect(toFile(documentOf(graph, ID))).toBe(`${JSON.stringify(JSON.parse(file), null, 2)}\n`);
    },
  );

  it.each([
    ['toString', undefined],
    ['toString', 'toString'],
    ['constructor', undefined],
    ['constructor', 'constructor.acp'],
    ['valueOf', 'valueOf'],
    ['hasOwnProperty', undefined],
  ])(
    'reads an adapter named like what every object inherits (%s, connection %s) as one this build lacks',
    (adapter, connection) => {
      const file = canvas({ adapter, ...(connection === undefined ? {} : { connection }) });
      const graph = graphOf(fromFile(file, catalog(), DEFAULT_AGENT));
      const data = graph.nodes[0]?.data ?? {};
      // Its card: Not connected, named by its id.
      expect(connectionOf(data)).toBe('unavailable');
      expect(agentLabel(adapter, connectionOf(data))).toBe(`${adapter} · Not connected`);
      expect(adapterName(adapter)).toBe(adapter);
      expect(adapterCli(adapter)).toBe(adapter);
      expect(connectionInfo(connection ?? adapter)).toEqual(connectionInfo('unavailable'));
      expect(connectionsOf(adapter)).toEqual([]);
      expect(defaultConnection(adapter)).toBe('unavailable');
      expect(actionsOf(adapter)).toEqual([]);
      // Its steps keep their actions as it changes adapter, either way.
      const steps = [
        { id: 'run', action: 'Bash' },
        { id: 'look', action: 'Read' },
      ];
      const claude = addAgent(EMPTY_GRAPH, 'a', { x: 0, y: 0 });
      const moved = setAgent(
        {
          ...claude,
          nodes: claude.nodes.map((n) => ({ ...n, data: { ...n.data, queue: steps } })),
        },
        'a',
        adapter,
      );
      expect(moved.nodes[0]?.data).toMatchObject({ adapter, queue: steps });
      expect(connectionOf(moved.nodes[0]?.data ?? {})).toBe('unavailable');
      expect(toFile(documentOf(graph, ID))).toBe(`${JSON.stringify(JSON.parse(file), null, 2)}\n`);
    },
  );

  it('refuses a connection the catalog has under another adapter', () => {
    expect(() =>
      graphOf(
        fromFile(
          canvas({ adapter: 'codex', connection: 'claude-code.terminal' }),
          catalog(),
          DEFAULT_AGENT,
        ),
      ),
    ).toThrow(/nodes\[0\]\.connection: "claude-code\.terminal" is a connection of claude-code/);
    expect(() =>
      graphOf(fromFile(canvas({ connection: 'codex.terminal' }), catalog(), DEFAULT_AGENT)),
    ).toThrow(/not of claude-code/);
  });
});
