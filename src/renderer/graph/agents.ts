import { adapterIn, connectionIn } from '../../shared/adapter';
import type { AdapterId, ConnectionId } from '../../shared/adapter';
import { catalog } from '../catalog';
import { engineCatalog } from '../../shared/model/catalog';
import type { EngineCatalog } from '../../shared/model/catalog';

/** Display names, connection words and actions come from the loaded catalog. */
export type { AdapterId };

/**
 * The adapter a new node starts with, and one naming none runs: main's DEFAULT_ADAPTER, which the
 * core runs such a node with, is the same (both pinned by their tests) until B12 makes it the user's.
 */
export const DEFAULT_AGENT: AdapterId = 'claude-code';

/**
 * What the run, and the sessions it sends to, read of each agent's adapter
 * (src/shared/model/catalog.ts): the catalog main declares, a node naming no adapter running
 * DEFAULT_AGENT.
 */
export function runCatalog(): EngineCatalog {
  return engineCatalog(catalog(), DEFAULT_AGENT);
}

/** Catalog selectors are evaluated when a view renders, after boot has loaded the catalog. */
export function adapterName(adapter: AdapterId): string {
  return adapterIn(catalog(), adapter)?.name ?? adapter;
}

export const adapterCli = adapterName;
export type AgentConnection = ConnectionId;

export function connectionsOf(adapter: AdapterId): readonly ConnectionId[] {
  return adapterIn(catalog(), adapter)?.connections.map(({ id }) => id) ?? [];
}

export function connectedAgents(): readonly AdapterId[] {
  return catalog().adapters.map(({ id }) => id);
}

/** How a connection is named (`short`: on an agent's card) and explained. */
export interface ConnectionInfo {
  label: string;
  short: string;
  description: string;
}

const NOT_CONNECTED: ConnectionInfo = {
  label: 'Not connected',
  short: 'Not connected',
  description: 'This agent has no connector in this build. Choose another agent in its settings.',
};

/** How a connection is named and explained: Not connected, for one this build lacks. */
export function connectionInfo(connection: AgentConnection): ConnectionInfo {
  const found = connectionIn(catalog(), connection)?.connection;
  return found
    ? { label: found.label, short: found.short, description: found.description }
    : NOT_CONNECTED;
}

/** An adapter's first connection: what a new agent runs as; unavailable, for an unknown adapter. */
export function defaultConnection(adapter: AdapterId): AgentConnection {
  return connectionsOf(adapter)[0] ?? 'unavailable';
}

/**
 * How an agent runs: its connection; its adapter's first, when it names none; unavailable when it
 * names one its adapter doesn't offer, or its adapter is one this build lacks.
 */
export function connectionOf(data: {
  adapter?: AdapterId;
  connection?: ConnectionId;
}): AgentConnection {
  const adapter = data.adapter ?? DEFAULT_AGENT;
  if (data.connection === undefined) return defaultConnection(adapter);
  return connectionsOf(adapter).includes(data.connection) ? data.connection : 'unavailable';
}

/** An agent's adapter and real connection, or its unavailable connector status. */
export function agentLabel(
  adapter: AdapterId,
  connection: AgentConnection,
  { short = false }: { short?: boolean } = {},
): string {
  const info = connectionInfo(connection);
  return `${adapterName(adapter)} · ${short ? info.short : info.label}`;
}

/** Something an agent can be asked to do: a built-in tool or command, named as its docs name it. */
export interface AgentAction {
  name: string;
  description: string;
}

/** An adapter's declared actions, or none for an adapter this build lacks. */
export function actionsOf(adapter: AdapterId): readonly AgentAction[] {
  return (
    adapterIn(catalog(), adapter)?.actions.map(({ name, description }) => ({
      name,
      description,
    })) ?? []
  );
}
