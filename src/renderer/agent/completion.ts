import type { SlashCommand } from '../../shared/session';
import { api } from '../api/client';

/** Files of the canvas this window shows now: the core alone knows its project folder. */
export async function findProjectFiles(query: string): Promise<string[]> {
  const { c } = await api.windowGet();
  const { items } = await api.projectFiles({ canvas: c, query });
  return items;
}

/*
 * What the composer completes as the user types, as Claude Code does: a slash command at the start
 * of the message ("/comp" → "/compact "), or a file mention anywhere ("@src/ma" → "@src/main/").
 */

/** What is being typed at the caret: a command's name, or a file's path; and where it is. */
export interface Completing {
  kind: 'command' | 'file';
  /** What has been typed of it, without its "/" or "@". */
  query: string;
  /** Where it starts (at its "/" or "@") and ends in the draft. */
  start: number;
  end: number;
}

/** What is being completed at `caret` in `draft`, if anything. */
export function completing(draft: string, caret: number): Completing | undefined {
  const before = draft.slice(0, caret);
  const rest = /^\S*/.exec(draft.slice(caret))?.[0] ?? '';
  if (/^\/\S*$/.test(before)) {
    return { kind: 'command', query: before.slice(1), start: 0, end: caret + rest.length };
  }
  const mention = /(?:^|\s)@(\S*)$/.exec(before);
  if (mention) {
    const query = mention[1] ?? '';
    return { kind: 'file', query, start: caret - query.length - 1, end: caret + rest.length };
  }
  return undefined;
}

/** The commands whose names match `query`: those starting with it first. */
export function matchCommands(
  commands: readonly SlashCommand[],
  query: string,
  limit = 8,
): SlashCommand[] {
  const wanted = query.toLowerCase();
  const starting = commands.filter((c) => c.name.toLowerCase().startsWith(wanted));
  const containing = commands.filter(
    (c) => !c.name.toLowerCase().startsWith(wanted) && c.name.toLowerCase().includes(wanted),
  );
  return [...starting, ...containing].slice(0, limit);
}

/**
 * The draft with what was being completed replaced by `chosen` (a command's name or a file's
 * path), and where the caret goes: after a space, except after a folder, which goes on.
 */
export function complete(
  draft: string,
  { kind, start, end }: Completing,
  chosen: string,
): { text: string; caret: number } {
  const mark = kind === 'command' ? '/' : '@';
  const after = draft.slice(end);
  const folder = chosen.endsWith('/');
  const spaced = after.startsWith(' ');
  const inserted = `${mark}${chosen}${folder || spaced ? '' : ' '}`;
  return {
    text: draft.slice(0, start) + inserted + after,
    caret: start + inserted.length + (!folder && spaced ? 1 : 0),
  };
}

/**
 * Whether a message runs a slash command: "/name" at its start (then a space or its end), naming
 * one the session offers (`commands`; any name, before it has said which). A path such as
 * "/src/app" is not one.
 */
export function isCommand(text: string, commands: readonly SlashCommand[] | undefined): boolean {
  const name = /^\/([^\s/]+)(?:\s|$)/.exec(text)?.[1];
  if (name === undefined) return false;
  return commands === undefined || commands.some((command) => command.name === name);
}
