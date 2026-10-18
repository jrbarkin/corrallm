import type { AdapterId, Catalog } from '../../shared/adapter';
import type { Adapter } from './adapter';
import { claudeCode } from './claude-code/adapter';
import { codex } from './codex/adapter';

/** Every adapter corrallm runs: the only list of them, and the only file that imports them. */
export const ADAPTERS: readonly Adapter[] = [claudeCode, codex];

/**
 * The catalog of `adapters`: their descriptors, sorted by name (no adapter comes first for being
 * listed first), and the usage backends their connections spend.
 */
export function catalogOf(adapters: readonly Adapter[]): Catalog {
  return {
    adapters: adapters
      .map((adapter) => adapter.descriptor)
      .sort((a, b) => a.name.localeCompare(b.name, 'en')),
    usageBackends: adapters.flatMap((adapter) => adapter.usageBackends),
  };
}

/** The catalog every process reads (catalog:get). */
export const CATALOG: Catalog = catalogOf(ADAPTERS);

/**
 * The adapter an agent naming none runs (as a template may leave it), as in the app (the
 * renderer's DEFAULT_AGENT), until the user chooses their own (Build Plan B12).
 */
export const DEFAULT_ADAPTER: AdapterId = claudeCode.descriptor.id;
