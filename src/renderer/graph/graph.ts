import type { AdapterId } from '../../shared/adapter';
import type { CanvasDocument } from '../../shared/model/canvas';

import type { Built } from '../../shared/model/structure';
import type { AgentSettingsChange } from '../../shared/session';
import { catalog } from '../catalog';
import { DEFAULT_AGENT } from './agents';
import type { AgentConnection } from './agents';
import * as AgentOps from '../../shared/model/agent-ops';

export function setAgent(graph: CanvasDocument, agent: string, adapter: AdapterId): CanvasDocument {
  return editGraph(graph, (doc) =>
    AgentOps.setType(
      doc,
      { agent, adapter },
      { catalog: catalog(), defaultAdapter: DEFAULT_AGENT },
    ),
  );
}
export function setConnection(
  graph: CanvasDocument,
  agent: string,
  connection: AgentConnection,
): CanvasDocument {
  return editGraph(graph, (doc) =>
    AgentOps.setConnection(
      doc,
      { agent, connection },
      { catalog: catalog(), defaultAdapter: DEFAULT_AGENT },
    ),
  );
}
export function setSettings(
  graph: CanvasDocument,
  agent: string,
  adapter: AdapterId,
  change: AgentSettingsChange,
): CanvasDocument {
  return editGraph(graph, (doc) => AgentOps.setSettings(doc, { agent, adapter, change }));
}
export function setRole(
  graph: CanvasDocument,
  agent: string,
  role: string | undefined,
): CanvasDocument {
  return editGraph(graph, (doc) => AgentOps.setRole(doc, { agent, role }));
}

/** Remaining agent settings gestures until task 12, over model documents only. */
function editGraph<R>(
  document: CanvasDocument,
  build: (doc: CanvasDocument) => Built<R>,
): CanvasDocument {
  return build(document).next;
}
