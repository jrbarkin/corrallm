import { randomUUID } from 'node:crypto';

import { AgentId, NodeId } from '../../../shared/api/ids';
import { MAX_OP_NODES } from '../../../shared/api/limits';
import { agentOf } from '../../../shared/model/messages';
import { insert } from '../../../shared/model/insert';
import { arrange } from '../../../shared/model/layout';
import type { CanvasId } from '../../../shared/canvas';
import { OpFailure } from '../call';
import { filledTemplate } from '../canvas/template';
import type { Implementations, OpServices } from '.';

/** Template insertion and the saved layout preference, each one pure document build. */
export function canvasToolsOps({
  catalog,
  defaultAdapter,
  states,
}: Pick<OpServices, 'catalog' | 'defaultAdapter' | 'states'>): Pick<
  Implementations,
  'canvas.insertTemplate' | 'canvas.setArrange'
> {
  const context = { catalog, defaultAdapter };
  function ready(canvas: string | undefined): void {
    if (canvas === undefined) throw new OpFailure('unavailable', 'No canvas is open in corrallm.');
    if (!states.keeps(canvas as CanvasId))
      throw new OpFailure('not-found', `There is no canvas ${canvas}.`);
  }
  return {
    'canvas.setArrange': ({ canvas, on }, ctx) => {
      ready(canvas);
      return ctx.commit(canvas, (doc) => ({
        next:
          on === doc.arrange
            ? doc
            : on
              ? arrange({ ...doc, arrange: true })
              : { ...doc, arrange: false },
        result: {},
      }));
    },
    'canvas.insertTemplate': ({ canvas, template, values, agents, connections, parent }, ctx) => {
      ready(canvas);
      return ctx.commit(canvas, (doc) => {
        // The one fill, canvas.create's too: the text a party other than you filled in is its.
        const { name, document: part } = filledTemplate(
          { template, values, agents, connections },
          ctx.proposedBy ?? ctx.by,
          context,
        );
        if (part.nodes.length + 1 > MAX_OP_NODES)
          throw new OpFailure('invalid', 'That template has too many nodes.');
        const into = parent ?? agentOf(ctx.proposedBy ?? ctx.by);
        if (into !== undefined && !doc.nodes.some((node) => node.id === into))
          throw new OpFailure('not-found', `There is no node ${into}.`);
        const built = insert(
          doc,
          part,
          { name, ...(into === undefined ? {} : { parent: into }) },
          { newId: randomUUID },
        );
        const previous = new Set(doc.nodes.map((node) => node.id));
        const added = built.next.nodes.filter(
          (node) => node.type === 'agent' && !previous.has(node.id),
        );
        return {
          next: built.next.arrange ? arrange(built.next) : built.next,
          result: {
            group: NodeId.parse(built.result.id),
            agents: added.map((node) => AgentId.parse(node.id)),
          },
        };
      });
    },
  };
}
