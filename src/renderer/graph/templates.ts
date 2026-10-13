import { AGENT_ACTIONS, DEFAULT_AGENT, equivalentAction } from './agents';
import type { AgentType } from './agents';
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

/**
 * A template's agents given their types (`types`, by agent id; undefined leaves an agent open, to
 * be the default agent). A step whose action the new type lacks becomes the action that does the
 * same job in it, if there is one (agents.ts); otherwise it stays, for the user to change. Agents
 * not in `types` keep theirs.
 */
export function withAgents(
  graph: Graph,
  types: Readonly<Record<string, AgentType | undefined>>,
): Graph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      if (node.type !== 'agent' || !(node.id in types)) return node;
      const was = node.data.agent ?? DEFAULT_AGENT;
      const type = types[node.id];
      const now = type ?? DEFAULT_AGENT;
      const has = new Set(AGENT_ACTIONS[now].map((a) => a.name));
      const translate = <T extends QueueStep | QueueMessage>(step: T): T =>
        isMessage(step) || has.has(step.action)
          ? step
          : { ...step, action: equivalentAction(step.action, was, now) ?? step.action };
      const queue = node.data.queue?.map((item): QueueItem =>
        isWait(item)
          ? item
          : isIf(item)
            ? { ...item, then: item.then.map(translate) }
            : translate(item),
      );
      const data = { ...node.data, ...(queue ? { queue } : {}) };
      if (type === undefined) delete data.agent;
      else data.agent = type;
      return { ...node, data };
    }),
  };
}
