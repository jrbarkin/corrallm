import type { PartyId } from '../model/messages';
import type { CanvasId } from '../canvas';
import type { UsageState } from '../usage';
import type { ResultOf } from './registry';

/** The global topics served from B8; canvas topics follow with their operations. */
export const TOPICS = ['usage', 'settings'] as const;
export type TopicKey =
  (typeof TOPICS)[number] | 'canvases' | `canvas:${CanvasId}` | `needs:${CanvasId}`;
export type TopicRequest =
  { topic: 'usage' | 'settings' | 'canvases' } | { topic: 'canvas' | 'needs'; canvas: CanvasId };

/** The document's row keys (B9 Design §2, §7); row values cross the port as data. */
export type EntityKey =
  'meta' | `node/${string}` | `link/${string}/${string}` | `item/${string}/${string}`;
export type Entities = Partial<Record<EntityKey, unknown>>;

export interface TopicStates {
  usage: UsageState;
  settings: ResultOf<'settings.get'>;
  canvases: {
    items: {
      canvas: CanvasId;
      name: string;
      edited: boolean;
      running: boolean;
      open: boolean;
      project: string | null;
      shownIn: number[];
    }[];
  };
  [topic: `canvas:${CanvasId}`]: Entities;
  [topic: `needs:${CanvasId}`]: ResultOf<'needs'>;
}
export interface TopicSnapshot<K extends TopicKey = TopicKey> {
  epoch: string;
  rev: number;
  state: TopicStates[K];
}

/** Revisions are per topic; sequence numbers are shared by a canvas's topics. */
export type Change = {
  [K in TopicKey]: {
    topic: K;
    epoch: string;
    rev: number;
    seq: number;
    by: PartyId | 'cli';
    at: number;
  } & (
    | { replace: TopicStates[K] }
    | (K extends `canvas:${CanvasId}` ? { set: Entities; remove?: EntityKey[] } : never)
  );
}[TopicKey];

export function topicRequest(topic: TopicKey): TopicRequest {
  if (topic.startsWith('canvas:')) return { topic: 'canvas', canvas: topic.slice(7) as CanvasId };
  if (topic.startsWith('needs:')) return { topic: 'needs', canvas: topic.slice(6) as CanvasId };
  return { topic: topic as 'usage' | 'settings' | 'canvases' };
}

export function topicKey(request: TopicRequest): TopicKey {
  return 'canvas' in request ? `${request.topic}:${request.canvas}` : request.topic;
}
