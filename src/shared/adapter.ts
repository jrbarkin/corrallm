import type { McpChange, RewindRestore, SlashCommand } from './session';
import type { PromptCapabilities } from './model/prompts';

/*
 * The catalog: what every adapter declares about the agent it runs, as plain data. Main builds it
 * once from its registry (src/main/sessions/adapters.ts), each adapter filling in its own
 * descriptor, and the renderer loads it before it mounts (src/renderer/catalog.ts). The platform
 * reads what an adapter declares here instead of naming any agent itself.
 *
 * Keep this module free of Node, Electron and DOM imports: it is compiled into every process. It
 * names no agent, and its comments give no agent's examples.
 */

/** What every id in the catalog looks like: a letter, then letters, digits, `.`, `_` or `-`. */
export const ID_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,31}$/;

/** Names an agent (an adapter runs one), never the folder its adapter lives in. */
export type AdapterId = string;
/** Names one way of running an agent; unique across adapters. */
export type ConnectionId = string;
/** Names a mode; unique within its adapter. */
export type ModeId = string;
/** Names whose usage limits a reading counts. */
export type UsageBackendId = string;
/** Names one of a usage backend's windows; unique within its backend. */
export type UsageWindowId = string;

/** The platform's own jobs, which a step keeps when its agent changes adapter. */
export const JOBS = [
  'shell',
  'edit',
  'write',
  'read',
  'grep',
  'glob',
  'web-search',
  'web-fetch',
  'code-review',
  'worktree',
  'subagent',
  'plan',
  'init',
  'goal',
] as const;
export type Job = (typeof JOBS)[number];

export interface Catalog {
  /** Sorted by name when the catalog is built. */
  adapters: AdapterDescriptor[];
  usageBackends: UsageBackendDescriptor[];
}

export interface AdapterDescriptor {
  id: AdapterId;
  name: string;
  /** Its colour: an index into the platform's palette of agent colours. */
  accent: number;
  /** Its icon, an SVG document, drawn only as an image from a `data:` URL. */
  logo?: string;
  /**
   * Its words: where its user's own defaults come from, and how to add an MCP server to it (for
   * a connection whose view lists them).
   */
  words: { defaults: string; mcpHint?: string };
  /** Every mode it knows, each classified. */
  modes: ModeDescriptor[];
  /** Whether its sessions may report modes beyond `modes` as they run. */
  runtimeModes: boolean;
  /**
   * The most it does with an agent's role, which never replaces its native instructions: adds it
   * on every launch ('append'); adds it on every launch, while a resumed conversation keeps the
   * instructions it started with ('append-new'); or nothing ('none').
   */
  role: 'append' | 'append-new' | 'none';
  /** Whether a remembered conversation can be continued. */
  resume: boolean;
  /** Whether the project folder's conversations can be listed (it can resume them too). */
  list: boolean;
  /** The tools and work-doing commands a queue's steps can name, with the jobs they do. */
  actions: AgentAction[];
  /** In its own order: the first is what an agent gets when nothing chose. At least one. */
  connections: ConnectionDescriptor[];
  /**
   * Its command to register an outside HTTP MCP server, with `{server}`, `{url}` and `{var}` in
   * place of the server's name, its URL and the variable holding its token; none where it can't.
   */
  registerMcp?: string;
  /**
   * Its command to register an outside HTTP MCP server whose headers a command prints each time it
   * connects, so a token renewed in the file that command reads needs no restart: `{server}` and
   * `{url}` as for `registerMcp`, and `{helper}` in place of that command, as a JSON string's
   * contents (holding no single quote). None where its CLI has no such helper.
   */
  registerMcpHelper?: string;
}

export interface ModeDescriptor {
  id: ModeId;
  label: string;
  description: string;
  /**
   * Whether it asks before acting: a mode that never asks is never saved, never cycled, and
   * entered only once the user confirms it.
   */
  asks: boolean;
  /** How little it asks, against its adapter's other modes: higher asks less. */
  rank: number;
}

export interface ConnectionDescriptor {
  id: ConnectionId;
  label: string;
  /** Its label where room is short (an agent's card). */
  short: string;
  /** What it is, and the logins it works with, in words. */
  description: string;
  /** What its agent view shows: the agent's own terminal, or corrallm's transcript. */
  view: 'terminal' | 'transcript';
  /** Support per prompt kind; an occurrence's answerIn says where it is answered now. */
  prompts: PromptCapabilities;
  /** Whether every ask-rule and safety-check reason is reported with prompt signals. */
  signals: boolean;
  /** Whether a recording proves token context reports on this connection's own basis. */
  context: boolean;
  /** The native route for corrallm's agent API; null until that connection's evidence gate opens. */
  api: 'http' | 'channel' | null;
  /**
   * The modes (each one that asks) an agent's saved setting may name for it, to start its
   * sessions in; none: always the user's own default.
   */
  startModes: ModeId[];
  /** What a running session of it changes when corrallm asks. */
  live: { effort: boolean; stopTask: boolean };
  /** The commands its agent view answers itself, in a panel. */
  panels: {
    resume?: true;
    mcp?: { changes: McpChange[] };
    rewind?: { restores: RewindRestore[] };
  };
  /** The images a message to it may carry, or null for none. */
  images: { types: string[]; maxBytes: number; max: number } | null;
  /** The usage backend it spends, or null: none a usage reading can see. */
  usage: UsageBackendId | null;
  /**
   * Another connection of its adapter that continues the same conversation, for what this one
   * can't do: the slash commands only that one runs, its shell commands, and signing in to an MCP
   * server.
   */
  continueIn?: {
    connection: ConnectionId;
    commands: SlashCommand[];
    shell: boolean;
    mcpSignIn: boolean;
  };
  /** For a terminal view: what Shift+Enter types (null: the terminal's own Enter). */
  keys?: { shiftEnter: string | null };
  /** Text it runs as a shell command, without asking, when a message starts with it. */
  shellPrefix?: string;
}

export interface UsageBackendDescriptor {
  id: UsageBackendId;
  label: string;
  /** Where its readings come from, in words. */
  source: string;
  windows: { id: UsageWindowId; label: string; lengthMs: number }[];
}

export interface AgentAction {
  name: string;
  description: string;
  job?: Job;
}

/** The adapter `id` names, if the catalog has it. */
export function adapterIn(catalog: Catalog, id: AdapterId): AdapterDescriptor | undefined {
  return catalog.adapters.find((adapter) => adapter.id === id);
}

/** The connection `id` names and the adapter it belongs to, if the catalog has it. */
export function connectionIn(
  catalog: Catalog,
  id: ConnectionId,
): { adapter: AdapterDescriptor; connection: ConnectionDescriptor } | undefined {
  for (const adapter of catalog.adapters) {
    const connection = adapter.connections.find((one) => one.id === id);
    if (connection) return { adapter, connection };
  }
  return undefined;
}

/** The usage backend `id` names, if the catalog has it. */
export function usageBackendIn(
  catalog: Catalog,
  id: UsageBackendId,
): UsageBackendDescriptor | undefined {
  return catalog.usageBackends.find((backend) => backend.id === id);
}

/**
 * Whether an agent's saved setting may name `mode` for `adapter`: a mode it lists that asks, which
 * `connection` (one of its own) names to start in; without a connection, one of its connections.
 */
export function isStartMode(
  catalog: Catalog,
  adapter: AdapterId,
  connection: ConnectionId | undefined,
  mode: ModeId,
): boolean {
  const found = adapterIn(catalog, adapter);
  if (!found?.modes.some((one) => one.id === mode && one.asks)) return false;
  return found.connections.some(
    (one) => (connection === undefined || one.id === connection) && one.startModes.includes(mode),
  );
}
