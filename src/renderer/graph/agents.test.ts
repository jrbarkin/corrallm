import { describe, expect, it } from 'vitest';

import { CONNECTIONS } from '../../shared/session';
import { AGENT_CONNECTIONS, CONNECTED_AGENTS, connectionOf, defaultConnection } from './agents';
import { fromFile, toFile } from './file';
import { addAgent, EMPTY_GRAPH, setAgent, spawnAgent } from './graph';

const legacy = (agent: 'Claude' | 'Codex' | 'Qwen' | 'Gemini', connection?: string) =>
  JSON.stringify({
    format: 'corrallm',
    version: 1,
    nodes: [
      {
        id: 'worker',
        kind: 'agent',
        label: 'Worker',
        agent,
        position: { x: 0, y: 0 },
        ...(connection === undefined ? {} : { connection }),
        queue: [{ id: 'work', message: 'Keep the authored work.' }],
      },
    ],
    links: [],
  });

describe('native agent defaults', () => {
  it('creates and spawns real Terminal agents without waiting for CLI detection', () => {
    const graph = addAgent(EMPTY_GRAPH, 'a', { x: 100, y: 100 });
    expect(connectionOf(graph.nodes[0]?.data ?? {})).toBe('terminal');
    const codex = setAgent(graph, 'a', 'Codex');
    const spawned = spawnAgent(codex, 'a', 'b', 'peer');
    expect(spawned.nodes.map((node) => connectionOf(node.data))).toEqual([
      'codex-terminal',
      'codex-terminal',
    ]);
  });

  it('offers only real connectors for implemented agent types', () => {
    expect(CONNECTED_AGENTS).toEqual(['Claude', 'Codex']);
    expect(Object.values(AGENT_CONNECTIONS).flat().sort()).toEqual([...CONNECTIONS].sort());
    expect(defaultConnection('Claude')).toBe('terminal');
    expect(defaultConnection('Codex')).toBe('codex-terminal');
  });

  it.each(['Claude', 'Codex'] as const)(
    'reads old %s placeholder workflows as native without changing their work',
    (agent) => {
      const absent = fromFile(legacy(agent));
      const explicit = fromFile(legacy(agent, 'simulated'));
      expect(explicit).toEqual(absent);
      expect(connectionOf(explicit.nodes[0]?.data ?? {})).toBe(defaultConnection(agent));
      expect(explicit.nodes[0]?.data.queue).toEqual([
        { id: 'work', message: 'Keep the authored work.' },
      ]);
      expect(toFile(explicit)).not.toContain('simulated');
    },
  );

  it.each(['Qwen', 'Gemini'] as const)(
    'retains legacy %s nodes as unavailable without offering a pretend connection',
    (agent) => {
      const graph = fromFile(legacy(agent, 'simulated'));
      expect(graph.nodes[0]?.data.agent).toBe(agent);
      expect(connectionOf(graph.nodes[0]?.data ?? {})).toBe('unavailable');
      expect(AGENT_CONNECTIONS[agent]).toEqual([]);
      expect(toFile(graph)).not.toContain('simulated');
    },
  );
});
