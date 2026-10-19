import { EXAMPLES } from '../../../shared/examples';
import { templateInfo } from '../../../shared/templates';
import type { Implementations, OpServices } from '.';

/** Shipped templates (Core Server §4 A): no canvas, profile store or native CLI is read. */
export function templatesOps({
  catalog,
  defaultAdapter,
}: OpServices): Pick<Implementations, 'templates.list'> {
  const items = EXAMPLES.map((example) => templateInfo(example, catalog, defaultAdapter));
  return { 'templates.list': () => ({ items }) };
}
