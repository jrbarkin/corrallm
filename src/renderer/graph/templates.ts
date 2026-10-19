import type { AdapterId, ConnectionId } from '../../shared/adapter';
import {
  withAgents as chooseAgents,
  withConnections as chooseConnections,
} from '../../shared/model/templates';
import { catalog } from '../catalog';
import { DEFAULT_AGENT } from './agents';
import type { Graph } from './graph';

export function withAgents(
  graph: Graph,
  types: Readonly<Record<string, AdapterId | undefined>>,
): Graph {
  return chooseAgents(graph, types, { catalog: catalog(), defaultAdapter: DEFAULT_AGENT });
}
export function withConnections(
  graph: Graph,
  connections: Readonly<Record<string, ConnectionId>>,
): Graph {
  return chooseConnections(
    graph,
    connections,
    {
      catalog: catalog(),
      defaultAdapter: DEFAULT_AGENT,
    },
    { defaults: false },
  );
}
