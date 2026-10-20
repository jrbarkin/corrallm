import type { AdapterId } from '../../shared/adapter';
import type { CanvasDocument } from '../../shared/model/canvas';

import type { Built } from '../../shared/model/structure';
import type { AgentSettingsChange } from '../../shared/session';
import { catalog } from '../catalog';
import { DEFAULT_AGENT } from './agents';
import type { AgentConnection } from './agents';
import { isIf, isRepeat } from '../../shared/model/queue';
import type {
  Condition,
  QueueChange,
  QueueEntry,
  QueueRepeat,
  QueueStep,
  Time,
  WaitTarget,
} from '../../shared/model/queue';
import * as QueueOps from '../../shared/model/queue-ops';
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

export function addToQueue(
  graph: CanvasDocument,
  agent: string,
  entry: QueueEntry,
  newId: () => string,
  into?: string,
): CanvasDocument {
  return editGraph(graph, (doc) =>
    QueueOps.add(doc, { agent, entry, ...(into === undefined ? {} : { into }) }, 'you', newId),
  );
}
export function removeFromQueue(
  graph: CanvasDocument,
  agent: string,
  item: string,
): CanvasDocument {
  return editGraph(graph, (doc) => QueueOps.remove(doc, { agent, item }));
}

/** The view still supplies a drop index; the model moves by a sibling's id. */
export function moveInQueue(
  graph: CanvasDocument,
  agent: string,
  item: string,
  index: number,
): CanvasDocument {
  const queue =
    graph.nodes.filter((node) => node.type === 'agent').find((node) => node.id === agent)?.data
      .queue ?? [];
  const container = queue.find((one) =>
    isIf(one)
      ? one.then.some((inner) => inner.id === item)
      : isRepeat(one) && one.repeat.some((inner) => inner.id === item),
  );
  const siblings = queue.some((one) => one.id === item)
    ? queue
    : container && isIf(container)
      ? container.then
      : container && isRepeat(container)
        ? container.repeat
        : [];
  const rest = siblings.filter((one) => one.id !== item);
  const before = rest[Math.max(0, index)]?.id ?? null;
  return editGraph(graph, (doc) => QueueOps.move(doc, { agent, item, before }));
}
function queueChange(
  graph: CanvasDocument,
  agent: string,
  item: string,
  change: QueueChange,
): CanvasDocument {
  return editGraph(graph, (doc) => QueueOps.update(doc, { agent, item, change }, 'you'));
}
export function retarget(
  graph: CanvasDocument,
  agent: string,
  item: string,
  target: string | undefined,
): CanvasDocument {
  return queueChange(graph, agent, item, { kind: 'target', target: target ?? null });
}
export function editMessage(
  graph: CanvasDocument,
  agent: string,
  item: string,
  message: string,
): CanvasDocument {
  return queueChange(graph, agent, item, { kind: 'message', message });
}
export function setAction(
  graph: CanvasDocument,
  agent: string,
  item: string,
  action: string,
): CanvasDocument {
  return queueChange(graph, agent, item, { kind: 'action', action });
}
export function setInstruction(
  graph: CanvasDocument,
  agent: string,
  item: string,
  instruction: string,
): CanvasDocument {
  return queueChange(graph, agent, item, { kind: 'instruction', instruction });
}
export function setExpect(
  graph: CanvasDocument,
  agent: string,
  item: string,
  expect: QueueStep['expect'],
): CanvasDocument {
  return queueChange(graph, agent, item, { kind: 'expect', expect: expect ?? null });
}
export function setCondition(
  graph: CanvasDocument,
  agent: string,
  item: string,
  condition: Condition,
): CanvasDocument {
  return queueChange(graph, agent, item, { kind: 'condition', condition });
}
export function setWaitFor(
  graph: CanvasDocument,
  agent: string,
  item: string,
  waitFor: WaitTarget[],
): CanvasDocument {
  return queueChange(graph, agent, item, { kind: 'waitFor', waitFor });
}
export function setTime(
  graph: CanvasDocument,
  agent: string,
  item: string,
  time: Time | undefined,
): CanvasDocument {
  return queueChange(graph, agent, item, { kind: 'time', time: time ?? null });
}
export function setApproval(
  graph: CanvasDocument,
  agent: string,
  item: string,
  approve: string,
): CanvasDocument {
  return queueChange(graph, agent, item, { kind: 'approve', approve });
}
export function setRepeat(
  graph: CanvasDocument,
  agent: string,
  item: string,
  change: Partial<Pick<QueueRepeat, 'until' | 'rounds' | 'otherwise'>>,
): CanvasDocument {
  return queueChange(graph, agent, item, { kind: 'repeat', ...change });
}

/** Remaining queue/settings gestures until tasks 11–12, over model documents only. */
function editGraph<R>(
  document: CanvasDocument,
  build: (doc: CanvasDocument) => Built<R>,
): CanvasDocument {
  return build(document).next;
}
