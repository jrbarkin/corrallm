import type { PartyId } from '../model/messages';
import type { EntityKey } from '../model/rows';
import type { Entities } from '../model/state';
import type { CanvasId } from '../canvas';
import { isCanvasId } from '../canvas';
import type { UsageState } from '../usage';
import type { ResultOf } from './registry';
import { z } from 'zod';
import { AgentId, CanvasId as CanvasIdSchema } from './ids';
import { MAX_TOPIC_FRAME } from './limits';
import type { EntryView, MessageView, RunView, SessionSummary, SessionView } from '../model/views';
import type { MessageId } from './ids';

/*
 * The state the core pushes a window (Core Server §5.1–5.2, B9 Design §7). Each topic is read
 * through the op whose surface declares it (`reads`), as the subscriber, so its audience and reach
 * are the one authorization path; then its changes follow. `usage`, `settings`, `canvases` and a
 * canvas's `needs:<c>` are replaced whole; a canvas's `canvas:<c>` is keyed, by entity: each change
 * sets the rows a commit wrote and removes those it removed, so a window keeps its own copy of the
 * document's rows and builds the canvas from it with canvasStateOf (model/state.ts).
 */

/** The topics a window subscribes to, by name: the global ones, and a canvas's. */
export const TOPICS = ['usage', 'settings', 'canvases', 'canvas', 'needs'] as const;
export type TopicName = (typeof TOPICS)[number];
/** The topics that are a canvas's: one each per canvas. */
export const CANVAS_TOPICS = ['canvas', 'needs'] as const;

export type TopicKey =
  'usage' | 'settings' | 'canvases' | `canvas:${CanvasId}` | `needs:${CanvasId}`;
export type TopicRequest =
  { topic: 'usage' | 'settings' | 'canvases' } | { topic: 'canvas' | 'needs'; canvas: CanvasId };

export interface TopicStates {
  usage: UsageState;
  settings: ResultOf<'settings.get'>;
  canvases: ResultOf<'canvas.list'>;
  [topic: `canvas:${CanvasId}`]: Entities;
  [topic: `needs:${CanvasId}`]: ResultOf<'needs'>;
}
export interface TopicSnapshot<K extends TopicKey = TopicKey> {
  epoch: string;
  rev: number;
  state: TopicStates[K];
}

/** What a change carries of a canvas's entities: those set (written), and those removed. */
export interface Keyed {
  set: Entities;
  remove?: EntityKey[];
}

/**
 * Revisions are per topic (a canvas's is its document's); sequence numbers are per canvas, shared by
 * its topics, and the global topics share theirs.
 */
export type Change = {
  [K in TopicKey]: {
    topic: K;
    epoch: string;
    rev: number;
    seq: number;
    by: PartyId | 'cli';
    at: number;
  } & ({ replace: TopicStates[K] } | (K extends `canvas:${CanvasId}` ? Keyed : never));
}[TopicKey];

export function topicRequest(topic: TopicKey): TopicRequest;
export function topicRequest(topic: RuntimeTopicKey): RuntimeTopicRequest;
export function topicRequest(
  topic: TopicKey | RuntimeTopicKey,
): TopicRequest | RuntimeTopicRequest {
  if (topic.startsWith('session:')) {
    const parts = topic.split(':');
    if (parts.length !== 3) throw new Error('A session topic names one canvas and encoded agent.');
    const encoded = parts[2] ?? '';
    const agent = decodeURIComponent(encoded);
    if (encodeURIComponent(agent) !== encoded)
      throw new Error('A session topic uses a canonical encoded agent.');
    return RuntimeTopic.parse({ topic: 'session', canvas: parts[1], agent });
  }
  for (const kind of ['run', 'sessions', 'messages'] as const)
    if (topic.startsWith(`${kind}:`))
      return RuntimeTopic.parse({ topic: kind, canvas: topic.slice(kind.length + 1) });
  if (topic.startsWith('canvas:')) return { topic: 'canvas', canvas: topic.slice(7) as CanvasId };
  if (topic.startsWith('needs:')) return { topic: 'needs', canvas: topic.slice(6) as CanvasId };
  return { topic: topic as 'usage' | 'settings' | 'canvases' };
}

/** The topic a subscription names: a canvas's only with its canvas, which a global one ignores. */
export function topicKey(request: { topic: TopicName; canvas?: string | undefined }): TopicKey;
export function topicKey(request: RuntimeTopicRequest): RuntimeTopicKey;
export function topicKey(
  request: { topic: TopicName; canvas?: string | undefined } | RuntimeTopicRequest,
): TopicKey | RuntimeTopicKey {
  if (RUNTIME_TOPICS.some((kind) => kind === request.topic)) {
    const parsed = RuntimeTopic.parse(request);
    if (!isCanvasId(parsed.canvas)) throw new Error('A runtime topic names a canvas UUID.');
    const canvas: CanvasId = parsed.canvas;
    return parsed.topic === 'session'
      ? `session:${canvas}:${encodeURIComponent(parsed.agent)}`
      : `${parsed.topic}:${canvas}`;
  }
  if (request.topic === 'canvas' || request.topic === 'needs') {
    if (request.canvas === undefined) throw new Error(`A ${request.topic} topic names its canvas.`);
    return `${request.topic}:${request.canvas as CanvasId}`;
  }
  return request.topic as 'usage' | 'settings' | 'canvases';
}

/** Prepared B11 contracts only. TOPICS and the live subscription schema stay unchanged until C8. */
export const RUNTIME_TOPICS = ['run', 'sessions', 'session', 'messages'] as const;
export const RuntimeTopic = z
  .union([
    z.strictObject({ topic: z.enum(['run', 'sessions', 'messages']), canvas: CanvasIdSchema }),
    z.strictObject({ topic: z.literal('session'), canvas: CanvasIdSchema, agent: AgentId }),
  ])
  .refine(
    (request) => request.topic !== 'session' || request.agent.isWellFormed(),
    'An agent id must be well-formed Unicode',
  );
export type RuntimeTopicRequest = z.output<typeof RuntimeTopic>;
export type RuntimeTopicKey =
  | `run:${CanvasId}`
  | `sessions:${CanvasId}`
  | `session:${CanvasId}:${string}`
  | `messages:${CanvasId}`;
export interface RuntimeTopicStates {
  [topic: `run:${CanvasId}`]: RunView;
  [topic: `sessions:${CanvasId}`]: { readonly agents: Readonly<Record<AgentId, SessionSummary>> };
  [topic: `session:${CanvasId}:${string}`]: SessionView;
  [topic: `messages:${CanvasId}`]: {
    readonly items: Readonly<Record<MessageId, MessageView>>;
    readonly order: readonly MessageId[];
    readonly next: string;
  };
}
interface AgentChanges<T> {
  readonly set: Readonly<Record<AgentId, T>>;
  readonly remove?: readonly AgentId[];
}
export interface RunTopChange {
  readonly running?: boolean;
  readonly paused?: boolean | null;
  readonly individualPauses?: RunView['individualPauses'] | null;
  readonly groupPauses?: RunView['groupPauses'] | null;
  readonly notices?: RunView['notices'];
  readonly saveError?: string | null;
}
export type RuntimeChange = {
  [K in RuntimeTopicKey]: {
    readonly topic: K;
    readonly epoch: string;
    readonly rev: number;
    readonly seq: number;
    readonly by: PartyId | 'cli';
    readonly at: number;
  } & (K extends `run:${CanvasId}`
    ? { readonly top?: RunTopChange; readonly agents?: AgentChanges<RunView['agents'][AgentId]> }
    : K extends `sessions:${CanvasId}`
      ? { readonly agents: AgentChanges<SessionSummary> }
      : K extends `session:${CanvasId}:${string}`
        ? {
            readonly summary?: SessionSummary;
            readonly entries: {
              readonly upsert?: readonly EntryView[];
              readonly append?: readonly { readonly id: string; readonly text: string }[];
              readonly order?: readonly string[];
            };
          }
        : {
            readonly set: Readonly<Record<MessageId, MessageView>>;
            readonly remove?: readonly MessageId[];
            readonly order?: readonly MessageId[];
            readonly next?: string;
          });
}[RuntimeTopicKey];

/** count is the number of chunks, indexed from zero. Entry order follows those chunks, without
 * a full order header. Deltas follow end, never precede it (B11 §16.3a). */
export type RuntimeSnapshotFrame<S = unknown, E = unknown> = {
  readonly topic: RuntimeTopicKey;
  readonly epoch: string;
  readonly snapshot: string;
} & (
  | { readonly kind: 'begin'; readonly summary: S; readonly count: number }
  | {
      readonly kind: 'chunk';
      readonly index: number;
      readonly entries: readonly { readonly key: string; readonly value: E }[];
    }
  | { readonly kind: 'end'; readonly rev: number }
);
export type RuntimeSnapshotFor<K extends RuntimeTopicKey> = RuntimeSnapshotFrame<
  K extends `run:${CanvasId}`
    ? Omit<RunView, 'agents'>
    : K extends `session:${CanvasId}:${string}`
      ? SessionSummary
      : K extends `messages:${CanvasId}`
        ? { readonly next: string }
        : Record<string, never>,
  K extends `run:${CanvasId}`
    ? RunView['agents'][AgentId]
    : K extends `session:${CanvasId}:${string}`
      ? EntryView
      : K extends `messages:${CanvasId}`
        ? MessageView
        : SessionSummary
> & { readonly topic: K };

/** C1's sole size exception is a chunk containing one intrinsically oversized entry. */
export function snapshotFrameFits(frame: RuntimeSnapshotFrame): boolean {
  const bytes = (data: unknown) => new TextEncoder().encode(JSON.stringify(data)).length;
  if (frame.kind === 'begin' && (!Number.isSafeInteger(frame.count) || frame.count < 0))
    return false;
  if (frame.kind === 'chunk' && (!Number.isSafeInteger(frame.index) || frame.index < 0))
    return false;
  if (frame.kind === 'end' && (!Number.isSafeInteger(frame.rev) || frame.rev < 0)) return false;
  if (bytes(frame) <= MAX_TOPIC_FRAME) return true;
  return (
    frame.kind === 'chunk' &&
    frame.entries.length === 1 &&
    bytes(frame.entries[0]?.value) > MAX_TOPIC_FRAME
  );
}

/** The canvas a canvas's topic is of; none for a global topic. */
export function canvasOfTopic(topic: TopicKey): CanvasId | undefined {
  const request = topicRequest(topic);
  return 'canvas' in request ? request.canvas : undefined;
}
