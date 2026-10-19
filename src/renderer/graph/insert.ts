import { insert } from '../../shared/model/insert';
import { documentOf, editGraph } from './graph';
import type { Graph } from './graph';

/** Inserts through the model, applying its selection hint to the view. */
export function insertGraph(
  graph: Graph,
  part: Graph,
  { group, name, newId }: { group: string; name: string; newId: () => string },
): Graph {
  let first = true;
  return editGraph(
    graph,
    (doc, context) => insert(doc, documentOf(part, doc.id), { name }, context),
    {
      newId: () => {
        const id = first ? group : newId();
        first = false;
        return id;
      },
    },
  );
}
