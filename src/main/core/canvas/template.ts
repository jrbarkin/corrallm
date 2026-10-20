import { adapterIn } from '../../../shared/adapter';
import type { AdapterId, Catalog } from '../../../shared/adapter';
import type { CanvasId } from '../../../shared/canvas';
import { exampleOf } from '../../../shared/examples';
import type { AgentNode, CanvasDocument, CanvasNode } from '../../../shared/model/canvas';
import { fromFile } from '../../../shared/model/file';
import type { PartyId } from '../../../shared/model/messages';
import { isApproval, isIf, isMessage, isRepeat } from '../../../shared/model/queue';
import type { QueueItem, RepeatedItem } from '../../../shared/model/queue';
import { fillTemplate, withAgents, withConnections } from '../../../shared/model/templates';
import { OpFailure } from '../call';

/*
 * A shipped template as a new canvas's document (canvas.create, Core Server §4 B): its blanks
 * filled with the caller's values, its agents given the adapters it chose (steps translated by
 * their jobs) and the connections it chose, else each adapter's first; under the new canvas's id.
 * The text a party other than you filled in is marked as that party's (R34's `by`: provenance,
 * never authority), as text a token writes with queue.add is; yours is no one's.
 */

/** What a call chose of a template: which, its blanks' values, its agents' adapters and connections. */
export interface TemplateChoice {
  template: string;
  values?: Readonly<Record<string, string>>;
  agents?: Readonly<Record<string, string>>;
  connections?: Readonly<Record<string, string>>;
}

/**
 * Template `choice.template` as canvas `canvas`'s document, made by `by`. Throws not-found for a
 * template there isn't, and invalid for an agent it chose for that the template lacks, an adapter
 * the catalog lacks, or a connection the agent's adapter doesn't offer.
 */
export function templateDocument(
  canvas: CanvasId,
  { template, values = {}, agents = {}, connections = {} }: TemplateChoice,
  by: PartyId,
  context: { catalog: Catalog; defaultAdapter: AdapterId },
): CanvasDocument {
  const example = exampleOf(template);
  if (example === undefined) {
    throw new OpFailure(
      'not-found',
      `There is no template ${template}: templates.list says which there are.`,
    );
  }
  const shipped = fromFile(example.text, context.catalog, context.defaultAdapter);
  const agentIds = new Set(
    shipped.nodes.flatMap((node) => (node.type === 'agent' ? [node.id] : [])),
  );
  for (const [agent, adapter] of Object.entries(agents)) {
    if (!agentIds.has(agent)) {
      throw new OpFailure('invalid', `${example.name} has no agent ${agent} (agents).`);
    }
    if (adapterIn(context.catalog, adapter) === undefined) {
      throw new OpFailure('invalid', `There is no adapter ${adapter} (agents.${agent}).`);
    }
  }
  const filled = authored(shipped, fillTemplate(shipped, values), by);
  const typed = withAgents(filled, agents, context);
  for (const [agent, connection] of Object.entries(connections)) {
    const node = typed.nodes.find(
      (one): one is AgentNode => one.id === agent && one.type === 'agent',
    );
    if (node === undefined) {
      throw new OpFailure('invalid', `${example.name} has no agent ${agent} (connections).`);
    }
    const adapter = node.data.adapter ?? context.defaultAdapter;
    if (!adapterIn(context.catalog, adapter)?.connections.some(({ id }) => id === connection)) {
      throw new OpFailure(
        'invalid',
        `${adapter} has no connection ${connection} (connections.${agent}).`,
      );
    }
  }
  return { ...withConnections(typed, connections, context), id: canvas };
}

/**
 * `filled` (what `fillTemplate` made of `shipped`) with each queue item whose own text the fill
 * changed marked as `by`'s: none for yours.
 */
function authored(shipped: CanvasDocument, filled: CanvasDocument, by: PartyId): CanvasDocument {
  if (by === 'you' || filled === shipped) return filled;
  const nodes = filled.nodes.map((node, i): CanvasNode => {
    const was = shipped.nodes[i];
    if (node === was || node.type !== 'agent' || was?.type !== 'agent') return node;
    const { queue } = node.data;
    if (queue === undefined) return node;
    const stamped = stamp(was.data.queue ?? [], queue, by);
    return stamped.every((item, at) => item === queue[at])
      ? node
      : { ...node, data: { ...node.data, queue: stamped } };
  });
  return { ...filled, nodes };
}

/** `is` with each item whose own text differs from `was`'s marked as `by`'s, at any depth. */
function stamp<T extends QueueItem | RepeatedItem>(
  was: readonly T[],
  is: readonly T[],
  by: PartyId,
): T[] {
  return is.map((item, i) => {
    const old = was[i];
    if (old === undefined || item === old) return item;
    let next: T = textOf(item) === textOf(old) ? item : { ...item, by };
    if (isIf(next) && isIf(old)) next = { ...next, then: stamp(old.then, next.then, by) };
    if (isRepeat(next) && isRepeat(old)) {
      next = { ...next, repeat: stamp(old.repeat, next.repeat, by) };
    }
    return next;
  });
}

/** An item's own text, the text its author wrote: not what it holds. */
function textOf(item: QueueItem | RepeatedItem): string | undefined {
  if (isMessage(item)) return item.message;
  if ('action' in item) return item.instruction;
  if (isApproval(item)) return item.approve;
  if (isIf(item)) return 'text' in item.if ? item.if.text : undefined;
  if (isRepeat(item)) return 'text' in item.until ? item.until.text : undefined;
  return undefined;
}
