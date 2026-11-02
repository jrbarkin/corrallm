import { exampleOf } from '../../shared/examples';
import { fromFile } from '../../shared/model/file';
import { CATALOG } from '../sessions/adapters';

/** Explicit choices for every role in a test's template creation. */
export function templateAgents(template: string, adapter: string): Record<string, string> {
  const example = exampleOf(template);
  return example === undefined
    ? {}
    : Object.fromEntries(
        fromFile(example.text, CATALOG).nodes.flatMap((node) =>
          node.type === 'agent' ? [[node.id, adapter]] : [],
        ),
      );
}
