import { connectionIn } from '../shared/adapter';
import type { AdapterId, Catalog, ConnectionId } from '../shared/adapter';

/*
 * The catalog: what every adapter declares (src/shared/adapter.ts), as main gives it
 * (catalog:get). The renderer loads it once, before the app mounts (boot.ts), so that whatever the
 * app shows reads it at once.
 */

let loaded: Catalog | undefined;

/** Loads the catalog from main (`get`: its catalog:get). */
export async function loadCatalog(get: () => Promise<Catalog>): Promise<Catalog> {
  loaded = await get();
  return loaded;
}

/** The catalog main gave: loaded before the app mounts. */
export function catalog(): Catalog {
  if (loaded === undefined) throw new Error('The catalog is not loaded yet.');
  return loaded;
}

/** The adapter a connection runs, or 'unavailable' for one the catalog lacks (or 'unavailable'). */
export function adapterOf(connection: ConnectionId): AdapterId {
  if (connection === 'unavailable') return 'unavailable';
  return connectionIn(catalog(), connection)?.adapter.id ?? 'unavailable';
}

/** The connection that continues a connection's conversation for what it can't do, if any. */
export function continuesIn(connection: ConnectionId): ConnectionId | undefined {
  if (connection === 'unavailable') return undefined;
  return connectionIn(catalog(), connection)?.connection.continueIn?.connection;
}

/** Whether a connection's agent view is its CLI's own terminal (else corrallm's transcript). */
export function isTerminal(connection: ConnectionId): boolean {
  if (connection === 'unavailable') return false;
  return connectionIn(catalog(), connection)?.connection.view === 'terminal';
}
