import type { InstalledClis } from '../../shared/session';
import { ADAPTERS } from './adapters';

/** Which catalog adapters' executables are found in the agents' environment. Runs none of them. */
export async function installedClis(env: Readonly<Record<string, string>>): Promise<InstalledClis> {
  return Object.fromEntries(
    await Promise.all(
      ADAPTERS.map(
        async (adapter) =>
          [adapter.descriptor.id, (await adapter.find?.(env)) !== undefined] as const,
      ),
    ),
  );
}
