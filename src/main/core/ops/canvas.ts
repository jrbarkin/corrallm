import { randomUUID } from 'node:crypto';

import { adapterIn } from '../../../shared/adapter';
import { AgentId, NodeId } from '../../../shared/api/ids';
import type { CanvasDocument, CanvasNode } from '../../../shared/model/canvas';
import * as agents from '../../../shared/model/agent-ops';
import * as structure from '../../../shared/model/structure';
import type { Built, Created, StructureContext } from '../../../shared/model/structure';
import { OpFailure } from '../call';
import type { Implementations, OpServices } from '.';

/** Each structural op builds one pure change over the document ctx.commit supplies. */
export function canvasOps({
  defaultAdapter,
  catalog,
}: Pick<OpServices, 'defaultAdapter' | 'catalog'>): Pick<
  Implementations,
  | 'canvas.rename'
  | 'canvas.addAgent'
  | 'canvas.spawnAgent'
  | 'canvas.delete'
  | 'canvas.link'
  | 'canvas.unlink'
  | 'canvas.group'
  | 'canvas.ungroup'
  | 'canvas.addParent'
  | 'canvas.move'
> {
  const context: StructureContext = { newId: randomUUID, defaultAdapter };
  return {
    'canvas.rename': ({ canvas, node, label }, ctx) =>
      ctx.commit(canvas, (doc) => {
        requireNode(doc, node);
        return { next: structure.rename(doc, { id: node, label }).next, result: {} };
      }),
    'canvas.addAgent': ({ canvas, at, adapter, connection, role }, ctx) =>
      ctx.commit(canvas, (doc) => {
        const descriptor = adapterIn(catalog, adapter);
        if (!descriptor)
          throw new OpFailure('invalid', `There is no adapter ${adapter}.`);
        if (connection !== undefined && !descriptor.connections.some((one) => one.id === connection))
          throw new OpFailure('invalid', `Connection ${connection} does not belong to adapter ${adapter}.`);
        const built = created(structure.addAgent(doc, { at, adapter }, context), AgentId);
        let next = built.next;
        if (connection !== undefined)
          next = agents.setConnection(next, { agent: built.result.id, connection }, { catalog, defaultAdapter }).next;
        if (role === undefined) return { next, result: built.result };
        // Its role as it is made: in the same change, which a token may give it (R12).
        return {
          next: agents.setRole(next, { agent: built.result.id, role }).next,
          result: built.result,
        };
      }),
    'canvas.spawnAgent': ({ canvas, from, relation }, ctx) =>
      ctx.commit(canvas, (doc) => {
        requireNode(doc, from, 'agent');
        const built = created(structure.spawnAgent(doc, { from, relation }, context), AgentId);
        return { ...built, copies: new Map([[built.result.id, from]]) };
      }),
    'canvas.delete': ({ canvas, nodes = [], links = [] }, ctx) =>
      ctx.commit(canvas, (doc) => {
        for (const node of nodes) requireNode(doc, node);
        for (const { a, b } of links) requireLink(doc, a, b);
        return structure.remove(doc, {
          nodes,
          links: links.map(({ a, b }) => ({ source: a, target: b })),
        });
      }),
    'canvas.link': ({ canvas, a, b, source = a, dots }, ctx) =>
      ctx.commit(canvas, (doc) => {
        requireEnds(doc, a, b);
        if (source !== a && source !== b)
          throw new OpFailure('invalid', 'The drawn source must be one of the link’s ends.');
        const { next } = structure.link(doc, {
          source,
          target: source === a ? b : a,
          ...(dots === undefined ? {} : { dots }),
        });
        return { next, result: {} };
      }),
    'canvas.unlink': ({ canvas, a, b }, ctx) =>
      ctx.commit(canvas, (doc) => {
        requireLink(doc, a, b);
        return { next: structure.unlink(doc, { source: a, target: b }).next, result: {} };
      }),
    'canvas.group': ({ canvas, nodes, kind }, ctx) =>
      ctx.commit(canvas, (doc) => {
        for (const node of nodes) requireNode(doc, node);
        if (structure.groupMembers(doc.nodes, nodes).length === 0)
          throw new OpFailure('invalid', 'The nodes must share a container to be grouped.');
        return created(structure.group(doc, { nodes, kind }, context), NodeId);
      }),
    'canvas.ungroup': ({ canvas, nodes }, ctx) =>
      ctx.commit(canvas, (doc) => {
        for (const node of nodes) requireNode(doc, node);
        return { next: structure.ungroup(doc, { nodes }).next, result: {} };
      }),
    'canvas.addParent': ({ canvas, frame }, ctx) =>
      ctx.commit(canvas, (doc) => {
        requireNode(doc, frame, 'frame');
        return created(structure.addParent(doc, { id: frame }, context), AgentId);
      }),
    'canvas.move': ({ canvas, moves }, ctx) =>
      ctx.commit(canvas, (doc) => {
        for (const { node } of moves) requireNode(doc, node);
        return { next: structure.move(doc, { moves }).next, result: {} };
      }),
  };
}

function requireNode(doc: CanvasDocument, id: string, kind?: CanvasNode['type']): CanvasNode {
  const node = doc.nodes.find((one) => one.id === id);
  if (!node) throw new OpFailure('not-found', `There is no node ${id}.`);
  if (kind !== undefined && node.type !== kind)
    throw new OpFailure('invalid', `Node ${id} is ${node.type}, not ${kind}.`);
  return node;
}
function requireEnds(doc: CanvasDocument, a: string, b: string): void {
  requireNode(doc, a, 'agent');
  requireNode(doc, b, 'agent');
  if (a === b) throw new OpFailure('invalid', 'A link must join two distinct agents.');
}
/** Drops the view’s selection hint and returns the appropriate branded node id. */
function created<I extends string>(
  { next, result }: Built<Created>,
  schema: { parse(value: unknown): I },
) {
  if (result.id === undefined) throw new OpFailure('invalid', 'That edit creates no node.');
  return { next, result: { id: schema.parse(result.id) } };
}

function requireLink(doc: CanvasDocument, a: string, b: string): void {
  requireEnds(doc, a, b);
  if (
    !doc.links.some(
      (link) =>
        (link.source === a && link.target === b) || (link.source === b && link.target === a),
    )
  )
    throw new OpFailure('not-found', `There is no link between ${a} and ${b}.`);
}
