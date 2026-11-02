import { adapterIn } from '../adapter';
import type { AdapterId, Catalog } from '../adapter';
import type { Example } from '../templates';
import { compileTemplate } from './templates';
import { readTemplate } from './template-file';

/** Materialize a shipped definition for runtime tests on the adapter the fixture chose. */
export function compileExample(example: Example, catalog: Catalog, adapter: AdapterId) {
  const template = readTemplate(example.text);
  const connection = adapterIn(catalog, adapter)?.connections[0]?.id;
  if (!connection) throw new Error(`No test connection for ${adapter}`);
  return compileTemplate(
    template,
    Object.fromEntries(
      template.nodes.flatMap((node) =>
        node.type === 'agent' ? [[node.id, { adapter, connection }]] : [],
      ),
    ),
    catalog,
  );
}

/** The fake core uses the same explicit choices and compiler as the real boundary. */
export function chooseExample(
  example: Example,
  catalog: Catalog,
  agents: Readonly<Record<string, AdapterId>>,
  connections: Readonly<Record<string, string>>,
) {
  return compileTemplate(
    readTemplate(example.text),
    Object.fromEntries(
      Object.entries(agents).map(([id, adapter]) => {
        const connection = connections[id] ?? adapterIn(catalog, adapter)?.connections[0]?.id;
        if (!connection) throw new Error(`No test connection for ${adapter}`);
        return [id, { adapter, connection }];
      }),
    ),
    catalog,
  );
}
