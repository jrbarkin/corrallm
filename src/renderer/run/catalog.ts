import { adapterIn, connectionIn, isStartMode, usageBackendIn } from '../../shared/adapter';
import type {
  AdapterId,
  AgentAction,
  Catalog,
  ConnectionId,
  ModeId,
  UsageBackendId,
} from '../../shared/adapter';

/*
 * What the run, and the sessions it sends to, read of the catalog (src/shared/adapter.ts): an
 * agent's adapter and connection, its actions, the usage backend it spends, the modes a connection
 * starts in, and how a connection and a usage backend are named. Whoever runs them injects it, made
 * from the catalog it loaded, so that they read no table of their own, nor any catalog but this
 * one, and name no adapter: whatever adapters the catalog declares, they run.
 */

/** An agent, as far as the catalog's lookups read it: the adapter it runs, and how. */
interface Runs {
  adapter?: AdapterId;
  connection?: ConnectionId;
}

export interface EngineCatalog {
  /**
   * How an agent runs: its connection; its adapter's first, when it names none (its adapter the
   * default, when it names none); 'unavailable' when it names one its adapter doesn't offer, or
   * its adapter is one the catalog lacks.
   */
  connectionOf(agent: Runs): ConnectionId;
  /** The adapter a connection runs: 'unavailable' for one the catalog lacks (or 'unavailable'). */
  adapterOf(connection: ConnectionId): AdapterId;
  /** What an agent's steps can name, with what each does: none, for an adapter the catalog lacks. */
  actionsOf(agent: Pick<Runs, 'adapter'>): readonly AgentAction[];
  /**
   * The usage backend an agent spends, whose usage rule applies to it: its connection's (none where
   * no reading can see it, as on an API key).
   */
  usageBackendOf(agent: Runs): UsageBackendId | undefined;
  /** How a connection is named ("Terminal"): nothing, for one the catalog lacks. */
  connectionLabel(connection: ConnectionId): string | undefined;
  /**
   * Whether a connection's sessions may start in `mode`: one its adapter lists that asks, among
   * those the connection starts in (never, for a connection the catalog lacks).
   */
  isStartMode(connection: ConnectionId, mode: ModeId): boolean;
  /** How a usage backend is named: its label; its id, for one the catalog lacks. */
  backendName(backend: UsageBackendId): string;
}

/**
 * The run's lookups in `catalog`, an agent naming no adapter running `defaultAdapter` (the agent a
 * new node starts with).
 */
export function engineCatalog(catalog: Catalog, defaultAdapter: AdapterId): EngineCatalog {
  const connection = (id: ConnectionId) =>
    id === 'unavailable' ? undefined : connectionIn(catalog, id);
  const connectionOf = ({ adapter = defaultAdapter, connection: id }: Runs): ConnectionId => {
    const offered = adapterIn(catalog, adapter)?.connections ?? [];
    if (id === undefined) return offered[0]?.id ?? 'unavailable';
    return offered.some((one) => one.id === id) ? id : 'unavailable';
  };
  return {
    connectionOf,
    adapterOf: (id) => connection(id)?.adapter.id ?? 'unavailable',
    actionsOf: ({ adapter = defaultAdapter }) => adapterIn(catalog, adapter)?.actions ?? [],
    usageBackendOf: (agent) => connection(connectionOf(agent))?.connection.usage ?? undefined,
    connectionLabel: (id) => connection(id)?.connection.label,
    isStartMode: (id, mode) => {
      const found = connection(id);
      return found !== undefined && isStartMode(catalog, found.adapter.id, id, mode);
    },
    backendName: (id) => usageBackendIn(catalog, id)?.label ?? id,
  };
}
