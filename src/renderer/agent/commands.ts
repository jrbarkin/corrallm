import type { SlashCommand } from '../../shared/session';

/*
 * The slash commands an Agent SDK agent's composer knows besides its session's own. Claude Code
 * has commands that open a screen of its own (/permissions, /login, /hooks…): the Agent SDK runs
 * none of them, so the composer offers to continue the conversation in Terminal, where Claude Code
 * itself runs, instead of sending them.
 */

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
 * What an Agent SDK agent's composer completes: its session's commands, then those that run in
 * Terminal (worded so), unless the session offers one of that name.
 */
export function completedCommands(offered: readonly SlashCommand[] | undefined): SlashCommand[] {
  const own = offered ?? [];
  const names = new Set(own.map((c) => c.name));
  return [
    ...own,
    ...TERMINAL_COMMANDS.filter((c) => !names.has(c.name)).map(
      ({ name, description, argumentHint }) => ({
        name,
        description: `In Terminal · ${description}`,
        argumentHint,
      }),
    ),
  ];
}
