import { arrange as arrangeDocument } from '../../shared/model/layout';
import { editGraph } from './graph';
import type { Graph } from './graph';

/** The model's layout, keeping the view's measurements and selection. */
export function arrange(graph: Graph): Graph {
  return editGraph(graph, (doc, context) => ({ next: arrangeDocument(doc, context), result: {} }));
}
