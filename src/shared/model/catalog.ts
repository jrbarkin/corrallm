import { adapterIn, connectionIn, isStartMode, usageBackendIn } from '../adapter';
import type {
  AdapterId,
  AgentAction,
  Catalog,
  ConnectionDescriptor,
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
  /** The one resolver, with no preference or implicit endpoint. */
  endpointOf(agent: Runs): AgentEndpoint;
  /**
   * The connection of a known endpoint; undefined for unchosen or unavailable agents.
   */
  connectionOf(agent: Runs): ConnectionId | undefined;
  /** The owner of a known connection; undefined otherwise. */
  adapterOf(connection: ConnectionId | undefined): AdapterId | undefined;
  /** What an agent's steps can name, with what each does: none, for an adapter the catalog lacks. */
  actionsOf(agent: Runs): readonly AgentAction[];
  /** Resolves a step for this send only, by its declared action or equivalent catalog job. */
  resolveAction(action: string, agent: Runs): { action: string } | { unknown: true };
  /**
   * The usage backend an agent spends, whose usage rule applies to it: its connection's (none where
   * no reading can see it, as on an API key).
   */
  usageBackendOf(agent: Runs): UsageBackendId | undefined;
  /** How a connection is named ("Terminal"): nothing, for one the catalog lacks. */
  connectionLabel(connection: ConnectionId | undefined): string | undefined;
  /** Whether this connection runs its CLI's own terminal. */
  isTerminal(connection: ConnectionId | undefined): boolean;
  /**
   * How a connection is named in full, with its adapter's name ("<adapter> · Terminal"): nothing,
   * for one the catalog lacks.
   */
  connectionName(connection: ConnectionId | undefined): string | undefined;
  /**
   * The text a connection runs as a shell command, without asking, when a message starts with it:
   * none for one that runs no shell command from a message (or one the catalog lacks).
   */
  shellPrefix(connection: ConnectionId | undefined): string | undefined;
  /** Whether this connection expands @ file mentions in input without asking. */
  fileMentions(connection: ConnectionId | undefined): boolean;
  /**
   * The images a message to this connection may carry, as it declares them (B16 C3: read through
   * `imageRefusal`, within the platform's ceilings): null for none, or a connection the catalog
   * lacks.
   */
  images(connection: ConnectionId | undefined): ConnectionDescriptor['images'];
  /** Every text any connection runs as a shell command, without asking, when a message starts with it. */
  readonly shellPrefixes: readonly string[];
  /**
   * Whether a connection's sessions may start in `mode`: one its adapter lists that asks, among
   * those the connection starts in (never, for a connection the catalog lacks).
   */
  isStartMode(connection: ConnectionId | undefined, mode: ModeId): boolean;
  /**
   * Whether a session on `connection` acts without asking in `mode`: one its adapter lists that
   * never asks (never a mode it doesn't list, nor one on a connection the catalog lacks).
   */
  neverAsks(connection: ConnectionId | undefined, mode: ModeId): boolean;
  /** How a usage backend is named: its label; its id, for one the catalog lacks. */
  backendName(backend: UsageBackendId): string;
}

/** Runtime lookups resolve only the endpoint the agent itself names. */
export function engineCatalog(catalog: Catalog): EngineCatalog {
  const connection = (id: ConnectionId | undefined) =>
    id === undefined ? undefined : connectionIn(catalog, id);
  const endpoint = (agent: Runs) => agentEndpoint(agent, catalog);
  const connectionOf = (agent: Runs): ConnectionId | undefined => {
    const found = endpoint(agent);
    return found.kind === 'known' ? found.connection : undefined;
  };
  return {
    endpointOf: endpoint,
    connectionOf,
    adapterOf: (id) => connection(id)?.adapter.id,
    actionsOf: (agent) => {
      const found = endpoint(agent);
      return found.kind === 'known' ? (adapterIn(catalog, found.adapter)?.actions ?? []) : [];
    },
    resolveAction: (action, agent) => {
      const found = endpoint(agent);
      return found.kind === 'known'
        ? resolveAction(action, found.adapter, catalog)
        : { unknown: true };
    },
    usageBackendOf: (agent) => connection(connectionOf(agent))?.connection.usage ?? undefined,
    connectionLabel: (id) => connection(id)?.connection.label,
    isTerminal: (id) => connection(id)?.connection.view === 'terminal',
    connectionName: (id) => {
      const found = connection(id);
      return found && `${found.adapter.name} · ${found.connection.label}`;
    },
    shellPrefix: (id) => connection(id)?.connection.shellPrefix,
    fileMentions: (id) => connection(id)?.connection.fileMentions === true,
    images: (id) => connection(id)?.connection.images ?? null,
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
  connection: ConnectionId | undefined,
): string | undefined {
  if (catalog.adapterOf(connection) === resolved.adapter) return undefined;
  return `Not sent: ${resolved.action} was built for ${resolved.adapter}, but this agent now runs ${catalog.connectionName(connection) ?? connection ?? 'no chosen endpoint'}. Edit the step or change its backend to check it again.`;
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

/** An @ at the start or after a non-ASCII-letter/digit, followed by non-whitespace; no path lookup. */
export function hasFileMention(text: string): boolean {
  return /(?:^|[^A-Za-z0-9])@\S/u.test(text);
}

/** Only the user's typed text may ask a connection to expand a native file mention. */
export function fileMentionRefusal(
  catalog: EngineCatalog,
  connection: ConnectionId | undefined,
  text: string,
): string | undefined {
  if (!catalog.fileMentions(connection) || !hasFileMention(text)) return undefined;
  const name = catalog.connectionName(connection) ?? 'its connection';
  return `Not sent: it contains a file mention, which ${name} reads without asking. Reword it, or type it in the agent’s terminal yourself.`;
}

/**
 * Why `text`, which the user didn't type, isn't sent to a session on `connection`, if it isn't: it
 * starts with the text that connection runs as a shell command, without asking. Only what the user
 * typed may be one (a canvas's text, which a shared file may hold, never is).
 */
export function shellRefusal(
  catalog: EngineCatalog,
  connection: ConnectionId | undefined,
  text: string,
): string | undefined {
  const prefix = catalog.shellPrefix(connection);
  if (!startsWithShell(text, prefix)) return undefined;
  const name = catalog.connectionName(connection) ?? 'its connection';
  return `Not sent: it starts with "${prefix}", which ${name} runs as a shell command, without asking. Reword it, or type it in the agent’s terminal yourself.`;
}

/** Why an agent cannot run until you choose an endpoint in its settings. */
export function endpointRefusal(endpoint: AgentEndpoint, name: string): string | undefined {
  if (endpoint.kind === 'known') return undefined;
  return endpoint.kind === 'unchosen'
    ? `${name} has no agent chosen yet. Choose one in its settings to run this work.`
    : `${name} runs ${endpoint.adapter}, which this build doesn't have. Choose another agent in its settings to run this work.`;
}
