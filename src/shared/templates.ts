import type { AdapterId, Catalog, Job } from './adapter';
import { fromFile } from './model/file';
import { isIf, isRepeat } from './model/queue';
import type { QueueItem } from './model/queue';

export { fillTemplate, placeholdersOf } from './model/templates';

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
