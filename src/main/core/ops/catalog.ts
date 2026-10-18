import type { Implementations, OpServices } from '.';

/** The catalog (Core Server §4 A). */
export function catalogOps({ catalog }: OpServices): Pick<Implementations, 'catalog.get'> {
  return {
    'catalog.get': () => catalog,
  };
}
