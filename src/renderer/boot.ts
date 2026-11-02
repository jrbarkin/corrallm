import { createElement } from 'react';
import type { ReactNode } from 'react';
import type { Root } from 'react-dom/client';

import type { Catalog } from '../shared/adapter';
import { loadCatalog } from './catalog';
import { CatalogError } from './CatalogError';

/** Only the retry view mounts after a failed catalog read; the app waits for a successful read. */
export async function boot(root: Root, get: () => Promise<Catalog>, app: ReactNode): Promise<void> {
  try {
    await loadCatalog(get);
    root.render(app);
  } catch {
    root.render(createElement(CatalogError, { retry: () => boot(root, get, app) }));
  }
}
