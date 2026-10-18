import type { SlashCommand } from '../../shared/session';

/*
 * The slash commands an Agent SDK agent's composer knows besides its session's own. Claude Code
 * has commands that open a screen of its own (/permissions, /login, /hooks…): the Agent SDK runs
 * none of them. The agent view answers some itself (VIEW_COMMANDS: /resume's picker, /mcp's
 * servers, /rewind); for the others it offers to continue the conversation in Terminal, where Claude Code
 * itself runs, instead of sending them. So it does for Claude Code's bash mode ("!" first: a shell
 * command run directly, its output put in the conversation), which only its terminal has.
 */

/** The commands the agent view answers itself, as Claude Code describes them. */
export const VIEW_COMMANDS = [
  { name: 'resume', description: 'Resume a previous conversation', argumentHint: '' },
  { name: 'mcp', description: 'Manage MCP servers', argumentHint: '' },
  {
    name: 'rewind',
    description: 'Restore the code and/or conversation to a previous point',
    argumentHint: '',
  },
] as const satisfies readonly SlashCommand[];

export type ViewCommand = (typeof VIEW_COMMANDS)[number]['name'];

/** A command that runs only in Claude Code's terminal. */
interface TerminalCommand extends SlashCommand {
  /**
   * Only without arguments: with them, the session's own command of that name runs (a bare
   * /config opens Claude Code's settings; /config with a setting sets it).
   */
  bare?: true;
}

/** Claude Code's commands that open a screen of its own, as Claude Code describes them. */
export const TERMINAL_COMMANDS: readonly TerminalCommand[] = (
  [
    { name: 'login', description: 'Sign in to your Anthropic account' },
    { name: 'logout', description: 'Sign out from your Anthropic account' },
    { name: 'permissions', description: 'Manage allow and deny tool permission rules' },
    { name: 'hooks', description: 'View hook configurations for tool events' },
    { name: 'memory', description: 'Edit CLAUDE.md files and memory settings' },
    {
      name: 'status',
      description: 'Show Claude Code status: version, model, account, API connectivity',
    },
    { name: 'export', description: 'Export the current conversation to a file or clipboard' },
    { name: 'add-dir', description: 'Add a new working directory' },
    { name: 'config', description: 'Open settings', bare: true },
    { name: 'theme', description: 'Change the theme' },
    { name: 'ide', description: 'Manage IDE integrations and show status' },
    { name: 'plugin', description: 'Manage Claude Code plugins' },
    { name: 'skills', description: 'List available skills' },
    { name: 'rename', description: 'Rename the current conversation' },
    { name: 'privacy-settings', description: 'View and update your privacy settings' },
    { name: 'help', description: 'Show help and available commands' },
  ] satisfies Omit<TerminalCommand, 'argumentHint'>[]
).map((command) => ({ argumentHint: '', ...command }));

/** A message's command, if it is one: its name and what follows it. */
function parse(text: string): { name: string; args: string } | undefined {
  const match = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  const name = match?.[1];
  return name === undefined ? undefined : { name, args: match?.[2]?.trim() ?? '' };
}

/**
 * The shell command a message runs in Claude Code's bash mode, if it is one: what follows a "!" at
 * its start ("!npm test": "npm test").
 */
export function bashCommand(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith('!')) return undefined;
  const command = trimmed.slice(1).trim();
  return command === '' ? undefined : command;
}

/** The view's own command a message runs, if it runs one ("/resume"). */
export function viewCommand(text: string): ViewCommand | undefined {
  const typed = parse(text);
  return VIEW_COMMANDS.find((c) => c.name === typed?.name)?.name;
}

/**
 * The command a message runs, if it runs only in Claude Code's terminal: one of TERMINAL_COMMANDS
 * that the session (`offered`: its own commands) does not run itself.
 */
export function terminalCommand(
  text: string,
  offered: readonly SlashCommand[] | undefined,
): SlashCommand | undefined {
  const typed = parse(text);
  if (!typed) return undefined;
  const command = TERMINAL_COMMANDS.find((c) => c.name === typed.name);
  if (!command) return undefined;
  const own = offered?.some((c) => c.name === typed.name) ?? false;
  if (own && !(command.bare === true && typed.args === '')) return undefined;
  const { name, description, argumentHint } = command;
  return { name, description, argumentHint };
}

/**
 * What an Agent SDK agent's composer completes: its session's commands, the view's own, then those
 * that run in Terminal (worded so), unless the session offers one of that name.
 */
export function completedCommands(offered: readonly SlashCommand[] | undefined): SlashCommand[] {
  const views = new Set<string>(VIEW_COMMANDS.map((c) => c.name));
  const own = (offered ?? []).filter((c) => !views.has(c.name));
  const names = new Set(own.map((c) => c.name));
  return [
    ...own,
    ...VIEW_COMMANDS,
    ...TERMINAL_COMMANDS.filter((c) => !names.has(c.name)).map(
      ({ name, description, argumentHint }) => ({
        name,
        description: `In Terminal · ${description}`,
        argumentHint,
      }),
    ),
  ];
}
