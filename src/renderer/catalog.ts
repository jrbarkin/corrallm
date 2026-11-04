import { adapterIn, connectionIn } from '../shared/adapter';
import type { AdapterId, Catalog, ConnectionId } from '../shared/adapter';

/*
 * The catalog: what every adapter declares (src/shared/adapter.ts), as the core gives it
 * (catalog.get). The renderer loads it once, before the app mounts (boot.ts), so that whatever the
 * app shows reads it at once.
 */

let loaded: Catalog | undefined;

/** Loads the catalog from the core (`get`: its catalog.get). */
export async function loadCatalog(get: () => Promise<Catalog>): Promise<Catalog> {
  loaded = await get();
  return loaded;
}

/** The catalog the core gave: loaded before the app mounts. */
export function catalog(): Catalog {
  if (loaded === undefined) throw new Error('The catalog is not loaded yet.');
  return loaded;
}

/** The owner of a known connection; none for an unchosen or unavailable endpoint. */
export function adapterOf(connection: ConnectionId | undefined): AdapterId | undefined {
  return connectionIn(catalog(), connection)?.adapter.id;
}

/** The connection that continues a connection's conversation for what it can't do, if any. */
export function continuesIn(connection: ConnectionId | undefined): ConnectionId | undefined {
  const target = connectionIn(catalog(), connection)?.connection.continueIn?.connection;
  // A target this build's catalog lacks offers nothing.
  return target !== undefined && connectionIn(catalog(), target) !== undefined ? target : undefined;
}

/** Whether a connection's agent view is its CLI's own terminal (else corrallm's transcript). */
export function isTerminal(connection: ConnectionId | undefined): boolean {
  if (connection === undefined) return false;
  return connectionIn(catalog(), connection)?.connection.view === 'terminal';
}

/** A fixed palette index; an unknown or out-of-range accent uses the first colour. */
export function adapterAccent(adapter: AdapterId | undefined): number {
  const accent = adapterIn(catalog(), adapter)?.accent;
  return accent === 1 ? 1 : 0;
}
