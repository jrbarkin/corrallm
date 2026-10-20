import { adapterIn } from '../adapter';
import type { AdapterId, ConnectionId } from '../adapter';
import { parseRole } from '../role';
import type { AgentData } from './canvas';
import type { PartyId } from './messages';
import { translateActions } from './agent-ops';
import type { AgentContext } from './agent-ops';
import { isApproval, isDelay, isIf, isMessage, isRepeat, isWait } from './queue';
import type { Condition, QueueItem, RepeatedItem, Until } from './queue';

/** The text a model or a view's nodes keep, without depending on how either draws them. */
export interface TemplateCanvas {
  nodes: readonly { id: string; type?: 'agent' | 'frame'; data: AgentData }[];
}

const PLACEHOLDER = /\{\{(\w+)\}\}/g;

/** Every piece of text in a canvas that a placeholder may be in. */
function textsOf(canvas: TemplateCanvas): string[] {
  const ofCondition = (condition: Condition | Until) =>
    'text' in condition ? [condition.text] : [];
  const ofItem = (item: QueueItem): string[] =>
    isWait(item) || isDelay(item)
      ? []
      : isApproval(item)
        ? [item.approve]
        : isIf(item)
          ? [...ofCondition(item.if), ...item.then.flatMap(ofItem)]
          : isRepeat(item)
            ? [...item.repeat.flatMap(ofItem), ...ofCondition(item.until)]
            : isMessage(item)
              ? [item.message]
              : [item.instruction ?? ''];
  return canvas.nodes.flatMap((node) => [
    node.data.label,
    ...(node.type === 'agent' && node.data.role !== undefined ? [node.data.role] : []),
    ...(node.data.queue ?? []).flatMap(ofItem),
  ]);
}

/** The blanks a canvas uses, by key, in the order they first appear. */
export function placeholdersOf(canvas: TemplateCanvas): string[] {
  const keys = textsOf(canvas).flatMap((text) =>
    [...text.matchAll(PLACEHOLDER)].map((match) => match[1]),
  );
  return [...new Set(keys.filter((key) => key !== undefined))];
}

/** A canvas with its blanks filled; only text changed by a named caller takes that author. */
export function fillTemplate<C extends TemplateCanvas>(
  canvas: C,
  values: Readonly<Record<string, string>>,
  by?: PartyId,
): C {
  const authored = <T extends QueueItem>(item: T): T => {
    if (by === undefined) return item;
    const next = { ...item };
    if (by === 'you') delete next.by;
    else next.by = by;
    return next;
  };
  const fill = (text: string) =>
    text.replace(PLACEHOLDER, (whole, key: string) => values[key] ?? whole);
  const condition = <T extends Condition | Until>(value: T): T => {
    if (!('text' in value)) return value;
    const text = fill(value.text);
    return text === value.text ? value : { ...value, text };
  };
  const step = <T extends RepeatedItem>(value: T): T => {
    if (isMessage(value)) {
      const message = fill(value.message);
      return message === value.message ? value : authored({ ...value, message });
    }
    if ('action' in value && value.instruction !== undefined) {
      const instruction = fill(value.instruction);
      return instruction === value.instruction ? value : authored({ ...value, instruction });
    }
    return value;
  };
  const item = (value: QueueItem): QueueItem => {
    if (isWait(value) || isDelay(value)) return value;
    if (isApproval(value)) {
      const approve = fill(value.approve);
      return approve === value.approve ? value : authored({ ...value, approve });
    }
    if (isIf(value)) {
      const checked = condition(value.if);
      const then = value.then.map(step);
      return checked === value.if && same(value.then, then)
        ? value
        : checked === value.if
          ? { ...value, then }
          : authored({ ...value, if: checked, then });
    }
    if (isRepeat(value)) {
      const until = condition(value.until);
      const repeat = value.repeat.map(step);
      return until === value.until && same(value.repeat, repeat)
        ? value
        : until === value.until
          ? { ...value, repeat }
          : authored({ ...value, until, repeat });
    }
    return step(value);
  };
  return mapNodes(canvas, (node) => {
    const label = fill(node.data.label);
    const queue = node.data.queue?.map(item);
    const keptQueue =
      queue && node.data.queue && same(queue, node.data.queue) ? node.data.queue : queue;
    const role =
      node.type === 'agent' && node.data.role !== undefined
        ? parseRole(fill(node.data.role))
        : node.data.role;
    if (label === node.data.label && keptQueue === node.data.queue && role === node.data.role)
      return node;
    const data = { ...node.data, label, ...(keptQueue ? { queue: keptQueue } : {}) };
    if (role === undefined) delete data.role;
    else data.role = role;
    return { ...node, data };
  });
}

/** Gives explicit template roles their adapters, translating steps by catalog jobs. */
export function withAgents<C extends TemplateCanvas>(
  canvas: C,
  types: Readonly<Record<string, AdapterId | undefined>>,
  context: AgentContext,
): C {
  return mapNodes(canvas, (node) => {
    if (node.type !== 'agent' || !Object.hasOwn(types, node.id)) return node;
    const adapter = types[node.id];
    const queue =
      node.data.queue &&
      translateActions(
        node.data.queue,
        node.data.adapter ?? context.defaultAdapter,
        adapter ?? context.defaultAdapter,
        context.catalog,
      );
    if (adapter === node.data.adapter && queue === node.data.queue) return node;
    const data = { ...node.data, ...(queue ? { queue } : {}) };
    if (adapter === undefined) delete data.adapter;
    else data.adapter = adapter;
    return { ...node, data };
  });
}

/** Fills native connection choices from the catalog's first; defaults:false applies a partial edit. */
export function withConnections<C extends TemplateCanvas>(
  canvas: C,
  connections: Readonly<Record<string, ConnectionId>>,
  context: AgentContext,
  { defaults = true }: { defaults?: boolean } = {},
): C {
  return mapNodes(canvas, (node) => {
    if (node.type !== 'agent') return node;
    const named = Object.hasOwn(connections, node.id);
    if (!named && !defaults) return node;
    const adapter = adapterIn(context.catalog, node.data.adapter ?? context.defaultAdapter);
    const connection = named ? connections[node.id] : adapter?.connections[0]?.id;
    if (
      connection === undefined ||
      connection === node.data.connection ||
      !adapter?.connections.some((one) => one.id === connection)
    )
      return node;
    return { ...node, data: { ...node.data, connection } };
  });
}

function mapNodes<C extends TemplateCanvas>(
  canvas: C,
  change: (node: C['nodes'][number]) => C['nodes'][number],
): C {
  const nodes = canvas.nodes.map(change);
  return nodes.every((node, i) => node === canvas.nodes[i]) ? canvas : { ...canvas, nodes };
}
function same(a: readonly QueueItem[], b: readonly QueueItem[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}
