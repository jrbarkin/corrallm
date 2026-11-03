import type { AdapterDescriptor, ConnectionDescriptor } from './adapter';
import { MCP_CHANGES, REWIND_RESTORES } from './session';
import type { McpChange, RewindRestore } from './session';

/*
 * What a running session can do (B16 C1), as its manager projects it for one generation: the
 * effective `role`, `resume` and `list` its connector reported as it started, never more than its
 * adapter declares, and the usable part of its connection's `panels` and `live`, given the methods
 * that session and its adapter's conversations actually have. Nothing here is a view's guess: a
 * control is offered only where this says so, and the core refuses what it doesn't, view or none.
 *
 * Keep this module free of Node, Electron and DOM imports, and of any agent's name.
 */

/** The most an adapter does with an agent's role (`AdapterDescriptor.role`). */
export type RoleSupport = AdapterDescriptor['role'];

/** What a session reports with `started`: what it does, not whether this launch used it. */
export interface EffectiveFeatures {
  role: RoleSupport;
  /** Whether a remembered conversation can be continued. */
  resume: boolean;
  /** Whether its folder's conversations can be listed (never without `resume`). */
  list: boolean;
}

/** The usable features of one ready generation (B16 C1): null where none is ready. */
export interface SessionFeatures extends EffectiveFeatures {
  live: ConnectionDescriptor['live'];
  panels: ConnectionDescriptor['panels'];
}

/** What a report that can't be read leaves a session: nothing, and no role. */
export const NO_FEATURES: Readonly<EffectiveFeatures> = Object.freeze({
  role: 'none',
  resume: false,
  list: false,
});

/** Everything, for narrowing only: never reported, never projected. */
const ALL_FEATURES: Readonly<EffectiveFeatures> = Object.freeze({
  role: 'append',
  resume: true,
  list: true,
});

/** Roles by how much they do: what narrowing keeps. */
const ROLES: readonly RoleSupport[] = ['none', 'append-new', 'append'];

/** An adapter's declared maxima, as its connectors report them unless they find less. */
export function declaredFeatures(
  adapter: Pick<AdapterDescriptor, 'role' | 'resume' | 'list'>,
): EffectiveFeatures {
  return narrowed(adapter, ALL_FEATURES);
}

/** The lesser of two: the role that does less, each capability only where both have it. */
export function narrowed(a: EffectiveFeatures, b: EffectiveFeatures): EffectiveFeatures {
  const resume = a.resume && b.resume;
  return {
    role: ROLES[Math.min(ROLES.indexOf(a.role), ROLES.indexOf(b.role))] ?? 'none',
    resume,
    // Listing is for resuming: never without it.
    list: resume && a.list && b.list,
  };
}

/**
 * A `started` report's features, read against its adapter's maxima: undefined where they are
 * missing or not what a report holds (refused: the session gets none of them), else narrowed to
 * what the adapter declares, so a report never advertises more than its descriptor does.
 */
export function effectiveFeatures(
  report: unknown,
  max: EffectiveFeatures,
): EffectiveFeatures | undefined {
  if (typeof report !== 'object' || report === null) return undefined;
  const { role, resume, list } = report as Record<string, unknown>;
  if (
    typeof role !== 'string' ||
    !(ROLES as readonly string[]).includes(role) ||
    typeof resume !== 'boolean' ||
    typeof list !== 'boolean'
  ) {
    return undefined;
  }
  return narrowed({ role: role as RoleSupport, resume, list }, max);
}

/** What a generation actually has, beside its report: its session's and its adapter's methods. */
export interface FeatureMethods {
  setEffort: boolean;
  stopTask: boolean;
  mcpServers: boolean;
  changeMcpServer: boolean;
  /** Restores its files (a code rewind and its preview). */
  rewindFiles: boolean;
  /** Its adapter lists the folder's conversations. */
  listConversations: boolean;
  /** Its adapter finds a message's point in a conversation and forks it there. */
  forkConversation: boolean;
}

/**
 * The usable features of a ready generation: its effective report, and of its connection's
 * declared `live` and `panels` only what its methods do. A /resume panel needs a listing it may
 * use; MCP changes need the method that makes them (without it, the list alone); a code restore
 * needs its files restored, a conversation restore a fork it can resume, and both need both.
 */
export function usableFeatures(
  effective: EffectiveFeatures,
  connection: Pick<ConnectionDescriptor, 'live' | 'panels'>,
  has: FeatureMethods,
): SessionFeatures {
  const panels: SessionFeatures['panels'] = {};
  if (connection.panels.resume === true && effective.list && has.listConversations) {
    panels.resume = true;
  }
  const mcp = connection.panels.mcp;
  if (mcp !== undefined && has.mcpServers) {
    panels.mcp = {
      changes: has.changeMcpServer ? MCP_CHANGES.filter((one) => mcp.changes.includes(one)) : [],
    };
  }
  const rewind = connection.panels.rewind;
  if (rewind !== undefined) {
    const code = has.rewindFiles;
    const conversation = has.forkConversation && effective.resume;
    const possible: Readonly<Record<RewindRestore, boolean>> = {
      code,
      conversation,
      both: code && conversation,
    };
    const restores = REWIND_RESTORES.filter(
      (one) => rewind.restores.includes(one) && possible[one],
    );
    if (restores.length > 0) panels.rewind = { restores };
  }
  return {
    ...effective,
    live: {
      effort: connection.live.effort && has.setEffort,
      stopTask: connection.live.stopTask && has.stopTask,
    },
    panels,
  };
}

/** Whether `features` let `change` be made to an MCP server. */
export function allowsMcpChange(features: SessionFeatures | null, change: McpChange): boolean {
  return features?.panels.mcp?.changes.includes(change) === true;
}

/** Whether `features` let a rewind restore `restore`. */
export function allowsRewind(features: SessionFeatures | null, restore: RewindRestore): boolean {
  return features?.panels.rewind?.restores.includes(restore) === true;
}
