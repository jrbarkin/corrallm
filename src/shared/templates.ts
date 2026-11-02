import type { Job } from './adapter';
import { readTemplate } from './model/template-file';
import type { TemplateItem } from './model/template-file';

export { fillTemplate, placeholdersOf } from './model/templates';

/** A template blank and the words and starting text its form shows. */
export interface TemplateField {
  key: string;
  label: string;
  example: string;
}

/** A shipped template definition, with the words and blanks the gallery asks about before opening it. */
export interface Example {
  name: string;
  description: string;
  text: string;
  fields?: readonly TemplateField[];
}

/** A template's role; every adapter is explicitly chosen when it is used. */
export interface TemplateAgent {
  id: string;
  name: string;
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
export function templateInfo(example: Example): TemplateInfo {
  const template = readTemplate(example.text);
  const jobs = new Map<string, Set<Job>>();
  const visit = (items: readonly TemplateItem[], owner: string): void => {
    for (const item of items) {
      if ('then' in item) visit(item.then, owner);
      else if ('repeat' in item) visit(item.repeat, owner);
      else if ('job' in item) {
        const recipient = item.target ?? owner;
        let set = jobs.get(recipient);
        if (!set) {
          set = new Set();
          jobs.set(recipient, set);
        }
        set.add(item.job);
      }
    }
  };
  for (const node of template.nodes)
    if (node.type === 'agent') visit(node.data.queue ?? [], node.id);
  return {
    id: template.id,
    name: example.name,
    description: example.description,
    fields: [...(example.fields ?? [])],
    agents: template.nodes.flatMap((node) =>
      node.type !== 'agent'
        ? []
        : [{ id: node.id, name: node.data.label, jobs: [...(jobs.get(node.id) ?? [])] }],
    ),
  };
}
