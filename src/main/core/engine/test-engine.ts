import type { Catalog } from '../../../shared/adapter';
import testCatalog from '../../../shared/test-catalog.json';
import { engineCatalog } from '../../../shared/model/catalog';

/*
 * For tests: the catalog main declares, as the app loads it (a copy, kept to main's by
 * src/main/sessions/adapters.test.ts), and the engine's lookups in it as the app gives them, an
 * agent naming no adapter running the agent a new node starts with.
 */

export const TEST_CATALOG = testCatalog as Catalog;

export const TEST_ENGINE = engineCatalog(TEST_CATALOG, 'claude-code');
