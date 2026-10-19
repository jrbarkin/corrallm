import { installedClis } from '../../sessions/installed';
import type { Implementations, OpServices } from '.';

/** The catalog (Core Server §4 A). */
export function catalogOps({
  catalog,
  environment,
}: OpServices): Pick<Implementations, 'catalog.get' | 'catalog.installed'> {
  return {
    'catalog.get': () => catalog,
    'catalog.installed': async () => installedClis(await environment()),
  };
}
