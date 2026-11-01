import { adapterIn, connectionIn, isStartMode, usageBackendIn } from '../adapter';
import type {
  AdapterId,
  AgentAction,
  Catalog,
  ConnectionId,
  ModeId,
  UsageBackendId,
} from '../adapter';
import { resolveAction } from './fallback';

/*
 * What the engine (the run, and the sessions it sends to) reads of the catalog
 * (src/shared/adapter.ts): an agent's adapter and connection, its actions, the usage backend it
 * spends, the modes a connection starts in and those that never ask, the text a connection runs as
 * a shell command, and how a connection and a usage backend are named.
 * The core injects these lookups into its engine; views use the same pure queries, so
 * that the engine reads no table of its own, nor any catalog but this one, and names no adapter:
 * whatever adapters the catalog declares, it runs.
 */

/** An agent, as far as the catalog's lookups read it: the adapter it runs, and how. */
interface Runs {
  adapter?: AdapterId;
  connection?: ConnectionId;
}

/**
 * What an agent runs, as the one resolver reads it (B12 C3): an adapter and connection the catalog
 * has (`known`); an adapter it names that can't run here (`unavailable`: one the catalog lacks, or
 * a connection its adapter doesn't offer), both kept as written; or none chosen yet (`unchosen`),
 * an unknown connection kept as written. No string ever stands for unchosen in a connection's
 * place.
 */
export type AgentEndpoint =
  | { readonly kind: 'known'; readonly adapter: AdapterId; readonly connection: ConnectionId }
  | {
      readonly kind: 'unavailable';
      readonly adapter: AdapterId;
      readonly connection?: ConnectionId;
    }
  | { readonly kind: 'unchosen'; readonly connection?: ConnectionId };

/**
 * The one place an agent's identity is read (B12 C3): the adapter it names, else the owner of a
 * connection it names that the catalog knows, on that connection, or its adapter's first when it
 * names none. With neither it is unchosen: no preference, registry order, label or other adapter
 * ever chooses for it.
 */
export function agentEndpoint(
  agent: { readonly adapter?: AdapterId; readonly connection?: ConnectionId },
  catalog: Catalog,
): AgentEndpoint {
  const { adapter, connection } = agent;
  const named = connection === undefined ? {} : { connection };
  if (adapter === undefined) {
    const owner = connection === undefined ? undefined : connectionIn(catalog, connection);
    return owner === undefined || connection === undefined
      ? { kind: 'unchosen', ...named }
      : { kind: 'known', adapter: owner.adapter.id, connection };
  }
  const offered = adapterIn(catalog, adapter)?.connections;
  const runs =
    connection === undefined
      ? offered?.[0]?.id
      : offered?.some((one) => one.id === connection) === true
        ? connection
        : undefined;
  return runs === undefined
    ? { kind: 'unavailable', adapter, ...named }
    : { kind: 'known', adapter, connection: runs };
}

/**
 * Whether two endpoints are the same, as the resolver reads them: of one kind, naming the same
 * adapter and connection, as written. Unchosen is no endpoint but itself, as it was written.
 */
export function sameEndpoint(a: AgentEndpoint, b: AgentEndpoint): boolean {
  return (
    a.kind === b.kind &&
    ('adapter' in a ? a.adapter : undefined) === ('adapter' in b ? b.adapter : undefined) &&
    a.connection === b.connection
  );
}

export interface EngineCatalog {
  /** The adapter an agent that names none runs (the one a new agent starts with). */
  readonly defaultAdapter: AdapterId;
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
  /** Resolves a step for this send only, by its declared action or equivalent catalog job. */
  resolveAction(
    action: string,
    agent: Pick<Runs, 'adapter'>,
  ): { action: string } | { unknown: true };
  /**
   * The usage backend an agent spends, whose usage rule applies to it: its connection's (none where
   * no reading can see it, as on an API key).
   */
  usageBackendOf(agent: Runs): UsageBackendId | undefined;
  /** How a connection is named ("Terminal"): nothing, for one the catalog lacks. */
  connectionLabel(connection: ConnectionId): string | undefined;
  /** Whether this connection runs its CLI's own terminal. */
  isTerminal(connection: ConnectionId): boolean;
  /**
   * How a connection is named in full, with its adapter's name ("<adapter> · Terminal"): nothing,
   * for one the catalog lacks.
   */
  connectionName(connection: ConnectionId): string | undefined;
  /**
   * The text a connection runs as a shell command, without asking, when a message starts with it:
   * none for one that runs no shell command from a message (or one the catalog lacks).
   */
  shellPrefix(connection: ConnectionId): string | undefined;
  /** Every text any connection runs as a shell command, without asking, when a message starts with it. */
  readonly shellPrefixes: readonly string[];
  /**
   * Whether a connection's sessions may start in `mode`: one its adapter lists that asks, among
   * those the connection starts in (never, for a connection the catalog lacks).
   */
  isStartMode(connection: ConnectionId, mode: ModeId): boolean;
  /**
   * Whether a session on `connection` acts without asking in `mode`: one its adapter lists that
   * never asks (never a mode it doesn't list, nor one on a connection the catalog lacks).
   */
  neverAsks(connection: ConnectionId, mode: ModeId): boolean;
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
    defaultAdapter,
    connectionOf,
    adapterOf: (id) => connection(id)?.adapter.id ?? 'unavailable',
    actionsOf: ({ adapter = defaultAdapter }) => adapterIn(catalog, adapter)?.actions ?? [],
    resolveAction: (action, { adapter = defaultAdapter }) =>
      resolveAction(action, adapter, catalog),
    usageBackendOf: (agent) => connection(connectionOf(agent))?.connection.usage ?? undefined,
    connectionLabel: (id) => connection(id)?.connection.label,
    isTerminal: (id) => connection(id)?.connection.view === 'terminal',
    connectionName: (id) => {
      const found = connection(id);
      return found && `${found.adapter.name} · ${found.connection.label}`;
    },
    shellPrefix: (id) => connection(id)?.connection.shellPrefix,
    shellPrefixes: shellPrefixesIn(catalog),
    isStartMode: (id, mode) => {
      const found = connection(id);
      return found !== undefined && isStartMode(catalog, found.adapter.id, id, mode);
    },
    neverAsks: (id, mode) =>
      connection(id)?.adapter.modes.some((one) => one.id === mode && !one.asks) ?? false,
    backendName: (id) => usageBackendIn(catalog, id)?.label ?? id,
  };
}

/** The action and adapter used to build a step's send, retained until native dispatch. */
export interface ResolvedStep {
  adapter: AdapterId;
  action: string;
}

/** Why a step built for another adapter must be rebuilt before it can leave. */
export function adapterRefusal(
  catalog: EngineCatalog,
  resolved: ResolvedStep,
  connection: ConnectionId,
): string | undefined {
  if (catalog.adapterOf(connection) === resolved.adapter) return undefined;
  return `Not sent: ${resolved.action} was built for ${resolved.adapter}, but this agent now runs ${catalog.connectionName(connection) ?? connection}. Edit the step or change its backend to check it again.`;
}

/** Every text any of `catalog`'s connections runs as a shell command, without asking, once each. */
export function shellPrefixesIn(catalog: Catalog): readonly string[] {
  return [
    ...new Set(
      catalog.adapters.flatMap(({ connections }) =>
        connections.flatMap(({ shellPrefix }) =>
          shellPrefix === undefined || shellPrefix === '' ? [] : [shellPrefix],
        ),
      ),
    ),
  ];
}

/** Whether `text` starts with `prefix`, the text a connection runs as a shell command, if any. */
export function startsWithShell(text: string, prefix: string | undefined): prefix is string {
  return prefix !== undefined && prefix !== '' && text.trimStart().startsWith(prefix);
}

/**
 * Why `text`, which the user didn't type, isn't sent to a session on `connection`, if it isn't: it
 * starts with the text that connection runs as a shell command, without asking. Only what the user
 * typed may be one (a canvas's text, which a shared file may hold, never is).
 */
export function shellRefusal(
  catalog: EngineCatalog,
  connection: ConnectionId,
  text: string,
): string | undefined {
  const prefix = catalog.shellPrefix(connection);
  if (!startsWithShell(text, prefix)) return undefined;
  const name = catalog.connectionName(connection) ?? 'its connection';
  return `Not sent: it starts with "${prefix}", which ${name} runs as a shell command, without asking. Reword it, or type it in the agent’s terminal yourself.`;
}
