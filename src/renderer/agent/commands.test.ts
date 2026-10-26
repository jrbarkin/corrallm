import { describe, expect, it } from 'vitest';

import type { SlashCommand } from '../../shared/session';
import { bashCommand, completedCommands, terminalCommand, viewCommand } from './commands';

const command = (name: string, description = ''): SlashCommand => ({
  name,
  description,
  argumentHint: '',
});

/** What an Agent SDK session offers, as the real CLI listed it. */
const OFFERED = ['clear', 'compact', 'config', 'context', 'model', 'usage'].map((name) =>
  command(name),
);

describe('terminalCommand', () => {
  it('finds Claude Code’s commands that open a screen of its own, which the session lacks', () => {
    expect(terminalCommand('/permissions', OFFERED)?.name).toBe('permissions');
    expect(terminalCommand('  /login ', OFFERED)?.name).toBe('login');
    expect(terminalCommand('/export notes.md', OFFERED)?.name).toBe('export');
    // Not what the session runs itself, nor a message, a path or a command it does not know.
    expect(terminalCommand('/compact', OFFERED)).toBeUndefined();
    expect(terminalCommand('please run /permissions', OFFERED)).toBeUndefined();
    expect(terminalCommand('/src/permissions', OFFERED)).toBeUndefined();
    expect(terminalCommand('/frobnicate', OFFERED)).toBeUndefined();
  });

  it('takes a bare /config for the settings screen, and /config with a setting for the session', () => {
    expect(terminalCommand('/config', OFFERED)?.name).toBe('config');
    expect(terminalCommand('/config theme dark', OFFERED)).toBeUndefined();
  });

  it('leaves a command to the session once it offers it, as a newer CLI may', () => {
    expect(terminalCommand('/hooks', [...OFFERED, command('hooks')])).toBeUndefined();
  });
});

describe('bashCommand', () => {
  it('finds a shell command for Claude Code’s bash mode: “!” first', () => {
    expect(bashCommand('!ls -la')).toBe('ls -la');
    expect(bashCommand('  ! git status ')).toBe('git status');
    expect(bashCommand('!echo "a\nb"')).toBe('echo "a\nb"');
    // Not a bare "!", nor a "!" further on.
    expect(bashCommand('!')).toBeUndefined();
    expect(bashCommand('! ')).toBeUndefined();
    expect(bashCommand('Run !ls')).toBeUndefined();
  });
});

describe('viewCommand', () => {
  it('finds the commands the agent view answers itself', () => {
    expect(viewCommand('/resume')).toBe('resume');
    expect(viewCommand(' /resume  ')).toBe('resume');
    expect(viewCommand('/compact')).toBeUndefined();
    expect(viewCommand('resume it')).toBeUndefined();
  });
});

describe('completedCommands', () => {
  it('completes the session’s commands, then those that run in Terminal, saying so', () => {
    const all = completedCommands(
      OFFERED,
      { resume: true, mcp: { changes: [] }, rewind: { restores: [] } },
      true,
    );
    expect(all.slice(0, OFFERED.length)).toEqual(OFFERED);
    const permissions = all.find((c) => c.name === 'permissions');
    expect(permissions?.description).toMatch(/^In Terminal · /);
    // The session's own /config is offered, not another.
    expect(all.filter((c) => c.name === 'config')).toEqual([command('config')]);
    // And the view's own, right after the session's.
    expect(all[OFFERED.length]).toEqual(command('resume', 'Resume a previous conversation'));
  });
});
