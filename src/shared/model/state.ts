import type { CanvasId } from '../canvas';
import type { CanvasNode, Link } from './canvas';
import type { PartyId } from './messages';
import { fromRows, META } from './rows';
import type { EntityKey, ItemRow, LinkRow, MetaRow, NodeRow } from './rows';

/*
 * A canvas as the core tells it (B9 Design §7, Core Server §5.1): its document's rows, each with
 * the revision it took last and the party that wrote it, and the canvas's meta, which says what the
 * document says of itself and what the core says of the canvas. The `canvas:<c>` topic carries
 * these entities, by key, and `canvas.get` the nested state built from them with the same function
 * (`canvasStateOf`) a window builds its own from its copy of the topic, so the two can't differ.
 *
 * Plain data, free of Node, Electron and the DOM: it is compiled into every process.
 */

/** Who changed an entity last, and the revision of its canvas it took then. */
export interface Stamp {
  rev: number;
  by: PartyId;
}

/** A canvas's project folder: its name and its path, which every caller may read. */
export interface ProjectOf {
  name: string;
  path: string;
}

/**
 * What the document says of itself (whether structural edits lay it out), and what the core says
 * of its canvas: its file's name (none: never saved), whether the document differs from its text as
 * last saved or read, and its project folder (none: not chosen).
 */
export interface CanvasMeta extends MetaRow {
  name: string | null;
  edited: boolean;
  project: ProjectOf | null;
}

export type NodeEntity = NodeRow & Stamp;
export type LinkEntity = LinkRow & Stamp;
export type ItemEntity = ItemRow & Stamp;
export type MetaEntity = CanvasMeta & Stamp;
export type Entity = NodeEntity | LinkEntity | ItemEntity | MetaEntity;

/** A canvas's entities, by key: `meta`, and its document's rows (rows.ts), each stamped. */
export type Entities = Readonly<Record<EntityKey, Entity>>;

/** A canvas as `canvas.get` gives it: its meta, its document, and each entity's stamp, by key. */
export interface CanvasState extends CanvasMeta {
  canvas: CanvasId;
  /** The revision of its `canvas:<c>` topic it was read at. */
  rev: number;
  nodes: CanvasNode[];
  links: Link[];
  entities: Record<EntityKey, Stamp>;
}

/** What a canvas with no meta says of itself: nothing chosen, nothing saved, nothing edited. */
const NO_META: CanvasMeta = { arrange: false, name: null, edited: false, project: null };

/**
 * The canvas `canvas`'s state at revision `rev` of its topic, from its entities: its document as
 * fromRows reads its rows. Throws, naming the row, for entities that hold no canvas (fromRows).
 */
export function canvasStateOf(canvas: CanvasId, rev: number, entities: Entities): CanvasState {
  const { nodes, links } = fromRows(canvas, entities);
  const meta = entities[META] as MetaEntity | undefined;
  const { arrange, name, edited, project } = meta ?? NO_META;
  return {
    canvas,
    rev,
    arrange,
    name,
    edited,
    project,
    nodes,
    links,
    entities: Object.fromEntries(
      Object.entries(entities).map(([key, { rev: at, by }]) => [key, { rev: at, by }]),
    ),
  };
}
