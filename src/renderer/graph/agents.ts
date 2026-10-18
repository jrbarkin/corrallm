import type { Connection } from '../../shared/session';
import { isApproval, isDelay, isIf, isMessage, isRepeat, isWait } from './queue';
import type { QueueItem, RepeatedItem } from './queue';

/** The coding agent a node runs. */
export const AgentType = {
  Claude: 'Claude',
  Codex: 'Codex',
  Qwen: 'Qwen',
  Gemini: 'Gemini',
} as const;
// An object rather than a TypeScript `enum`: erasableSyntaxOnly (tsconfig.base.json) rejects enums.
export type AgentType = (typeof AgentType)[keyof typeof AgentType];

/** The type a new node starts with. */
export const DEFAULT_AGENT: AgentType = AgentType.Claude;

/** The CLI each agent type is. */
export const AGENT_CLI: Record<AgentType, string> = {
  Claude: 'Claude Code',
  Codex: 'Codex CLI',
  Qwen: 'Qwen Code',
  Gemini: 'Gemini CLI',
};

/** A real native connection, or an unavailable connector for a legacy agent type. */
export type AgentConnection = Connection | 'unavailable';

/** Terminal works with the CLI's own login; structured connections are an explicit choice. */
export const AGENT_CONNECTIONS: Record<AgentType, readonly Connection[]> = {
  Claude: ['terminal', 'sdk'],
  Codex: ['codex-terminal', 'app-server'],
  Qwen: [],
  Gemini: [],
};

/** Agent types with working connectors, offered when choosing an agent. */
export const CONNECTED_AGENTS: readonly AgentType[] = Object.values(AgentType).filter(
  (agent) => AGENT_CONNECTIONS[agent].length > 0,
);

/** How each connection is named (`short`: on an agent's card) and explained. */
export const CONNECTION_INFO: Record<
  AgentConnection,
  { label: string; short: string; description: string }
> = {
  unavailable: {
    label: 'Not connected',
    short: 'Not connected',
    description: 'This CLI has no connector yet. Choose Claude Code or Codex',
  },
  terminal: {
    label: 'Terminal',
    short: 'Terminal',
    description: 'Claude Code itself, in a terminal in its view: works with your Claude login',
  },
  sdk: {
    label: 'Agent SDK',
    short: 'SDK',
    description:
      'Claude Code through the Agent SDK, in corrallm’s transcript: needs an API key or a cloud provider',
  },
  'codex-terminal': {
    label: 'Terminal',
    short: 'Terminal',
    description: 'Codex itself, in a terminal in its view',
  },
  'app-server': {
    label: 'App Server',
    short: 'App Server',
    description: 'Codex through its app server, in corrallm’s transcript',
  },
};

/** New and legacy agents use a real terminal; missing CLIs fail visibly instead of simulating. */
export function defaultConnection(agent: AgentType): AgentConnection {
  return AGENT_CONNECTIONS[agent][0] ?? 'unavailable';
}

/** The ways an agent type can be connected, as a sentence names them. */
export function connectionNames(agent: AgentType): string {
  const names = AGENT_CONNECTIONS[agent].map((connection) => CONNECTION_INFO[connection].label);
  return names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} or ${names.at(-1) ?? ''}`;
}

/** An omitted connection (including old placeholder workflows) uses the native default. */
export function connectionOf(data: {
  agent?: AgentType;
  connection?: Connection;
}): AgentConnection {
  const agent = data.agent ?? DEFAULT_AGENT;
  return data.connection !== undefined && AGENT_CONNECTIONS[agent].includes(data.connection)
    ? data.connection
    : defaultConnection(agent);
}

/** An agent's type and real connection, or its unavailable connector status. */
export function agentLabel(
  agent: AgentType,
  connection: AgentConnection,
  { short = false }: { short?: boolean } = {},
): string {
  const info = CONNECTION_INFO[connection];
  return `${agent} · ${short ? info.short : info.label}`;
}

/** Something an agent can be asked to do: a built-in tool or command, named as its docs name it. */
export interface AgentAction {
  name: string;
  description: string;
}

/**
 * What each agent can do: its built-in tools and the slash commands that do work, as documented.
 * Tools and commands that only run the session itself (help, settings, feedback, notifications,
 * task-list and MCP plumbing) are left out.
 */
export const AGENT_ACTIONS: Record<AgentType, readonly AgentAction[]> = {
  // https://code.claude.com/docs/en/tools-reference.md, https://code.claude.com/docs/en/commands.md
  // (read 2026-10-11, Claude Code v2.1.287)
  Claude: [
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
  Codex: [
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
  // https://qwenlm.github.io/qwen-code-docs/en/developers/tools/introduction/,
  // https://qwenlm.github.io/qwen-code-docs/en/users/features/commands/ and the CLI's source
  // (read 2026-10-11, Qwen Code v0.25.1)
  Qwen: [
    { name: 'read_file', description: 'Read a file, including images, PDFs and notebooks' },
    { name: 'write_file', description: 'Create or overwrite a file' },
    { name: 'edit', description: 'Replace exact text in a file' },
    { name: 'notebook_edit', description: 'Edit Jupyter notebook cells' },
    { name: 'list_directory', description: 'List a directory' },
    { name: 'glob', description: 'Find files by pattern' },
    { name: 'grep_search', description: 'Search file contents' },
    { name: 'lsp', description: 'Code intelligence: definitions, references, diagnostics' },
    { name: 'run_shell_command', description: 'Run shell commands' },
    { name: 'monitor', description: 'Run a long-lived command and stream its output' },
    { name: 'web_fetch', description: 'Fetch a URL and process its content' },
    { name: 'web_search', description: 'Search the web' },
    { name: 'agent', description: 'Hand a task to a subagent' },
    { name: 'enter_worktree', description: 'Work in an isolated git worktree' },
    { name: 'advisor', description: 'Get a second opinion from the advisor model' },
    { name: '/review', description: 'Multi-agent review of changes, files or a PR' },
    { name: '/simplify', description: 'Clean up recent changes' },
    { name: '/commit', description: 'Commit with an AI-drafted message' },
    { name: '/init', description: 'Write a QWEN.md for the project' },
    { name: '/summary', description: 'Write a project summary' },
    { name: '/plan', description: 'Plan before changing code' },
    { name: '/goal', description: 'Keep working until a verifier confirms the goal' },
    { name: '/batch', description: 'Process many files in parallel' },
    { name: '/arena', description: 'Run several models on one task and pick the best' },
    { name: '/new-app', description: 'Scaffold and build a new app' },
    { name: '/compress', description: 'Summarize the chat to save tokens' },
    { name: '/clear', description: 'Start a fresh session' },
    { name: '/restore', description: 'Revert files to a checkpoint before a tool ran' },
    { name: '/rewind', description: 'Rewind the conversation to an earlier turn' },
  ],
  // https://geminicli.com/docs/reference/tools/, https://geminicli.com/docs/reference/commands/
  // and the CLI's source (read 2026-10-11, Gemini CLI v0.63.0)
  Gemini: [
    { name: 'read_file', description: 'Read a file, including images, audio and PDFs' },
    { name: 'write_file', description: 'Create or overwrite a file' },
    { name: 'replace', description: 'Replace text in a file' },
    { name: 'list_directory', description: 'List a directory' },
    { name: 'glob', description: 'Find files by pattern' },
    { name: 'grep_search', description: 'Search file contents' },
    { name: 'run_shell_command', description: 'Run shell commands' },
    { name: 'web_fetch', description: 'Fetch and process URLs' },
    { name: 'google_web_search', description: 'Search the web with Google' },
    { name: 'invoke_agent', description: 'Hand a task to a subagent' },
    { name: 'enter_plan_mode', description: 'Research changes in read-only plan mode' },
    { name: 'activate_skill', description: "Load an Agent Skill's instructions" },
    { name: '/init', description: 'Write a GEMINI.md for the project' },
    { name: '/plan', description: 'Switch to read-only plan mode' },
    { name: '/setup-github', description: 'Set up GitHub Actions for issue triage and PR review' },
    { name: '/compress', description: 'Summarize the chat to free context' },
    { name: '/clear', description: 'Start a new session' },
    { name: '/restore', description: 'Restore files to a checkpoint before a tool ran' },
    { name: '/rewind', description: 'Rewind the chat, file changes, or both' },
  ],
};

/**
 * Actions that do the same job in each agent type that has one (running commands, editing,
 * searching the web, reviewing, working in a worktree, handing work to a subagent, …), so that a
 * step keeps its meaning when its agent's type changes, as when a template's role is given
 * another agent (templates.ts).
 */
export const EQUIVALENT_ACTIONS: readonly Partial<Readonly<Record<AgentType, string>>>[] = [
  { Claude: 'Bash', Codex: 'exec_command', Qwen: 'run_shell_command', Gemini: 'run_shell_command' },
  { Claude: 'Edit', Codex: 'apply_patch', Qwen: 'edit', Gemini: 'replace' },
  { Claude: 'Write', Qwen: 'write_file', Gemini: 'write_file' },
  { Claude: 'Read', Qwen: 'read_file', Gemini: 'read_file' },
  { Claude: 'Grep', Qwen: 'grep_search', Gemini: 'grep_search' },
  { Claude: 'Glob', Qwen: 'glob', Gemini: 'glob' },
  { Claude: 'WebSearch', Codex: 'web_search', Qwen: 'web_search', Gemini: 'google_web_search' },
  { Claude: 'WebFetch', Qwen: 'web_fetch', Gemini: 'web_fetch' },
  { Claude: '/code-review', Codex: '/review', Qwen: '/review' },
  { Claude: 'EnterWorktree', Codex: '/worktree', Qwen: 'enter_worktree' },
  { Claude: 'Agent', Codex: 'spawn_agent', Qwen: 'agent', Gemini: 'invoke_agent' },
  { Claude: '/plan', Codex: '/plan', Qwen: '/plan', Gemini: '/plan' },
  { Claude: '/init', Codex: '/init', Qwen: '/init', Gemini: '/init' },
  { Claude: '/goal', Codex: '/goal', Qwen: '/goal' },
];

/** What agent type `to` calls the action `from` calls `action`, if it has one for the same job. */
export function equivalentAction(
  action: string,
  from: AgentType,
  to: AgentType,
): string | undefined {
  if (from === to) return action;
  return EQUIVALENT_ACTIONS.find((job) => job[from] === action)?.[to];
}

/** Steps keep their job when an agent changes type, including those inside Ifs and repeats. */
export function translateActions(
  queue: readonly QueueItem[],
  from: AgentType,
  to: AgentType,
): QueueItem[] {
  const has = new Set(AGENT_ACTIONS[to].map((a) => a.name));
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
