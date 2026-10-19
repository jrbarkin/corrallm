import type { ReactNode } from 'react';
import type { Root } from 'react-dom/client';

import type { Catalog } from '../shared/adapter';
import { loadCatalog } from './catalog';

/**
 * Mounts the app in `root` once the catalog has loaded (`get`: the core's catalog.get): nothing renders
 * before, so everything the app shows can read it (catalog.ts).
 */
export async function boot(root: Root, get: () => Promise<Catalog>, app: ReactNode): Promise<void> {
  await loadCatalog(get);
  root.render(app);
}
