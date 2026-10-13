import type { Graph } from './graph';
import { isIf, isMessage, isWait } from './queue';
import type { Condition, QueueItem, QueueMessage, QueueStep } from './queue';

/**
 * A blank in a template, written `{{key}}` in its agents' names, messages and conditions: what the
 * gallery asks for (`label`) before it opens the canvas, starting from the template's own example.
 */
export interface TemplateField {
  key: string;
  label: string;
  example: string;
}

const PLACEHOLDER = /\{\{(\w+)\}\}/g;

/** Every piece of text in a canvas that a placeholder may be in. */
function textsOf(graph: Graph): string[] {
  const ofCondition = (condition: Condition) => ('text' in condition ? [condition.text] : []);
  const ofItem = (item: QueueItem): string[] =>
    isWait(item)
      ? []
      : isIf(item)
        ? [...ofCondition(item.if), ...item.then.flatMap(ofItem)]
        : isMessage(item)
          ? [item.message]
          : [];
  return graph.nodes.flatMap((n) => [n.data.label, ...(n.data.queue ?? []).flatMap(ofItem)]);
}

/** The placeholders a canvas uses, by key, in the order they first appear. */
export function placeholdersOf(graph: Graph): string[] {
  const keys = textsOf(graph).flatMap((text) => [...text.matchAll(PLACEHOLDER)].map((m) => m[1]));
  return [...new Set(keys.filter((key) => key !== undefined))];
}

/** A canvas with its placeholders filled from `values`; those without a value stay as they are. */
export function fillTemplate(graph: Graph, values: Readonly<Record<string, string>>): Graph {
  const fill = (text: string) =>
    text.replace(PLACEHOLDER, (whole, key: string) => values[key] ?? whole);
  const fillCondition = (condition: Condition): Condition =>
    'text' in condition ? { ...condition, text: fill(condition.text) } : condition;
  const fillStep = <T extends QueueStep | QueueMessage>(step: T): T =>
    isMessage(step) ? { ...step, message: fill(step.message) } : step;
  const fillItem = (item: QueueItem): QueueItem =>
    isWait(item)
      ? item
      : isIf(item)
        ? { ...item, if: fillCondition(item.if), then: item.then.map(fillStep) }
        : fillStep(item);
  return {
    ...graph,
    nodes: graph.nodes.map((node) => ({
      ...node,
      data: {
        ...node.data,
        label: fill(node.data.label),
        ...(node.data.queue ? { queue: node.data.queue.map(fillItem) } : {}),
      },
    })),
  };
}
