import type { PartyId } from '../model/messages';
import type { EntityKey } from '../model/rows';
import type { Entities } from '../model/state';
import type { CanvasId } from '../canvas';
import type { UsageState } from '../usage';
import type { ResultOf } from './registry';

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

export function topicRequest(topic: TopicKey): TopicRequest {
  if (topic.startsWith('canvas:')) return { topic: 'canvas', canvas: topic.slice(7) as CanvasId };
  if (topic.startsWith('needs:')) return { topic: 'needs', canvas: topic.slice(6) as CanvasId };
  return { topic: topic as 'usage' | 'settings' | 'canvases' };
}

/** The topic a subscription names: a canvas's only with its canvas, which a global one ignores. */
export function topicKey(request: { topic: TopicName; canvas?: string | undefined }): TopicKey {
  if (request.topic === 'canvas' || request.topic === 'needs') {
    if (request.canvas === undefined) throw new Error(`A ${request.topic} topic names its canvas.`);
    return `${request.topic}:${request.canvas as CanvasId}`;
  }
  return request.topic;
}

/** The canvas a canvas's topic is of; none for a global topic. */
export function canvasOfTopic(topic: TopicKey): CanvasId | undefined {
  const request = topicRequest(topic);
  return 'canvas' in request ? request.canvas : undefined;
}
