import { randomUUID } from 'node:crypto';

import { adapterIn } from '../../../shared/adapter';
import { AgentId, NodeId } from '../../../shared/api/ids';
import { MAX_MESSAGE_BYTES, MAX_OP_NODES } from '../../../shared/api/limits';
import { exampleOf } from '../../../shared/examples';
import { fromFile } from '../../../shared/model/file';
import { insert } from '../../../shared/model/insert';
import { arrange } from '../../../shared/model/layout';
import type { CanvasDocument } from '../../../shared/model/canvas';
import type { QueueItem } from '../../../shared/model/queue';
import { fillTemplate, withAgents, withConnections } from '../../../shared/model/templates';
import type { CanvasId } from '../../../shared/canvas';
import { OpFailure } from '../call';
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
        const example = exampleOf(template);
        if (!example) throw new OpFailure('not-found', `There is no shipped template ${template}.`);
        const fields = new Set(example.fields?.map((field) => field.key) ?? []);
        for (const key of Object.keys(values))
          if (!fields.has(key))
            throw new OpFailure('invalid', `That template has no field ${key}.`);
        const source = fromFile(example.text, catalog, defaultAdapter);
        if (source.nodes.length + 1 > MAX_OP_NODES)
          throw new OpFailure('invalid', 'That template has too many nodes.');
        const roles = new Set(
          source.nodes.filter((node) => node.type === 'agent').map((node) => node.id),
        );
        for (const role of new Set([...Object.keys(agents), ...Object.keys(connections)])) {
          if (!roles.has(role))
            throw new OpFailure('not-found', `That template has no agent role ${role}.`);
        }
        for (const adapter of Object.values(agents))
          if (adapter !== null && !adapterIn(catalog, adapter))
            throw new OpFailure('invalid', `There is no adapter ${adapter}.`);
        const typed = withAgents(
          source,
          Object.fromEntries(
            Object.entries(agents).map(([id, adapter]) => [id, adapter ?? undefined]),
          ),
          context,
        );
        for (const [id, connection] of Object.entries(connections)) {
          const node = typed.nodes.find((node) => node.id === id);
          const adapter =
            node?.type === 'agent' ? (node.data.adapter ?? defaultAdapter) : defaultAdapter;
          if (!adapterIn(catalog, adapter)?.connections.some((one) => one.id === connection))
            throw new OpFailure('invalid', `${adapter} has no connection ${connection} for ${id}.`);
        }
        let part: CanvasDocument;
        try {
          part = fillTemplate(withConnections(typed, connections, context), values, ctx.by);
        } catch (error) {
          throw new OpFailure('invalid', error instanceof Error ? error.message : String(error));
        }
        for (const node of part.nodes)
          if (node.type === 'agent') boundedText(node.data.queue ?? []);
        const into = parent ?? (ctx.caller.kind === 'agent' ? ctx.caller.agent : undefined);
        if (into !== undefined && !doc.nodes.some((node) => node.id === into))
          throw new OpFailure('not-found', `There is no node ${into}.`);
        const built = insert(
          doc,
          part,
          { name: example.name, ...(into === undefined ? {} : { parent: into }) },
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

/** Substitution may repeat a value, or add a template's words around it: bound the final text. */
function boundedText(items: readonly QueueItem[]): void {
  for (const item of items) {
    const texts =
      'message' in item
        ? [item.message]
        : 'instruction' in item
          ? [item.instruction ?? '']
          : 'approve' in item
            ? [item.approve]
            : 'if' in item && 'text' in item.if
              ? [item.if.text]
              : 'repeat' in item && 'text' in item.until
                ? [item.until.text]
                : [];
    if (texts.some((text) => Buffer.byteLength(text, 'utf8') > MAX_MESSAGE_BYTES))
      throw new OpFailure(
        'invalid',
        `Filled text in ${item.id} exceeds ${String(MAX_MESSAGE_BYTES)} bytes.`,
      );
    if ('then' in item) boundedText(item.then);
    if ('repeat' in item) boundedText(item.repeat);
  }
}
