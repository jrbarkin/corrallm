import { afterEach } from 'vitest';

import type { Catalog } from '../shared/adapter';
import { catalog, loadCatalog } from './catalog';

const restores: (() => Promise<Catalog>)[] = [];

/** Replace the loaded catalog for a case; cleanup restores replacements in reverse order. */
export async function useCatalog(next: Catalog): Promise<() => Promise<Catalog>> {
  const previous = catalog();
  let restored = false;
  const restore = () => {
    if (restored) return Promise.resolve(catalog());
    restored = true;
    return loadCatalog(() => Promise.resolve(previous));
  };
  restores.push(restore);
  await loadCatalog(() => Promise.resolve(next));
  return restore;
}

afterEach(async () => {
  for (const restore of restores.splice(0).reverse()) await restore();
});
