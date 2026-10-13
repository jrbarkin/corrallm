import type { SlashCommand } from '../../../../shared/session';
import { property, text } from '../../transcript';

/*
 * Codex's slash commands, as a session through its app server offers them: those its TUI runs that
 * make sense in corrallm, each done as the TUI does it (codex-rs/tui/src/chatwidget/
 * slash_dispatch.rs, rust-v0.160.1: /review starts a review, /compact compacts the thread, /init
 * sends the TUI's own prompt for AGENTS.md, /diff runs git, …), and the user's and the project's
 * skills (/name, sent as Codex's "$name" with the skill attached: custom prompts are deprecated in
 * favour of them). The composer completes them; the session runs them (session.ts).
 */

/** The commands corrallm runs for Codex, by name. */
export const COMMAND_NAMES = [
  'review',
  'compact',
  'init',
  'diff',
  'plan',
  'model',
  'permissions',
  'status',
  'mcp',
  'skills',
  'new',
  'clear',
  'rename',
] as const;
export type CommandName = (typeof COMMAND_NAMES)[number];

/** Each command as the composer offers it: Codex's own words for it. */
export const COMMANDS: readonly (SlashCommand & { name: CommandName })[] = [
  {
    name: 'review',
    description: 'review my current changes and find issues',
    argumentHint: '[instructions]',
  },
  {
    name: 'compact',
    description: 'summarize conversation to prevent hitting the context limit',
    argumentHint: '',
  },
  {
    name: 'init',
    description: 'create an AGENTS.md file with instructions for Codex',
    argumentHint: '',
  },
  { name: 'diff', description: 'show git diff (including untracked files)', argumentHint: '' },
  { name: 'plan', description: 'switch to Plan mode', argumentHint: '[message]' },
  {
    name: 'model',
    description: 'choose what model and reasoning effort to use',
    argumentHint: '[model] [effort]',
  },
  {
    name: 'permissions',
    description: 'choose what Codex is allowed to do',
    argumentHint: '[read-only | default | full-access]',
  },
  {
    name: 'status',
    description: 'show current session configuration and token usage',
    argumentHint: '',
  },
  { name: 'mcp', description: 'list configured MCP tools', argumentHint: '' },
  {
    name: 'skills',
    description: 'use skills to improve how Codex performs specific tasks',
    argumentHint: '',
  },
  { name: 'new', description: 'start a new chat during a conversation', argumentHint: '' },
  { name: 'clear', description: 'start a new chat, as /new does', argumentHint: '' },
  { name: 'rename', description: 'rename the current thread', argumentHint: '<name>' },
];

/** What its TUI called /permissions before: the same. */
const ALIASES: Readonly<Record<string, CommandName>> = { approvals: 'permissions' };

/** A skill Codex has (skills/list): invoked as "$name". */
export interface Skill {
  name: string;
  description: string;
  /** Its SKILL.md, which Codex reads. */
  path: string;
}

/** What a message asks: a command corrallm runs, or a turn (with the skills it invokes). */
export type Parsed =
  | { kind: 'command'; name: CommandName; args: string }
  | { kind: 'turn'; text: string; skills: Skill[] };

/**
 * What a message is: one of the commands ("/review the API"), a skill ("/name …", sent as
 * "$name …"), or a message to send, with the skills it names ("$name"). A slash that names no
 * command or skill is text ("/usr/bin is missing").
 */
export function parseMessage(message: string, skills: readonly Skill[]): Parsed {
  const typed = /^\/([\w:-]+)(?:\s+([\s\S]*))?$/.exec(message.trim());
  if (typed) {
    const [, name = '', args = ''] = typed;
    const command = COMMAND_NAMES.find((known) => known === name) ?? ALIASES[name];
    if (command !== undefined) return { kind: 'command', name: command, args: args.trim() };
    const skill = skills.find((known) => known.name === name);
    if (skill) {
      return {
        kind: 'turn',
        text: `$${skill.name}${args === '' ? '' : ` ${args}`}`,
        skills: [skill],
      };
    }
  }
  const named = new Set([...message.matchAll(/(?:^|\s)\$([\w:-]+)/g)].map((match) => match[1]));
  return { kind: 'turn', text: message, skills: skills.filter((skill) => named.has(skill.name)) };
}

/** The slash commands a session offers: its commands, then the skills that do not clash with them. */
export function slashCommands(skills: readonly Skill[]): SlashCommand[] {
  const taken = new Set<string>(COMMAND_NAMES);
  return [
    ...COMMANDS,
    ...skills.flatMap((skill) => {
      if (taken.has(skill.name)) return [];
      taken.add(skill.name);
      return [{ name: skill.name, description: skill.description, argumentHint: '' }];
    }),
  ];
}

/** The enabled skills skills/list found for the project folder. */
export function readSkills(result: unknown): Skill[] {
  const entries = property(result, 'data');
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry) => {
    const list = property(entry, 'skills');
    if (!Array.isArray(list)) return [];
    return list.flatMap((skill): Skill[] => {
      const name = text(property(skill, 'name'));
      const path = text(property(skill, 'path'));
      if (name === undefined || path === undefined || property(skill, 'enabled') === false) {
        return [];
      }
      return [
        {
          name,
          path,
          description:
            text(property(skill, 'shortDescription')) ?? text(property(skill, 'description')) ?? '',
        },
      ];
    });
  });
}

/**
 * What /init sends: the prompt Codex's TUI sends for it, word for word
 * (codex-rs/tui/assets/prompt_for_init_command.md, rust-v0.160.1).
 */
export const INIT_PROMPT = `Generate a file named AGENTS.md that serves as a contributor guide for this repository.
Before writing, check whether AGENTS.md already exists in the current working directory. If it does, do not overwrite or modify it.
Your goal is to produce a clear, concise, and well-structured document with descriptive headings and actionable explanations for each section.
Follow the outline below, but adapt as needed — add sections if relevant, and omit those that do not apply to this project.

Document Requirements

- Title the document "Repository Guidelines".
- Use Markdown headings (#, ##, etc.) for structure.
- Keep the document concise. 200-400 words is optimal.
- Keep explanations short, direct, and specific to this repository.
- Provide examples where helpful (commands, directory paths, naming patterns).
- Maintain a professional, instructional tone.

Recommended Sections

Project Structure & Module Organization

- Outline the project structure, including where the source code, tests, and assets are located.

Build, Test, and Development Commands

- List key commands for building, testing, and running locally (e.g., npm test, make build).
- Briefly explain what each command does.

Coding Style & Naming Conventions

- Specify indentation rules, language-specific style preferences, and naming patterns.
- Include any formatting or linting tools used.

Testing Guidelines

- Identify testing frameworks and coverage requirements.
- State test naming conventions and how to run tests.

Commit & Pull Request Guidelines

- Summarize commit message conventions found in the project’s Git history.
- Outline pull request requirements (descriptions, linked issues, screenshots, etc.).

(Optional) Add other sections if relevant, such as Security & Configuration Tips, Architecture Overview, or Agent-Specific Instructions.
`;

/** What the plan card's Yes sends, as Codex's TUI does (in Default mode). */
export const IMPLEMENT_PLAN = 'Implement the plan.';
