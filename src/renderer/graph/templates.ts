import type { AdapterId } from '../../shared/adapter';
import { connectionsOf, DEFAULT_AGENT, translateActions } from './agents';
import type { AgentConnection } from './agents';
import type { Graph } from './graph';

/**
 * A template's agents given their types (`types`, by agent id; undefined leaves an agent open, to
 * be the default agent). A step whose action the new type lacks becomes the action that does the
 * same job in it, if there is one (agents.ts); otherwise it stays, for the user to change. Agents
 * not in `types` keep theirs.
 */
export function withAgents(
  graph: Graph,
  types: Readonly<Record<string, AdapterId | undefined>>,
): Graph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      if (node.type !== 'agent' || !(node.id in types)) return node;
      const was = node.data.adapter ?? DEFAULT_AGENT;
      const type = types[node.id];
      const now = type ?? DEFAULT_AGENT;
      const queue = node.data.queue && translateActions(node.data.queue, was, now);
      const data = { ...node.data, ...(queue ? { queue } : {}) };
      if (type === undefined) delete data.adapter;
      else data.adapter = type;
      return { ...node, data };
    }),
  };
}

/**
 * A template's agents use the chosen native connections (`connections`, by agent id). A way
 * its type cannot run leaves the agent as it was; agents not in `connections` keep theirs.
 */
export function withConnections(
  graph: Graph,
  connections: Readonly<Record<string, AgentConnection>>,
): Graph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      const connection = connections[node.id];
      if (node.type !== 'agent' || connection === undefined) return node;
      if (
        connection === 'unavailable' ||
        !connectionsOf(node.data.adapter ?? DEFAULT_AGENT).includes(connection)
      )
        return node;
      const data = { ...node.data };
      data.connection = connection;
      return { ...node, data };
    }),
  };
}
