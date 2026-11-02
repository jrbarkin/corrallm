import { EXAMPLES } from '../../../shared/examples';
import { templateInfo } from '../../../shared/templates';
import type { Implementations } from '.';

/** Shipped templates (Core Server §4 A): no canvas, profile store or native CLI is read. */
export function templatesOps(): Pick<Implementations, 'templates.list'> {
  const items = EXAMPLES.map((example) => templateInfo(example));
  return { 'templates.list': () => ({ items }) };
}
