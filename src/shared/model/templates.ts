import { adapterIn } from '../adapter';
import type { AdapterId, Catalog, ConnectionId } from '../adapter';
import { parseRole } from '../role';
import type { AgentData, CanvasDocument } from './canvas';
import type { TemplateDocument, TemplateItem, TemplateRepeated } from './template-file';
import type { PartyId } from './messages';
import { isApproval, isDelay, isIf, isMessage, isRepeat, isWait } from './queue';
import type { Condition, QueueItem, QueueStep, QueueMessage, RepeatedItem, Until } from './queue';

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

/** An explicit endpoint for each shipped role. */
export interface RoleChoice {
  adapter: AdapterId;
  connection: ConnectionId;
}
export class TemplateFault extends Error {}

/** Compiles jobs once, using the actual recipient's first declared implementation. */
export function compileTemplate(
  template: TemplateDocument,
  roles: Readonly<Record<string, RoleChoice>>,
  catalog: Catalog,
): CanvasDocument {
  const agents = template.nodes.filter((node) => node.type === 'agent');
  const byId = new Map(agents.map((node) => [node.id, node]));
  for (const id of Object.keys(roles))
    if (!byId.has(id)) throw new TemplateFault(`There is no template role ${id}.`);
  for (const node of agents) {
    const choice = Object.hasOwn(roles, node.id) ? roles[node.id] : undefined;
    if (!choice) throw new TemplateFault(`Choose an endpoint for ${node.data.label} (${node.id}).`);
    const adapter = adapterIn(catalog, choice.adapter);
    if (!adapter?.connections.some((connection) => connection.id === choice.connection))
      throw new TemplateFault(
        `${node.data.label} (${node.id}) has no endpoint ${choice.adapter} / ${choice.connection}.`,
      );
  }
  const step = (item: TemplateRepeated, owner: string): RepeatedItem => {
    if (!('job' in item)) return item;
    const recipient = item.target ?? owner;
    const node = byId.get(recipient);
    const choice = roles[recipient];
    const action =
      choice &&
      adapterIn(catalog, choice.adapter)?.actions.find((action) => action.job === item.job);
    if (!node || !action)
      throw new TemplateFault(
        `${node?.data.label ?? recipient} (${recipient}): step ${item.id} needs job ${item.job}.`,
      );
    return {
      id: item.id,
      action: action.name,
      ...(item.target === undefined ? {} : { target: item.target }),
      ...(item.instruction === undefined ? {} : { instruction: item.instruction }),
      ...(item.expect === undefined ? {} : { expect: item.expect }),
    };
  };
  const item = (value: TemplateItem, owner: string): QueueItem => {
    if ('then' in value)
      return {
        ...value,
        then: value.then.map((value) => step(value, owner) as QueueStep | QueueMessage),
      };
    if ('repeat' in value)
      return { ...value, repeat: value.repeat.map((value) => step(value, owner)) };
    return 'approve' in value ? value : step(value, owner);
  };
  return {
    ...template,
    nodes: template.nodes.map((node) =>
      node.type === 'frame'
        ? node
        : {
            ...node,
            data: {
              label: node.data.label,
              ...(node.data.role === undefined ? {} : { role: node.data.role }),
              ...(node.data.color === undefined ? {} : { color: node.data.color }),
              ...roles[node.id],
              ...(node.data.queue === undefined
                ? {}
                : { queue: node.data.queue.map((value) => item(value, node.id)) }),
            },
          },
    ),
  };
}
