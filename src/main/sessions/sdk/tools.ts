import path from 'node:path';

import type { DiffLine, ToolDetail } from '../../../shared/session';

/*
 * How Claude Code's tool calls read in corrallm's transcript: what each acts on (a file, a
 * command, a pattern), and what opening it shows (an edit's diff, a command's output, a result).
 * Inputs and results come from the CLI as JSON, so every field is read as `unknown` and checked.
 */

/** The most lines of a diff, and characters of output, a tool call carries to the renderer. */
const MAX_DIFF_LINES = 2000;
const MAX_OUTPUT = 40_000;

/** Tools whose input names a file. */
const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'NotebookRead']);

/**
 * Where a tool acts: paths in the project folder relative to it, the home folder as ~. The CLI
 * works in the folder's real path (`realCwd`, where it differs: a folder reached through a link).
 */
export interface Places {
  cwd: string;
  realCwd?: string;
  home: string;
}

/** A path as the transcript shows it: relative to the project folder, or with ~ for home. */
export function displayPath(file: string, { cwd, realCwd, home }: Places): string {
  const inside = (folder: string) => {
    const relative = path.relative(folder, file);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
      ? relative
      : undefined;
  };
  const relative = inside(cwd) ?? (realCwd === undefined ? undefined : inside(realCwd));
  if (relative !== undefined) return relative;
  const fromHome = inside(home);
  return fromHome === undefined ? file : `~${path.sep}${fromHome}`;
}

/** What a tool call acts on, in a line: the file, the command, the pattern, the URL. */
export function toolSummary(tool: string, input: unknown, places: Places): string {
  const field = (name: string) => text(property(input, name));
  if (FILE_TOOLS.has(tool)) {
    const file = field('file_path') ?? field('notebook_path') ?? '';
    return file === '' ? '' : displayPath(file, places);
  }
  switch (tool) {
    case 'Bash':
    case 'PowerShell':
      return firstLine(field('command') ?? '');
    case 'Glob':
    case 'Grep': {
      const pattern = field('pattern') ?? '';
      const where = field('path') ?? field('glob');
      return where === undefined ? pattern : `${pattern} in ${displayPath(where, places)}`;
    }
    case 'WebFetch':
      return field('url') ?? '';
    case 'WebSearch':
    case 'ToolSearch':
      return field('query') ?? '';
    case 'Agent':
    case 'Task':
      return field('description') ?? field('subagent_type') ?? '';
    case 'Skill':
      return field('skill') ?? field('name') ?? '';
    case 'TaskStop':
    case 'TaskOutput':
      return field('task_id') ?? field('shell_id') ?? '';
    case 'AskUserQuestion': {
      const questions = property(input, 'questions');
      return Array.isArray(questions)
        ? questions.flatMap((q) => text(property(q, 'question')) ?? []).join(' · ')
        : '';
    }
    case 'ExitPlanMode':
      return '';
    default:
      return firstLine(firstText(input) ?? '');
  }
}

/**
 * What a tool call about to run shows in its permission prompt: an edit's or a new file's diff,
 * or a command too long for the summary line.
 */
export function proposedDetail(tool: string, input: unknown): ToolDetail | undefined {
  switch (tool) {
    case 'Edit': {
      const before = text(property(input, 'old_string'));
      const after = text(property(input, 'new_string'));
      return before === undefined || after === undefined ? undefined : replacement(before, after);
    }
    case 'Write': {
      const content = text(property(input, 'content'));
      return content === undefined ? undefined : replacement('', content);
    }
    case 'Bash':
    case 'PowerShell': {
      const command = text(property(input, 'command')) ?? '';
      return command.includes('\n') ? output(command) : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * What a finished tool call shows: from the tool's structured result (`result`, the CLI's
 * tool_use_result) where there is one, else from what the model was told (`content`), else from
 * its input (as when a resumed session's history is read, which keeps no structured results).
 */
export function resultDetail(
  tool: string,
  input: unknown,
  result: unknown,
  content: string,
): ToolDetail | undefined {
  const patch = property(result, 'structuredPatch');
  if (Array.isArray(patch) && patch.length > 0) return diffFromPatch(patch);
  if (tool === 'Write' && property(result, 'type') === 'create') {
    const created = text(property(result, 'content'));
    if (created !== undefined) return replacement('', created);
  }
  if (tool === 'Bash' || tool === 'PowerShell') {
    const stdout = text(property(result, 'stdout'));
    const stderr = text(property(result, 'stderr'));
    if (stdout !== undefined || stderr !== undefined) {
      const both = [stdout, stderr].filter((part) => part !== undefined && part !== '').join('\n');
      return both === '' ? undefined : output(both);
    }
  }
  if (tool === 'Read') {
    const file = text(property(property(result, 'file'), 'content'));
    if (file !== undefined) return file === '' ? undefined : output(file);
  }
  if (tool === 'ExitPlanMode') {
    const plan = text(property(input, 'plan'));
    if (plan !== undefined && plan !== '') return output(plan);
  }
  if (tool === 'Agent' || tool === 'Task') {
    const report = blocksText(property(result, 'content'));
    if (report !== undefined && report !== '') return output(report);
    return content === '' ? undefined : output(subagentReport(content));
  }
  if (result === undefined && (tool === 'Edit' || tool === 'Write')) {
    // No structured result (history): the edit as it was asked for.
    return proposedDetail(tool, input);
  }
  return content === '' ? undefined : output(content);
}

/** The text of a tool result's content, as the model was told it: text blocks joined. */
export function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  return blocksText(content) ?? '';
}

/** A command's output, or any result, cut to what the renderer is sent. */
export function output(value: string): ToolDetail {
  return {
    kind: 'output',
    text:
      value.length > MAX_OUTPUT
        ? `${value.slice(0, MAX_OUTPUT)}\n… (${String(value.length - MAX_OUTPUT)} more characters)`
        : value,
  };
}

/** A diff from a patch's hunks (lines starting ' ', '-' or '+'), with "…" between hunks. */
function diffFromPatch(hunks: unknown[]): ToolDetail {
  const lines: DiffLine[] = [];
  hunks.forEach((hunk, i) => {
    if (i > 0) lines.push({ kind: 'same', text: '…' });
    const hunkLines = property(hunk, 'lines');
    if (!Array.isArray(hunkLines)) return;
    for (const line of hunkLines) {
      if (typeof line !== 'string') continue;
      const mark = line[0];
      const rest = line.slice(1);
      if (mark === '+') lines.push({ kind: 'add', text: rest });
      else if (mark === '-') lines.push({ kind: 'remove', text: rest });
      else if (mark === ' ') lines.push({ kind: 'same', text: rest });
    }
  });
  return diff(lines);
}

/** The diff of replacing `before` with `after`: every line of one removed, of the other added. */
function replacement(before: string, after: string): ToolDetail {
  const split = (value: string) => (value === '' ? [] : value.replace(/\n$/, '').split('\n'));
  return diff([
    ...split(before).map((line): DiffLine => ({ kind: 'remove', text: line })),
    ...split(after).map((line): DiffLine => ({ kind: 'add', text: line })),
  ]);
}

function diff(lines: DiffLine[]): ToolDetail {
  return {
    kind: 'diff',
    added: lines.filter((line) => line.kind === 'add').length,
    removed: lines.filter((line) => line.kind === 'remove').length,
    lines:
      lines.length > MAX_DIFF_LINES
        ? [
            ...lines.slice(0, MAX_DIFF_LINES),
            { kind: 'same', text: `… (${String(lines.length - MAX_DIFF_LINES)} more lines)` },
          ]
        : lines,
  };
}

/**
 * A subagent's report, without the frame the CLI puts around it for the model (a preamble ending
 * "The report follows:", the report indented, then the agent's id).
 */
function subagentReport(content: string): string {
  const marker = 'The report follows:\n';
  const at = content.indexOf(marker);
  if (at < 0) return content;
  const lines = content.slice(at + marker.length).split('\n');
  const end = lines.findIndex((line) => line.startsWith('agentId:'));
  return (end < 0 ? lines : lines.slice(0, end))
    .map((line) => line.replace(/^ {2}/, ''))
    .join('\n')
    .trim();
}

/** The text blocks of a content array joined, or undefined if it is not one. */
function blocksText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  return content
    .map((block) => {
      const kind = property(block, 'type');
      if (kind === 'text') return text(property(block, 'text')) ?? '';
      if (kind === 'image') return '[image]';
      return '';
    })
    .filter((part) => part !== '')
    .join('\n');
}

function firstLine(value: string): string {
  const [first = ''] = value.trim().split('\n');
  return first.length < value.trim().length ? `${first} …` : first;
}

/** The first short text in an object's values: what an unknown tool acts on, most likely. */
function firstText(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  return Object.values(input).find(
    (value): value is string => typeof value === 'string' && value !== '' && value.length <= 200,
  );
}

/** `value[name]`, if `value` is an object. */
export function property(value: unknown, name: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return (value as Record<string, unknown>)[name];
}

/** `value`, if it is a string. */
export function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
