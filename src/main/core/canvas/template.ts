import { adapterIn } from '../../../shared/adapter';
import type { AdapterId, Catalog } from '../../../shared/adapter';
import { MAX_MESSAGE_BYTES } from '../../../shared/api/limits';
import { exampleOf } from '../../../shared/examples';
import type { CanvasDocument } from '../../../shared/model/canvas';
import { fromFile } from '../../../shared/model/file';
import type { PartyId } from '../../../shared/model/messages';
import type { QueueItem, RepeatedItem } from '../../../shared/model/queue';
import { fillTemplate, withAgents, withConnections } from '../../../shared/model/templates';
import { OpFailure } from '../call';

/*
 * A shipped template filled for a call (Core Server §4 B, B9 Design §1): the one fill behind
 * canvas.create (a new canvas's document) and canvas.insertTemplate (a group inserted in one). Its
 * agents are given the adapters the call chose (steps translated by their jobs) and the connections
 * it chose, else each adapter's first, then its blanks are filled with the call's values. The text
 * a party other than you filled in is marked as that party's (R34's `by`: provenance, never
 * authority), as text a token writes with queue.add is; what you fill in is no one's
 * (`fillTemplate`'s one rule).
 */

/**
 * What a call chose of a template: which, its blanks' values, its agents' adapters (null: the
 * default adapter) and connections, each agent by its id in the template.
 */
export interface TemplateChoice {
  template: string;
  values?: Readonly<Record<string, string>>;
  agents?: Readonly<Record<string, string | null>>;
  connections?: Readonly<Record<string, string>>;
}

/**
 * Template `choice.template`, filled by `by`, under the template's own ids (canvas.create gives it
 * the new canvas's id; canvas.insertTemplate new ids of its own), with its name. Throws not-found
 * for a template there isn't, and invalid for a field or an agent the template lacks, an adapter
 * the catalog lacks, a connection the agent's adapter doesn't offer, or a text filled past
 * MAX_MESSAGE_BYTES (or a role past its bound).
 */
export function filledTemplate(
  { template, values = {}, agents = {}, connections = {} }: TemplateChoice,
  by: PartyId,
  context: { catalog: Catalog; defaultAdapter: AdapterId },
): { name: string; document: CanvasDocument } {
  const example = exampleOf(template);
  if (example === undefined) {
    throw new OpFailure(
      'not-found',
      `There is no template ${template}: templates.list says which there are.`,
    );
  }
  const fields = new Set(example.fields?.map(({ key }) => key) ?? []);
  for (const key of Object.keys(values)) {
    if (!fields.has(key)) {
      throw new OpFailure('invalid', `${example.name} has no field ${key} (values).`);
    }
  }
  const shipped = fromFile(example.text, context.catalog, context.defaultAdapter);
  const roles = new Set(shipped.nodes.flatMap((node) => (node.type === 'agent' ? [node.id] : [])));
  for (const [what, chosen] of [
    ['agents', agents],
    ['connections', connections],
  ] as const) {
    for (const role of Object.keys(chosen)) {
      if (!roles.has(role)) {
        throw new OpFailure('invalid', `${example.name} has no agent ${role} (${what}).`);
      }
    }
  }
  for (const [role, adapter] of Object.entries(agents)) {
    if (adapter !== null && adapterIn(context.catalog, adapter) === undefined) {
      throw new OpFailure('invalid', `There is no adapter ${adapter} (agents.${role}).`);
    }
  }
  const typed = withAgents(
    shipped,
    Object.fromEntries(
      Object.entries(agents).map(([role, adapter]) => [role, adapter ?? undefined]),
    ),
    context,
  );
  for (const [role, connection] of Object.entries(connections)) {
    const node = typed.nodes.find((one) => one.id === role);
    const adapter =
      (node?.type === 'agent' ? node.data.adapter : undefined) ?? context.defaultAdapter;
    if (!adapterIn(context.catalog, adapter)?.connections.some(({ id }) => id === connection)) {
      throw new OpFailure(
        'invalid',
        `${adapter} has no connection ${connection} (connections.${role}).`,
      );
    }
  }
  let document: CanvasDocument;
  try {
    document = fillTemplate(withConnections(typed, connections, context), values, by);
  } catch (error) {
    // A role filled past what a role holds.
    throw new OpFailure('invalid', error instanceof Error ? error.message : String(error));
  }
  for (const node of document.nodes) if (node.type === 'agent') bounded(node.data.queue ?? []);
  return { name: example.name, document };
}

/** A value may be filled in more than once, or among a template's own words: bounds what it made. */
function bounded(items: readonly (QueueItem | RepeatedItem)[]): void {
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
    if (texts.some((text) => Buffer.byteLength(text, 'utf8') > MAX_MESSAGE_BYTES)) {
      throw new OpFailure(
        'invalid',
        `Filled text in ${item.id} exceeds ${String(MAX_MESSAGE_BYTES)} bytes.`,
      );
    }
    if ('then' in item) bounded(item.then);
    if ('repeat' in item) bounded(item.repeat);
  }
}
