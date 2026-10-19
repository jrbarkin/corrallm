import { randomUUID } from 'node:crypto';
import path from 'node:path';

import type { DiffLine, SessionEvent, ToolDetail, UsageLimit } from '../../shared/session';

/*
 * How what an agent does reads in corrallm's transcript, whichever CLI and connection it comes
 * from: paths as the project folder sees them, output and diffs cut to what the renderer is sent,
 * diffs from unified
 * patches, when a usage limit resets, notices. What CLIs send is JSON, so its fields are read as
 * `unknown` and checked (`property`, `text`).
 */

/** The most lines of a diff, and characters of output, a tool call carries to the renderer. */
export const MAX_DIFF_LINES = 2000;
export const MAX_OUTPUT = 40_000;

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

/** A diff of `lines`, counted, and cut to what the renderer is sent. */
export function diff(lines: DiffLine[]): ToolDetail {
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
 * The start of a detail, as a short preview shows it: its first `lines` lines, then how many more
 * there are (a diff keeps its counts).
 */
export function preview(detail: ToolDetail, lines: number): ToolDetail {
  const more = (count: number) => `… (${String(count)} more line${count === 1 ? '' : 's'})`;
  if (detail.kind === 'diff') {
    if (detail.lines.length <= lines) return detail;
    return {
      ...detail,
      lines: [
        ...detail.lines.slice(0, lines),
        { kind: 'same', text: more(detail.lines.length - lines) },
      ],
    };
  }
  const all = detail.text.split('\n');
  if (all.length <= lines) return detail;
  return { kind: 'output', text: [...all.slice(0, lines), more(all.length - lines)].join('\n') };
}

/** The diff of replacing `before` with `after`: every line of one removed, of the other added. */
export function replacement(before: string, after: string): ToolDetail {
  const split = (value: string) => (value === '' ? [] : value.replace(/\n$/, '').split('\n'));
  return diff([
    ...split(before).map((line): DiffLine => ({ kind: 'remove', text: line })),
    ...split(after).map((line): DiffLine => ({ kind: 'add', text: line })),
  ]);
}

/**
 * A unified diff (as `git diff` and Codex write them): its hunks' lines, with "…" between hunks.
 * File headers (diff --git, index, ---, +++) and "\ No newline at end of file" are left out.
 */
export function unifiedDiff(patch: string): ToolDetail {
  const lines: DiffLine[] = [];
  let hunks = 0;
  let inHunk = false;
  for (const line of patch.replace(/\r\n/g, '\n').split('\n')) {
    if (line.startsWith('@@')) {
      if (hunks > 0) lines.push({ kind: 'same', text: '…' });
      hunks += 1;
      inHunk = true;
      continue;
    }
    if (line.startsWith('diff --git ')) {
      inHunk = false;
      continue;
    }
    if (!inHunk) continue;
    const mark = line[0];
    const rest = line.slice(1);
    if (mark === '+') lines.push({ kind: 'add', text: rest });
    else if (mark === '-') lines.push({ kind: 'remove', text: rest });
    else if (mark === ' ') lines.push({ kind: 'same', text: rest });
  }
  return diff(lines);
}

/** When a usage limit resets (`epochSeconds`), as a time (`timeOnly`: later today) or a day and time. */
export function resetTime(epochSeconds: number, { timeOnly = false } = {}): string {
  const at = new Date(epochSeconds * 1000);
  const time = at
    .toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    .replace(/\s/g, '')
    .toLowerCase();
  if (timeOnly) return time;
  const day = at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${day}, ${time}`;
}

/**
 * A usage limit's window as the session's usage shows it: named by its length ("5h", "weekly"),
 * how much of it is used, and when it resets (epoch seconds in, milliseconds out).
 */
export function usageLimit({
  usedPercent,
  windowMinutes,
  resetsAt,
}: {
  usedPercent: number;
  windowMinutes: number | null;
  resetsAt: number | null;
}): UsageLimit {
  return {
    name: windowName(windowMinutes),
    usedPercent: Math.max(0, Math.min(100, usedPercent)),
    resetsAt: resetsAt === null ? null : resetsAt * 1000,
  };
}

/** A limit's window, by its length in minutes. */
function windowName(minutes: number | null): string {
  if (minutes === null || minutes <= 0) return 'usage';
  if (minutes === 7 * 24 * 60) return 'weekly';
  if (minutes === 24 * 60) return 'daily';
  if (minutes % 60 === 0) return `${String(minutes / 60)}h`;
  return `${String(minutes)}m`;
}

/** Something to tell the user, as a session event. */
export function notice(level: 'info' | 'warning' | 'error', text: string): SessionEvent {
  return { type: 'notice', id: randomUUID(), level, text };
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

/** The first line of `value`, with "…" if there is more. */
export function firstLine(value: string): string {
  const [first = ''] = value.trim().split('\n');
  return first.length < value.trim().length ? `${first} …` : first;
}
