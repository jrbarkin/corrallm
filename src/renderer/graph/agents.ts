import type { AdapterId, ConnectionId } from '../../shared/adapter';
import { isApproval, isDelay, isIf, isMessage, isRepeat, isWait } from './queue';
import type { QueueItem, RepeatedItem } from './queue';

/*
 * The renderer's own tables of what each adapter offers (main declares it in the catalog, which
 * catalog.ts loads): how agents and connections are named and worded on the canvas, and what each
 * can be asked to do. A node naming an adapter or a connection none of them has is Not connected:
 * its work stays unsent, and it is saved back as it was.
 */

export type { AdapterId };

/**
 * `table`'s own entry for `id`: never what every object inherits (`toString`, `constructor`, …),
 * which an adapter or connection a file names may be called.
 */
function own<T>(table: Readonly<Record<string, T>>, id: string): T | undefined {
  return Object.hasOwn(table, id) ? table[id] : undefined;
}

/** The adapter a new node starts with. */
export const DEFAULT_AGENT: AdapterId = 'claude-code';

/** How each adapter's agents are named on the canvas ("Claude · Terminal"). */
const AGENT_NAMES: Readonly<Record<AdapterId, string>> = {
  'claude-code': 'Claude',
  codex: 'Codex',
};

/** How an adapter's agents are named: its id, for an adapter this build doesn't have. */
export function adapterName(adapter: AdapterId): string {
  return own(AGENT_NAMES, adapter) ?? adapter;
}

/** The CLI each adapter runs. */
const AGENT_CLIS: Readonly<Record<AdapterId, string>> = {
  'claude-code': 'Claude Code',
  codex: 'Codex CLI',
};

/** The CLI an adapter runs, as its user knows it: its id, for an adapter this build doesn't have. */
export function adapterCli(adapter: AdapterId): string {
  return own(AGENT_CLIS, adapter) ?? adapter;
}

/**
 * How an agent runs: a real native connection, or 'unavailable' (Not connected): its adapter, or the
 * connection it names, is one this build lacks.
 */
export type AgentConnection = ConnectionId;

/** Terminal works with the CLI's own login; structured connections are an explicit choice. */
const AGENT_CONNECTIONS: Readonly<Record<AdapterId, readonly ConnectionId[]>> = {
  'claude-code': ['claude-code.terminal', 'claude-code.sdk'],
  codex: ['codex.terminal', 'codex.app-server'],
};

/** The connections an adapter offers, in its order: none, for one this build doesn't have. */
export function connectionsOf(adapter: AdapterId): readonly ConnectionId[] {
  return own(AGENT_CONNECTIONS, adapter) ?? [];
}

/** The adapters with working connectors, offered when choosing an agent. */
export const CONNECTED_AGENTS: readonly AdapterId[] = Object.keys(AGENT_CONNECTIONS);

/** How a connection is named (`short`: on an agent's card) and explained. */
export interface ConnectionInfo {
  label: string;
  short: string;
  description: string;
}

const NOT_CONNECTED: ConnectionInfo = {
  label: 'Not connected',
  short: 'Not connected',
  description: 'This agent has no connector in this build. Choose Claude Code or Codex',
};

const CONNECTION_INFO: Readonly<Record<ConnectionId, ConnectionInfo>> = {
  'claude-code.terminal': {
    label: 'Terminal',
    short: 'Terminal',
    description: 'Claude Code itself, in a terminal in its view: works with your Claude login',
  },
  'claude-code.sdk': {
    label: 'Agent SDK',
    short: 'SDK',
    description:
      'Claude Code through the Agent SDK, in corrallm’s transcript: needs an API key or a cloud provider',
  },
  'codex.terminal': {
    label: 'Terminal',
    short: 'Terminal',
    description: 'Codex itself, in a terminal in its view',
  },
  'codex.app-server': {
    label: 'App Server',
    short: 'App Server',
    description: 'Codex through its app server, in corrallm’s transcript',
  },
};

/** How a connection is named and explained: Not connected, for one this build doesn't have. */
export function connectionInfo(connection: AgentConnection): ConnectionInfo {
  return own(CONNECTION_INFO, connection) ?? NOT_CONNECTED;
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

/**
 * What each adapter's agents can do: their built-in tools and the slash commands that do work, as
 * documented. Tools and commands that only run the session itself (help, settings, feedback,
 * notifications, task-list and MCP plumbing) are left out.
 */
const AGENT_ACTIONS: Readonly<Record<AdapterId, readonly AgentAction[]>> = {
  // https://code.claude.com/docs/en/tools-reference.md, https://code.claude.com/docs/en/commands.md
  // (read 2026-10-11, Claude Code v2.1.287)
  'claude-code': [
    { name: 'Read', description: 'Read files' },
    { name: 'Write', description: 'Create or overwrite files' },
    { name: 'Edit', description: 'Make targeted edits to files' },
    { name: 'NotebookEdit', description: 'Edit Jupyter notebook cells' },
    { name: 'Glob', description: 'Find files by pattern' },
    { name: 'Grep', description: 'Search file contents' },
    { name: 'LSP', description: 'Code intelligence: definitions, references, type errors' },
    { name: 'Bash', description: 'Run shell commands' },
    { name: 'PowerShell', description: 'Run PowerShell commands' },
    { name: 'Monitor', description: 'Run a background command and watch its output' },
    { name: 'WebFetch', description: 'Fetch a web page' },
    { name: 'WebSearch', description: 'Search the web' },
    { name: 'Agent', description: 'Hand a task to a subagent' },
    { name: 'Workflow', description: 'Run a script that orchestrates many subagents' },
    { name: 'EnterWorktree', description: 'Work in an isolated git worktree' },
    { name: '/code-review', description: 'Review a diff or PR for bugs' },
    { name: '/security-review', description: 'Check changes for security vulnerabilities' },
    { name: '/simplify', description: 'Clean up changed code and apply the fixes' },
    { name: '/verify', description: 'Build and run the app to confirm a change works' },
    { name: '/init', description: 'Write a CLAUDE.md guide for the project' },
    { name: '/plan', description: 'Plan an approach before changing code' },
    { name: '/batch', description: 'Split a large change into parallel units' },
    { name: '/subtask', description: 'Run a task in a background subagent' },
    { name: '/goal', description: 'Keep working until a condition is met' },
    { name: '/deep-research', description: 'Research the web and write a cited report' },
    { name: '/compact', description: 'Summarize the conversation to free context' },
    { name: '/clear', description: 'Start over with empty context' },
    { name: '/rewind', description: 'Roll code and conversation back to a checkpoint' },
  ],
  // https://developers.openai.com/codex/cli/slash-commands (now learn.chatgpt.com) and the CLI's
  // source, openai/codex rust-v0.162.1 (read 2026-10-11)
  codex: [
    { name: 'exec_command', description: 'Run a shell command' },
    { name: 'apply_patch', description: 'Create, edit, delete or move files with a patch' },
    { name: 'view_image', description: 'Look at a local image' },
    { name: 'web_search', description: 'Search the web' },
    { name: 'image_gen.imagegen', description: 'Generate or edit images' },
    { name: 'spawn_agent', description: 'Hand a task to a subagent' },
    { name: '/review', description: 'Review working-tree changes and report issues' },
    { name: '/diff', description: 'Show the git diff, untracked files included' },
    { name: '/init', description: 'Write an AGENTS.md for the project' },
    { name: '/plan', description: 'Plan before changing code' },
    { name: '/goal', description: 'Work toward a long-running goal' },
    { name: '/worktree', description: 'Continue in a new git worktree' },
    { name: '/fork', description: 'Fork the chat into a new one' },
    { name: '/compact', description: 'Summarize the conversation to free context' },
    { name: '/recap', description: 'Summarize the conversation now' },
    { name: '/new', description: 'Start a new chat' },
    { name: '/export', description: 'Export the conversation as Markdown' },
  ],
};

/** What an adapter's agents can be asked to do: nothing, for an adapter this build doesn't have. */
export function actionsOf(adapter: AdapterId): readonly AgentAction[] {
  return own(AGENT_ACTIONS, adapter) ?? [];
}

/**
 * Actions that do the same job in each adapter that has one (running commands, editing,
 * searching the web, reviewing, working in a worktree, handing work to a subagent, …), so that a
 * step keeps its meaning when its agent's adapter changes, as when a template's role is given
 * another agent (templates.ts).
 */
const EQUIVALENT_ACTIONS: readonly Readonly<Record<AdapterId, string>>[] = [
  { 'claude-code': 'Bash', codex: 'exec_command' },
  { 'claude-code': 'Edit', codex: 'apply_patch' },
  { 'claude-code': 'WebSearch', codex: 'web_search' },
  { 'claude-code': '/code-review', codex: '/review' },
  { 'claude-code': 'EnterWorktree', codex: '/worktree' },
  { 'claude-code': 'Agent', codex: 'spawn_agent' },
  { 'claude-code': '/plan', codex: '/plan' },
  { 'claude-code': '/init', codex: '/init' },
  { 'claude-code': '/goal', codex: '/goal' },
];

/** What adapter `to` calls the action `from` calls `action`, if it has one for the same job. */
export function equivalentAction(
  action: string,
  from: AdapterId,
  to: AdapterId,
): string | undefined {
  if (from === to) return action;
  const job = EQUIVALENT_ACTIONS.find((one) => own(one, from) === action);
  return job === undefined ? undefined : own(job, to);
}

/** Steps keep their job when an agent changes adapter, including those inside Ifs and repeats. */
export function translateActions(
  queue: readonly QueueItem[],
  from: AdapterId,
  to: AdapterId,
): QueueItem[] {
  const has = new Set(actionsOf(to).map((a) => a.name));
  const translate = <T extends RepeatedItem>(step: T): T =>
    isWait(step) || isDelay(step) || isMessage(step) || has.has(step.action)
      ? step
      : { ...step, action: equivalentAction(step.action, from, to) ?? step.action };
  return queue.map((item): QueueItem =>
    isApproval(item)
      ? item
      : isIf(item)
        ? { ...item, then: item.then.map(translate) }
        : isRepeat(item)
          ? { ...item, repeat: item.repeat.map(translate) }
          : translate(item),
  );
}
