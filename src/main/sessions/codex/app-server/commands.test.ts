import { describe, expect, it } from 'vitest';

import { COMMANDS, INIT_PROMPT, parseMessage, readSkills, slashCommands } from './commands';
import { recordedResult } from './recorded';

const DEPLOY = {
  name: 'deploy',
  description: 'Deploy to staging',
  path: '/skills/deploy/SKILL.md',
};

describe('Codex’s slash commands', () => {
  it('reads a message as a command, a skill, or text', () => {
    expect(parseMessage('/review the API changes', [])).toEqual({
      kind: 'command',
      name: 'review',
      args: 'the API changes',
    });
    // What the TUI called /permissions before.
    expect(parseMessage('/approvals', [])).toEqual({
      kind: 'command',
      name: 'permissions',
      args: '',
    });
    // A skill is sent as Codex's $name, with the skill attached.
    expect(parseMessage('/deploy now', [DEPLOY])).toEqual({
      kind: 'turn',
      text: '$deploy now',
      skills: [DEPLOY],
    });
    expect(parseMessage('ship it with $deploy', [DEPLOY])).toEqual({
      kind: 'turn',
      text: 'ship it with $deploy',
      skills: [DEPLOY],
    });
    // A slash that names nothing is text.
    expect(parseMessage('/usr/bin is missing', [DEPLOY])).toEqual({
      kind: 'turn',
      text: '/usr/bin is missing',
      skills: [],
    });
  });

  it('offers its commands, then the skills Codex has (not those that clash)', () => {
    const offered = slashCommands([DEPLOY, { ...DEPLOY, name: 'review' }]);
    expect(offered.map((command) => command.name)).toEqual([
      ...COMMANDS.map((command) => command.name),
      'deploy',
    ]);
    expect(offered.at(-1)).toEqual({
      name: 'deploy',
      description: 'Deploy to staging',
      argumentHint: '',
    });
  });

  it('reads the skills Codex found for the folder (as skills/list said it)', () => {
    const skills = readSkills(recordedResult('patch', 'skills/list'));
    expect(skills.map((skill) => skill.name)).toEqual([
      'imagegen',
      'openai-docs',
      'review-agent',
      'skill-creator',
      'skill-installer',
    ]);
    expect(skills[0]?.path).toBe('/Users/someone/.codex/skills/.system/imagegen/SKILL.md');
    expect(readSkills({ data: [{ skills: [{ ...DEPLOY, enabled: false }] }] })).toEqual([]);
  });

  it('sends Codex’s own /init prompt, word for word', () => {
    // Vendored from codex-rs/tui/assets/prompt_for_init_command.md (rust-v0.160.1).
    expect(INIT_PROMPT).toMatch(
      /^Generate a file named AGENTS\.md that serves as a contributor guide/,
    );
    expect(INIT_PROMPT).toMatch(/Agent-Specific Instructions\.\n$/);
    expect(INIT_PROMPT.split('\n')).toHaveLength(42);
  });
});
