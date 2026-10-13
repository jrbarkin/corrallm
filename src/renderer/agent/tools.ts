/*
 * How tool calls' permission prompts read, across the agents: the transcript's (Transcript.tsx),
 * and what a Terminal agent's CLI asks, listed in Needs you (graph/Questions.tsx).
 */

/** The tools that run commands, and those that edit files, across the agents (agents.ts). */
export const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'exec_command', 'run_shell_command']);
export const EDIT_TOOLS = new Set([
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'apply_patch',
  'edit',
  'replace',
  'write_file',
]);

/** What a permission prompt asks, as Claude Code words it: to make an edit to a file, or to go on. */
export function permissionQuestion(tool: string, summary: string): string {
  return EDIT_TOOLS.has(tool)
    ? `Do you want to make this edit to ${summary}?`
    : 'Do you want to proceed?';
}
