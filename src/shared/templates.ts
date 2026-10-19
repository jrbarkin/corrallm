import type { AdapterId, Catalog, Job } from './adapter';
import type { AgentData } from './model/canvas';
import { fromFile } from './model/file';
import { isApproval, isDelay, isIf, isMessage, isRepeat, isWait } from './model/queue';
import type { Condition, QueueItem, RepeatedItem, Until } from './model/queue';
import { parseRole } from './role';

/** A template blank and the words and starting text its form shows. */
export interface TemplateField {
  key: string;
  label: string;
  example: string;
}

/** A shipped canvas file, with the words and blanks the gallery asks about before opening it. */
export interface Example {
  name: string;
  description: string;
  text: string;
  fields?: readonly TemplateField[];
}

/** A template's role, open to the default adapter unless it names one. */
export interface TemplateAgent {
  id: string;
  name: string;
  adapter?: AdapterId;
  jobs: Job[];
}

/** What the gallery and callers learn before choosing how to use a shipped template. */
export interface TemplateInfo {
  id: string;
  name: string;
  description: string;
  fields: TemplateField[];
  agents: TemplateAgent[];
}

/** The text a model or a view's nodes keep, without depending on how either draws them. */
interface TemplateCanvas {
  nodes: readonly { type?: 'agent' | 'frame'; data: AgentData }[];
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

/** A canvas with its blanks filled; those without a value stay as they are. */
export function fillTemplate<C extends TemplateCanvas>(
  canvas: C,
  values: Readonly<Record<string, string>>,
): C {
  const fill = (text: string) =>
    text.replace(PLACEHOLDER, (whole, key: string) => values[key] ?? whole);
  const condition = <T extends Condition | Until>(value: T): T =>
    'text' in value ? { ...value, text: fill(value.text) } : value;
  const step = <T extends RepeatedItem>(item: T): T =>
    isMessage(item)
      ? { ...item, message: fill(item.message) }
      : 'action' in item && item.instruction !== undefined
        ? { ...item, instruction: fill(item.instruction) }
        : item;
  const item = (value: QueueItem): QueueItem =>
    isWait(value) || isDelay(value)
      ? value
      : isApproval(value)
        ? { ...value, approve: fill(value.approve) }
        : isIf(value)
          ? { ...value, if: condition(value.if), then: value.then.map(step) }
          : isRepeat(value)
            ? { ...value, repeat: value.repeat.map(step), until: condition(value.until) }
            : step(value);
  return {
    ...canvas,
    nodes: canvas.nodes.map((node) => {
      const data = {
        ...node.data,
        label: fill(node.data.label),
        ...(node.data.queue ? { queue: node.data.queue.map(item) } : {}),
      };
      if (node.type === 'agent' && node.data.role !== undefined) {
        const role = parseRole(fill(node.data.role));
        if (role === undefined) delete data.role;
        else data.role = role;
      }
      return { ...node, data };
    }),
  };
}

/** A shipped template's blanks and roles, including the jobs needed inside Ifs and repeats. */
export function templateInfo(
  example: Example,
  catalog: Catalog,
  defaultAdapter: AdapterId,
): TemplateInfo {
  const canvas = fromFile(example.text, catalog, defaultAdapter);
  const actions = catalog.adapters.flatMap((adapter) => adapter.actions);
  const jobs = (items: readonly QueueItem[]): Job[] => [
    ...new Set(
      items.flatMap((item): Job[] => {
        if (isIf(item)) return jobs(item.then);
        if (isRepeat(item)) return jobs(item.repeat);
        if (!('action' in item)) return [];
        const job = actions.find((action) => action.name === item.action)?.job;
        return job === undefined ? [] : [job];
      }),
    ),
  ];
  return {
    id: canvas.id,
    name: example.name,
    description: example.description,
    fields: [...(example.fields ?? [])],
    agents: canvas.nodes.flatMap((node): TemplateAgent[] =>
      node.type !== 'agent'
        ? []
        : [
            {
              id: node.id,
              name: node.data.label,
              ...(node.data.adapter === undefined ? {} : { adapter: node.data.adapter }),
              jobs: jobs(node.data.queue ?? []),
            },
          ],
    ),
  };
}
