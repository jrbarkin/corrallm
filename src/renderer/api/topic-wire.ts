import type {
  Change,
  RuntimeChange,
  RuntimeSnapshotFrame,
  RuntimeTopicKey,
  RuntimeTopicRequest,
  RuntimeTopicStates,
  TopicKey,
  TopicRequest,
  TopicSnapshot,
  TopicStates,
} from '../../shared/api/topics';
import { topicRequest, topicKey, RuntimeTopic } from '../../shared/api/topics';
import type { CanvasId } from '../../shared/canvas';
import { MessageId } from '../../shared/api/ids';
import type { AgentId } from '../../shared/api/ids';
import type { ReadonlyData } from '../../shared/model/views';
import type { EntryView, SessionView } from '../../shared/model/views';
import { projectData } from '../../shared/model/views';

export type MirrorTopicKey = TopicKey | RuntimeTopicKey;
export type MirrorStates = TopicStates & RuntimeTopicStates;
export interface MirrorSnapshot {
  epoch: string;
  rev: number;
  state: TopicSnapshot['state'] | RuntimeTopicStates[RuntimeTopicKey];
}
export type MirrorUpdate = Change | RuntimeChange | RuntimeSnapshotFrame;
/** Additive receiver seam for C8; the registered GUI subscription remains B9-only until then. */
export interface MirrorSource {
  topicsSubscribe(
    request: TopicRequest | RuntimeTopicRequest,
  ): Promise<MirrorSnapshot | RuntimeSnapshotFrame>;
  topicsUnsubscribe(request: TopicRequest | RuntimeTopicRequest): Promise<unknown>;
  topicsOnChange(listener: (updates: MirrorUpdate[]) => void): () => void;
  topicsOnEpoch(listener: (epoch: string) => void): () => void;
}
export function runtimeTopic(topic: MirrorTopicKey): topic is RuntimeTopicKey {
  return /^(run|sessions|session|messages):/.test(topic);
}
export function mirrorRequest(topic: MirrorTopicKey): TopicRequest | RuntimeTopicRequest {
  return runtimeTopic(topic) ? topicRequest(topic) : topicRequest(topic);
}

/** Validate the model's CanvasId at the prepared API-brand boundary, preserving the key kind. */
export function runtimeKey<K extends RuntimeTopicRequest['topic']>(
  request: { topic: K; canvas: CanvasId } & (K extends 'session'
    ? { agent: AgentId }
    : { agent?: never }),
): Extract<RuntimeTopicKey, `${K}:${string}`> {
  return topicKey(RuntimeTopic.parse(request)) as Extract<RuntimeTopicKey, `${K}:${string}`>;
}

/** Copy only touched entities. Computed keys also work for ids such as __proto__. */
function keyed<T>(
  previous: Readonly<Record<string, T>>,
  set: Readonly<Record<string, T>>,
  remove: readonly string[] = [],
): Readonly<Record<string, T>> {
  let next = previous;
  const writable = () => {
    if (next === previous) next = { ...previous };
    return next;
  };
  for (const [key, value] of Object.entries(set)) {
    const shared = projectData(value, previous[key] as ReadonlyData<T> | undefined);
    if (Object.hasOwn(previous, key) && shared === previous[key]) continue;
    Object.defineProperty(writable(), key, {
      value: shared,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  if (remove.some((key) => Object.hasOwn(next, key))) {
    for (const key of remove) Reflect.deleteProperty(writable(), key);
  }
  return next;
}
function orderOf<T>(
  items: Readonly<Record<string, T>>,
  previous: readonly string[],
  order?: readonly string[],
): readonly string[] {
  const kept = new Set(previous);
  const next = order ?? [
    ...previous.filter((key) => Object.hasOwn(items, key)),
    ...Object.keys(items).filter((key) => !kept.has(key)),
  ];
  if (
    new Set(next).size !== next.length ||
    next.length !== Object.keys(items).length ||
    next.some((key) => !Object.hasOwn(items, key))
  )
    throw new Error('The topic order must name every retained entity exactly once.');
  return projectData(next, previous);
}

export function runtimePatch(
  previous: RuntimeTopicStates[RuntimeTopicKey],
  change: RuntimeChange,
): RuntimeTopicStates[RuntimeTopicKey] {
  // The discriminant is a template key; narrowing through its prepared request is explicit here.
  const request = topicRequest(change.topic);
  if (request.topic === 'run') {
    const old = previous as RuntimeTopicStates[`run:${CanvasId}`];
    const patch = change as Extract<RuntimeChange, { topic: `run:${string}` }>;
    let next = old;
    for (const [key, value] of Object.entries(patch.top ?? {})) {
      if (value === null) {
        if (!Object.hasOwn(next, key)) continue;
        if (next === old) next = { ...old };
        Reflect.deleteProperty(next, key);
      } else {
        const before: unknown = Reflect.get(old, key);
        const shared = projectData<unknown>(value, before);
        if (Object.hasOwn(old, key) && before === shared) continue;
        if (next === old) next = { ...old };
        Object.defineProperty(next, key, {
          value: shared,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
    }
    const agents = patch.agents
      ? keyed(old.agents, patch.agents.set, patch.agents.remove)
      : old.agents;
    return agents === next.agents ? next : { ...next, agents };
  }
  if (request.topic === 'sessions') {
    const old = previous as RuntimeTopicStates[`sessions:${CanvasId}`];
    const patch = change as Extract<RuntimeChange, { topic: `sessions:${string}` }>;
    const agents = keyed(old.agents, patch.agents.set, patch.agents.remove);
    return agents === old.agents ? old : { agents };
  }
  if (request.topic === 'session') {
    const old = previous as SessionView;
    const patch = change as Extract<RuntimeChange, { topic: `session:${string}` }>;
    let entries = keyed(
      old.entries,
      Object.fromEntries((patch.entries.upsert ?? []).map((entry) => [entry.id, entry])),
    );
    for (const append of patch.entries.append ?? []) {
      const entry = Object.hasOwn(entries, append.id) ? entries[append.id] : undefined;
      if (!entry || (entry.kind !== 'text' && entry.kind !== 'thinking'))
        throw new Error('A text append must name a retained text or thinking entry.');
      if (append.text)
        entries = { ...entries, [append.id]: { ...entry, text: entry.text + append.text } };
    }
    if (patch.entries.order) {
      if (
        new Set(patch.entries.order).size !== patch.entries.order.length ||
        patch.entries.order.some((id) => !Object.hasOwn(entries, id))
      )
        throw new Error('History order names a missing or duplicate entry.');
      const keep = new Set(patch.entries.order);
      entries = keyed(
        entries,
        {},
        Object.keys(entries).filter((key) => !keep.has(key)),
      );
    }
    const added = (patch.entries.upsert ?? [])
      .map(({ id }) => id)
      .filter((id) => !Object.hasOwn(old.entries, id));
    const order = patch.entries.order
      ? orderOf(entries, old.order, patch.entries.order)
      : added.length
        ? [...old.order, ...new Set(added)]
        : old.order;
    const summary = patch.summary ? projectData(patch.summary, old.summary) : old.summary;
    return entries === old.entries && order === old.order && summary === old.summary
      ? old
      : { summary, entries, order };
  }
  const old = previous as RuntimeTopicStates[`messages:${CanvasId}`];
  const patch = change as Extract<RuntimeChange, { topic: `messages:${string}` }>;
  const items = keyed(old.items, patch.set, patch.remove);
  const added = Object.keys(patch.set).filter(
    (id) => !Object.hasOwn(old.items, id) && Object.hasOwn(items, id),
  );
  const removed = new Set(patch.remove);
  const order = (
    patch.order
      ? orderOf(items, old.order, patch.order)
      : added.length || removed.size
        ? [...old.order.filter((id) => !removed.has(id)), ...added]
        : old.order
  ) as typeof old.order;
  const next = patch.next ?? old.next;
  return items === old.items && order === old.order && next === old.next
    ? old
    : { items, order, next };
}

/** Chunk order is the only order on the wire; no partial snapshot escapes this builder. */
export function assembledState(
  topic: RuntimeTopicKey,
  summary: unknown,
  pairs: readonly (readonly [string, unknown])[],
): RuntimeTopicStates[RuntimeTopicKey] {
  const request = topicRequest(topic);
  const values = Object.fromEntries(pairs);
  if (request.topic === 'session')
    return {
      summary: summary as SessionView['summary'],
      entries: values as Record<string, EntryView>,
      order: pairs.map(([key]) => key),
    };
  if (request.topic === 'run')
    return {
      ...(summary as Omit<RuntimeTopicStates[`run:${CanvasId}`], 'agents'>),
      agents: values as RuntimeTopicStates[`run:${CanvasId}`]['agents'],
    };
  if (request.topic === 'sessions')
    return { agents: values as RuntimeTopicStates[`sessions:${CanvasId}`]['agents'] };
  return {
    items: values as RuntimeTopicStates[`messages:${CanvasId}`]['items'],
    order: pairs.map(([key]) => MessageId.parse(key)),
    next: (summary as { next: string }).next,
  };
}

/** Validate references needed to apply future deltas; payload field validation belongs to C8. */
export function checkRuntimeState(
  topic: RuntimeTopicKey,
  state: RuntimeTopicStates[RuntimeTopicKey],
): void {
  const request = topicRequest(topic);
  if (request.topic === 'session') {
    const view = state as SessionView;
    if (view.summary.agent !== request.agent)
      throw new Error('The session summary names another agent.');
    orderOf(view.entries, [], view.order);
    for (const [key, entry] of Object.entries(view.entries))
      if (entry.id !== key) throw new Error('An entry key differs from its id.');
  } else if (request.topic === 'messages') {
    const view = state as RuntimeTopicStates[`messages:${CanvasId}`];
    orderOf(view.items, [], view.order);
    for (const [key, item] of Object.entries(view.items))
      if (item.id !== key || String(item.canvas) !== request.canvas)
        throw new Error('A message key or canvas differs from its topic.');
  } else if (request.topic === 'sessions') {
    const view = state as RuntimeTopicStates[`sessions:${CanvasId}`];
    for (const [key, agent] of Object.entries(view.agents))
      if (agent.agent !== key) throw new Error('A summary key differs from its agent.');
  }
}
