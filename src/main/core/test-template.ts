import { exampleOf } from '../../shared/examples';
import { readTemplate } from '../../shared/model/template-file';

/** Explicit choices for every role in a test's template creation. */
export function templateAgents(template: string, adapter: string): Record<string, string> {
  const example = exampleOf(template);
  return example === undefined
    ? {}
    : Object.fromEntries(
        readTemplate(example.text).nodes.flatMap((node) =>
          node.type === 'agent' ? [[node.id, adapter]] : [],
        ),
      );
}
