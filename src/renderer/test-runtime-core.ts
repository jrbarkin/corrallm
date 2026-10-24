import { AgentId, MessageId } from '../shared/api/ids';
import { MAX_TOPIC_FRAME } from '../shared/api/limits';
import type { RuntimeTopicKey, RuntimeSnapshotFrame, TopicRequest } from '../shared/api/topics';
import { topicKey, RuntimeTopic } from '../shared/api/topics';
import { runtimeKey } from './api/topic-wire';
import { newCanvasId } from '../shared/canvas';
import { NEW_SESSION } from '../shared/model/session';
import type { Entry } from '../shared/model/session';
import { messageView, runView, sessionView } from '../shared/model/views';
import type { MirrorSnapshot, MirrorSource, MirrorUpdate, MirrorTopicKey } from './api/topic-wire';

/** Shared projections, including a message/attempt/user/tool/child chain and retained history. */
export function runtimeWorld(history = 0) {
  const canvas = newCanvasId();
  const agent = AgentId.parse('builder:%"\n');
  const other = AgentId.parse('__proto__');
  const id = MessageId.parse('00000000-0000-4000-8000-000000000001');
  const entries: Entry[] = [
    { id: 'user', kind: 'user', text: 'Build it' },
    { id: 'tool', kind: 'tool', tool: 'Agent', summary: 'Delegate', status: 'running' },
    { id: 'child', kind: 'text', text: 'Working', parent: 'tool' },
    ...Array.from({ length: history }, (_, i): Entry[] => [
      { id: `prompt-${String(i)}`, kind: 'user', text: 'Another turn' },
      { id: `history-${String(i)}`, kind: 'text', text: 'x'.repeat(2048) },
    ]).flat(),
  ];
  const session = sessionView(agent, 'test.connection', {
    ...NEW_SESSION,
    status: 'working',
    entries,
  });
  const run = runView({
    running: true,
    agents: {
      [agent]: {
        status: 'running',
        current: 'work',
        outcomes: {},
        attempts: {
          work: [{ id: 'attempt', messageId: id, startedAt: 1, status: 'running' }],
        },
      },
      [other]: { status: 'waiting', outcomes: {} },
    },
  });
  const message = messageView(
    {
      id,
      canvas,
      from: 'you',
      to: `agent:${agent}`,
      kind: 'text',
      body: 'Build it',
      state: 'delivered',
      at: 1,
      delivery: { at: 1, as: 'user', attempt: 1 },
    },
    'manual',
  );
  const keys = {
    run: runtimeKey({ topic: 'run', canvas }),
    sessions: runtimeKey({ topic: 'sessions', canvas }),
    session: runtimeKey({ topic: 'session', canvas, agent }),
    messages: runtimeKey({ topic: 'messages', canvas }),
  };
  return {
    canvas,
    agent,
    other,
    id,
    keys,
    run,
    session,
    message,
    sessions: { agents: { [agent]: session.summary } },
    messages: { items: { [id]: message }, order: [id], next: 'cursor' },
  };
}

/** Independent core state: snapshots are projections, never calculated by the mirror's patcher. */
export function runtimeCore() {
  let epoch = 'one';
  let changed: ((updates: MirrorUpdate[]) => void) | undefined;
  let restarted: ((epoch: string) => void) | undefined;
  const pending: {
    topic: MirrorTopicKey;
    resolve: (snapshot: MirrorSnapshot | RuntimeSnapshotFrame) => void;
  }[] = [];
  const requests: unknown[] = [];
  const unsubscriptions: unknown[] = [];
  const source: MirrorSource = {
    topicsSubscribe: (request) => {
      requests.push(request);
      const key =
        request.topic === 'run' ||
        request.topic === 'session' ||
        request.topic === 'sessions' ||
        request.topic === 'messages'
          ? topicKey(RuntimeTopic.parse(request))
          : topicKey(request as TopicRequest);
      return new Promise((resolve) => pending.push({ topic: key, resolve }));
    },
    topicsUnsubscribe: (request) => {
      unsubscriptions.push(request);
      return Promise.resolve({});
    },
    topicsOnChange: (listener) => {
      changed = listener;
      return () => {
        changed = undefined;
      };
    },
    topicsOnEpoch: (listener) => {
      restarted = listener;
      listener(epoch);
      return () => {
        restarted = undefined;
      };
    },
  };
  return {
    source,
    requests,
    pending,
    unsubscriptions,
    send: (...updates: MirrorUpdate[]) => changed?.(updates),
    epoch: (value: string) => {
      epoch = value;
      restarted?.(value);
    },
    answer: (index: number, state: MirrorSnapshot['state'], rev = 0) =>
      pending[index]?.resolve({ epoch, rev, state }),
  };
}

/** A fake publisher's chunking, with only the wire contract shared with the consumer. */
export function sessionFrames(
  topic: RuntimeTopicKey,
  world: ReturnType<typeof runtimeWorld>,
  rev = 0,
): RuntimeSnapshotFrame[] {
  const base = { topic, epoch: 'one', snapshot: 'transfer' };
  const frames: RuntimeSnapshotFrame[] = [
    { ...base, kind: 'begin', summary: world.session.summary, count: world.session.order.length },
  ];
  let entries: { key: string; value: unknown }[] = [];
  const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
  const emptySize = size({ ...base, kind: 'chunk', entries: [] });
  let bytes = emptySize;
  for (const key of world.session.order) {
    const entry = { key, value: world.session.entries[key] };
    const entrySize = size(entry);
    if (entries.length && bytes + 1 + entrySize > MAX_TOPIC_FRAME) {
      frames.push({ ...base, kind: 'chunk', entries });
      entries = [];
      bytes = emptySize;
    }
    bytes += entrySize + (entries.length ? 1 : 0);
    entries.push(entry);
  }
  if (entries.length) frames.push({ ...base, kind: 'chunk', entries });
  frames.push({ ...base, kind: 'end', rev });
  return frames;
}
