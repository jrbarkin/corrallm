import type { AdapterId, ConnectionId } from '../adapter';
import type { CanvasId } from '../canvas';
import type { AgentSettings } from '../session';
import type { QueueItem } from './queue';

/*
 * A canvas as the model keeps it: its agents, the frames that group them and the links between
 * agents, by what they mean, with nothing of how a view draws them (no selection, no sizes: a
 * group fits what it holds). The run reads only these; the renderer's graph wraps each agent's data
 * in a React Flow node (src/renderer/graph/graph.ts GraphNode) and gives the run the model's
 * nodes (canvasNodes there).
 *
 * Plain data, free of Node, Electron, the DOM and React Flow: it is compiled into every process.
 */

/**
 * How long a node's id may be (an agent's or a group's, unique within its canvas): any text, its
 * file's and the API's alike, and so what an agent's party id holds (src/shared/model/messages.ts).
 */
export const MAX_NODE_ID = 256;

/** Where a node sits: relative to its parent's position, as its file keeps it. */
export interface Position {
  x: number;
  y: number;
}

/**
 * What an agent is: its name (`label`), the agent it runs (`adapter`: the default agent's when
 * none) and how (`connection`: its adapter's first when none), what it is set to run with by each
 * adapter it has run (`settings`: its model, effort and starting mode, src/shared/session.ts), its
 * standing instructions (`role`, whichever adapter runs it), its queue, and, while it holds other
 * nodes, their group's colour (`color`, an index into the palette of group colours).
 */
export interface AgentData {
  label: string;
  adapter?: AdapterId;
  connection?: ConnectionId;
  settings?: Partial<Record<AdapterId, AgentSettings>>;
  role?: string;
  queue?: QueueItem[];
  color?: number;
}

/** An agent on a canvas. With children, it is their group's head (`parentId`: theirs is its id). */
export interface AgentNode {
  id: string;
  type: 'agent';
  position: Position;
  /** The group it is in: a frame, or an agent that holds it. */
  parentId?: string;
  data: AgentData;
}

/** A frame: a labelled box that only groups the nodes it holds, in its colour. */
export interface FrameNode {
  id: string;
  type: 'frame';
  position: Position;
  parentId?: string;
  data: { label: string; color?: number };
}

export type CanvasNode = AgentNode | FrameNode;

/** Two agents that can talk, as drawn: from `source` to `target`, between the dots it joined. */
export interface Link {
  source: string;
  target: string;
  dots?: [from: string, to: string];
}

/** A canvas: its stable id (src/shared/canvas.ts), its nodes, parents before children, and links. */
export interface CanvasDocument {
  id: CanvasId;
  nodes: CanvasNode[];
  links: Link[];
}

/**
 * A node as reading a canvas needs it, whoever keeps it: the model (CanvasNode), or a view whose
 * nodes wrap an agent's data. Frames hold no queue.
 */
export interface NodeLike {
  id: string;
  type?: CanvasNode['type'];
  parentId?: string;
  data: { label: string; queue?: readonly QueueItem[] };
}
