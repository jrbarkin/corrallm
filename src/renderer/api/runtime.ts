import { useMemo } from 'react';
import type { AgentId } from '../../shared/api/ids';
import { runtimeKey } from './topic-wire';
import type { RuntimeTopicStates } from '../../shared/api/topics';
import type { CanvasId } from '../../shared/canvas';
import type { EntryView, MessageView, SessionView } from '../../shared/model/views';
import { topics, useTopic } from './topics';
import type { TopicMirror } from './topics';

/** These adapters read only the core mirror. No local engine or reconstruction fallback. */
export function useRunView(canvas: CanvasId, mirror: TopicMirror = topics) {
  return useTopic(runtimeKey({ topic: 'run', canvas }), mirror);
}
export function useSessionSummaries(canvas: CanvasId, mirror: TopicMirror = topics) {
  return useTopic(runtimeKey({ topic: 'sessions', canvas }), mirror)?.agents;
}
export function useSessionView(canvas: CanvasId, agent: AgentId, mirror: TopicMirror = topics) {
  return useTopic(runtimeKey({ topic: 'session', canvas, agent }), mirror);
}
const emptyEntries: readonly EntryView[] = Object.freeze([]);
const entryLists = new WeakMap<
  SessionView['entries'],
  { order: SessionView['order']; entries: readonly EntryView[] }
>();
export function orderedEntries(view: SessionView | undefined): readonly EntryView[] {
  if (!view) return emptyEntries;
  const cached = entryLists.get(view.entries);
  if (cached?.order === view.order) return cached.entries;
  const entries = Object.freeze(view.order.flatMap((id) => view.entries[id] ?? []));
  entryLists.set(view.entries, { order: view.order, entries });
  return entries;
}
export function useSessionEntries(canvas: CanvasId, agent: AgentId, mirror: TopicMirror = topics) {
  return orderedEntries(useSessionView(canvas, agent, mirror));
}
const emptyMessages: readonly MessageView[] = Object.freeze([]);
type Messages = RuntimeTopicStates[`messages:${CanvasId}`];
const messageLists = new WeakMap<Messages, Map<AgentId, readonly MessageView[]>>();
/** Incoming and outgoing mailbox rows involving this agent, in the core's order. */
export function messagesForAgent(
  view: Messages | undefined,
  agent: AgentId,
): readonly MessageView[] {
  if (!view) return emptyMessages;
  let byAgent = messageLists.get(view);
  if (!byAgent) {
    byAgent = new Map();
    messageLists.set(view, byAgent);
  }
  let messages = byAgent.get(agent);
  if (!messages) {
    messages = Object.freeze(
      view.order.flatMap((id) => {
        const item = view.items[id];
        return item && (item.to === `agent:${agent}` || item.from === `agent:${agent}`)
          ? [item]
          : [];
      }),
    );
    byAgent.set(agent, messages);
  }
  return messages;
}
export function useAgentMessages(canvas: CanvasId, agent: AgentId, mirror: TopicMirror = topics) {
  const view = useTopic(runtimeKey({ topic: 'messages', canvas }), mirror);
  return useMemo(() => messagesForAgent(view, agent), [view, agent]);
}
