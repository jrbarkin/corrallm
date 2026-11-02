import { adapterIn, connectionIn } from '../src/shared/adapter';
import type { AdapterId, Catalog, ConnectionId } from '../src/shared/adapter';
import fixture from '../src/shared/test-catalog.json' with { type: 'json' };

// The adapter contract snapshot, kept equal to the catalog the built app serves.
const catalog = fixture as Catalog;

export function adapterName(id: AdapterId): string {
  const adapter = adapterIn(catalog, id);
  if (!adapter) throw new Error(`The test catalog has no adapter ${id}.`);
  return adapter.name;
}

function connectionName(id: ConnectionId, short = false): string {
  const found = connectionIn(catalog, id);
  if (!found) throw new Error(`The test catalog has no connection ${id}.`);
  return `${found.adapter.name} · ${short ? found.connection.short : found.connection.label}`;
}

export function agentChipName(connection: ConnectionId): string {
  return `Agent: ${connectionName(connection)}`;
}

export function agentCardName(name: string, connection: ConnectionId): string {
  return `${name}, ${connectionName(connection, true)}`;
}

/** The option's accessible name also contains its description after the complete label. */
export function connectionOptionName(connection: ConnectionId): RegExp {
  return new RegExp(`^${connectionName(connection).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
}

export function connectionLabel(id: ConnectionId): string {
  const found = connectionIn(catalog, id);
  if (!found) throw new Error(`The test catalog has no connection ${id}.`);
  return found.connection.label;
}

/** The native action an adapter does a template job with, as its queue item names it. */
export function jobActionName(id: AdapterId, job: string): string {
  const action = adapterIn(catalog, id)?.actions.find((action) => action.job === job);
  if (!action) throw new Error(`The test catalog's ${id} has no action for the ${job} job.`);
  return action.name;
}
