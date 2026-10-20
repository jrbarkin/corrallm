import type { CanvasDocument } from '../../../shared/model/canvas';
import { OpFailure } from '../call';
import type { Implementations } from '.';

/**
 * A canvas's structure (Core Server §4 C): each op one commit to the canvas's document, built
 * purely over the live one, keeping every node it doesn't change.
 */
export function canvasOps(): Pick<Implementations, 'canvas.rename'> {
  return {
    'canvas.rename': ({ canvas, node, label }, ctx) =>
      ctx.commit(canvas, (document) => ({ next: renamed(document, node, label), result: {} })),
  };
}

/** `document` with node `id` named `label`: not-found if there is none. */
function renamed(document: CanvasDocument, id: string, label: string): CanvasDocument {
  const node = document.nodes.find((one) => one.id === id);
  if (node === undefined) throw new OpFailure('not-found', `There is no node ${id}.`);
  if (node.data.label === label) return document;
  const named = { ...node, data: { ...node.data, label } };
  return { ...document, nodes: document.nodes.map((one) => (one === node ? named : one)) };
}
