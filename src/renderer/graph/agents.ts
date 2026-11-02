import { adapterIn, connectionIn } from '../../shared/adapter';
import type { AdapterId, ConnectionId } from '../../shared/adapter';
import { catalog } from '../catalog';
import { engineCatalog, agentEndpoint } from '../../shared/model/catalog';
import type { EngineCatalog } from '../../shared/model/catalog';

/** Display names, connection words and actions come from the loaded catalog. */
export type { AdapterId };

/** The loaded catalog supplies the same endpoint lookups as the core. */
export function runCatalog(): EngineCatalog {
  return engineCatalog(catalog());
}

/** The named adapter, or the owner of a known connection, without choosing for an agent. */
export function agentAdapter(data: {
  adapter?: AdapterId;
  connection?: ConnectionId;
}): AdapterId | undefined {
  const endpoint = agentEndpoint(data, catalog());
  return endpoint.kind === 'unchosen' ? undefined : endpoint.adapter;
}

/** Catalog selectors are evaluated when a view renders, after boot has loaded the catalog. */
export function adapterName(adapter: AdapterId | undefined): string {
  return adapterIn(catalog(), adapter)?.name ?? adapter ?? 'Choose an agent';
}

export const adapterCli = adapterName;
export type AgentConnection = ConnectionId;

export function connectionsOf(adapter: AdapterId | undefined): readonly ConnectionId[] {
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
export function connectionInfo(connection: AgentConnection | undefined): ConnectionInfo {
  const found = connectionIn(catalog(), connection)?.connection;
  return found
    ? { label: found.label, short: found.short, description: found.description }
    : NOT_CONNECTED;
}

/** An adapter's first connection: what a new agent runs as; unavailable, for an unknown adapter. */
export function defaultConnection(adapter: AdapterId | undefined): AgentConnection | undefined {
  return connectionsOf(adapter)[0];
}

/**
 * How an agent runs: its connection; its adapter's first, when it names none; unavailable when it
 * names one its adapter doesn't offer, or its adapter is one this build lacks.
 */
export function connectionOf(data: {
  adapter?: AdapterId;
  connection?: ConnectionId;
}): AgentConnection | undefined {
  const endpoint = agentEndpoint(data, catalog());
  return endpoint.kind === 'known' ? endpoint.connection : undefined;
}

/** An agent's adapter and real connection, or its unavailable connector status. */
export function agentLabel(
  adapter: AdapterId | undefined,
  connection: AgentConnection | undefined,
  { short = false }: { short?: boolean } = {},
): string {
  if (adapter === undefined) return 'Choose an agent';
  const info = connectionInfo(connection);
  return `${adapterName(adapter)} · ${short ? info.short : info.label}`;
}

/** Something an agent can be asked to do: a built-in tool or command, named as its docs name it. */
export interface AgentAction {
  name: string;
  description: string;
}

/** An adapter's declared actions, or none for an adapter this build lacks. */
export function actionsOf(adapter: AdapterId | undefined): readonly AgentAction[] {
  return (
    adapterIn(catalog(), adapter)?.actions.map(({ name, description }) => ({
      name,
      description,
    })) ?? []
  );
}
