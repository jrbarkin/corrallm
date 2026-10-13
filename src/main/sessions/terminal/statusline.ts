import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import type { UsageWindows, WindowUsage } from '../../../shared/usage';

/*
 * Usage readings from a Terminal session. Claude Code gives its status line command a JSON input
 * that includes its usage limits (`rate_limits.five_hour` and `.seven_day`: `used_percentage`, and
 * `resets_at` in epoch seconds). corrallm adds a status line of its own through the session's
 * --settings (which win over the user's, project's and local settings), so it hears them: a small
 * POSIX shell script that posts the input to main's hook server (with the session's token, read
 * from a file only the user can read), in the background, then runs the user's own status line
 * with the same input, so theirs still shows exactly as it did. Theirs is found as Claude Code
 * finds it (local, then project, then user settings) when the session starts.
 *
 * Claude Code runs a status line only once the folder is trusted, the same gate as the user's own;
 * it runs it as `/bin/sh -c <command>`, as the script runs theirs. The input is never put in a
 * command line: it goes to curl and to the user's command on their standard input only. Without
 * curl, nothing is posted, and theirs still shows.
 *
 * Not on Windows: Claude Code runs status lines there through Git Bash or PowerShell, which this
 * script is not written for. There corrallm adds no status line (the user's shows as it is) and
 * reads no usage from Terminal sessions.
 */

/** A `statusLine` setting, as Claude Code's settings have it. */
export interface StatusLine {
  type: 'command';
  command: string;
  padding?: number;
  refreshInterval?: number;
  hideVimModeIndicator?: boolean;
}

/** The settings that say how a status line shows, kept from the user's when corrallm wraps it. */
const SHOWN = ['padding', 'refreshInterval', 'hideVimModeIndicator'] as const;
/** Claude Code's windows, by the names its status line input gives them. */
const WINDOWS = { five_hour: 'fiveHour', seven_day: 'weekly' } as const;
/** The latest a window can reset: a week and a day from now. */
const MAX_AHEAD_MS = 8 * 24 * 60 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * What Claude Code's status line input says of its usage limits: each window's share used (kept
 * from 0 to 100) and when it resets (epoch ms, or null if it does not say, or says something that
 * is not a time within a week and a day of `now`). Undefined if it says nothing of them. Nothing
 * else in the input is kept.
 */
export function statusLineUsage(
  input: Readonly<Record<string, unknown>>,
  now: number,
): UsageWindows | undefined {
  const limits = input.rate_limits;
  if (!isRecord(limits)) return undefined;
  const windows: UsageWindows = {};
  for (const [name, window] of Object.entries(WINDOWS)) {
    const limit = limits[name];
    if (!isRecord(limit)) continue;
    const used = limit.used_percentage;
    if (typeof used !== 'number' || !Number.isFinite(used)) continue;
    const resets = limit.resets_at;
    const resetsAt =
      typeof resets === 'number' &&
      Number.isFinite(resets) &&
      resets > 0 &&
      resets * 1000 <= now + MAX_AHEAD_MS
        ? Math.round(resets * 1000)
        : null;
    const usage: WindowUsage = { usedPercent: Math.min(100, Math.max(0, used)), resetsAt };
    windows[window] = usage;
  }
  return Object.keys(windows).length > 0 ? windows : undefined;
}

/**
 * The user's own status line, found as Claude Code finds it: in the project folder's local
 * settings (.claude/settings.local.json), then its shared ones (.claude/settings.json), then the
 * user's (settings.json in CLAUDE_CONFIG_DIR, or ~/.claude). A file that cannot be read, or a
 * status line that is not a command, is passed over. Only its command and how it shows are kept.
 */
export async function userStatusLine(
  env: Readonly<Record<string, string>>,
  cwd: string,
): Promise<StatusLine | undefined> {
  const config = env.CLAUDE_CONFIG_DIR ?? path.join(env.HOME ?? homedir(), '.claude');
  const files = [
    path.join(cwd, '.claude', 'settings.local.json'),
    path.join(cwd, '.claude', 'settings.json'),
    path.join(config, 'settings.json'),
  ];
  for (const file of files) {
    let settings: unknown;
    try {
      settings = JSON.parse(await readFile(file, 'utf8'));
    } catch {
      continue;
    }
    const line = isRecord(settings) ? settings.statusLine : undefined;
    if (!isRecord(line) || line.type !== 'command') continue;
    const { command } = line;
    if (typeof command !== 'string' || command.trim() === '' || command.includes('\0')) continue;
    const shown = Object.fromEntries(
      SHOWN.flatMap((key) => (key in line ? [[key, line[key]]] : [])),
    );
    return { ...shown, type: 'command', command };
  }
  return undefined;
}

/** `text` as one word for a POSIX shell: in single quotes, each of its own written '\''. */
export function shellQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/**
 * The script corrallm's status line runs: posts its input to `url` (in the background, headers
 * from `header`, giving up after 2 s) if it says anything of usage limits, then runs the user's
 * own status line (`theirs`) with the same input and exits as it does; or, with none, prints
 * nothing.
 */
export function statusLineScript(url: string, header: string, theirs: string | undefined): string {
  return [
    '# corrallm: tells corrallm what Claude Code says of its usage limits, then shows the',
    "# user's own status line, given the same input.",
    // Read whole, exactly (its last line break kept), with the shell's own commands only: the
    // PATH Claude Code has may lack the usual ones.
    'input=',
    'while IFS= read -r line; do input="$input$line',
    '"; done',
    'input=$input$line',
    'case $input in',
    `*'"rate_limits"'*)`,
    '  for curl in curl /usr/bin/curl; do command -v "$curl" >/dev/null 2>&1 && break; curl=; done',
    '  if [ -n "$curl" ]; then',
    `    printf '%s' "$input" | "$curl" -s -m 2 -o /dev/null -H 'Content-Type: application/json' -H @${shellQuote(header)} --data-binary @- ${shellQuote(url)} >/dev/null 2>&1 &`,
    '  fi',
    '  ;;',
    'esac',
    ...(theirs === undefined ? [] : [`printf '%s' "$input" | /bin/sh -c ${shellQuote(theirs)}`]),
    '',
  ].join('\n');
}

/**
 * Writes corrallm's status line for a Terminal session into its settings folder (`dir`: its
 * script, and the header with its token, readable by the user only), and returns it as settings
 * to merge into the session's --settings: the user's own (`userStatusLine`), wrapped, shown as
 * theirs is. None on Windows (see above).
 */
export async function statusLineSettings({
  dir,
  url,
  token,
  env,
  cwd,
  platform = process.platform,
}: {
  dir: string;
  /** Where the input is posted (main's hook server's status path). */
  url: string;
  /** The session's hook token. */
  token: string;
  /** The session's environment, which finds the user's settings. */
  env: Readonly<Record<string, string>>;
  /** The project folder. */
  cwd: string;
  platform?: NodeJS.Platform;
}): Promise<{ statusLine?: StatusLine }> {
  if (platform === 'win32') return {};
  const theirs = await userStatusLine(env, cwd);
  const header = path.join(dir, 'statusline-header');
  const script = path.join(dir, 'statusline.sh');
  await writeFile(header, `Authorization: Bearer ${token}\n`, { mode: 0o600 });
  await writeFile(script, statusLineScript(url, header, theirs?.command), { mode: 0o600 });
  return {
    statusLine: { ...theirs, type: 'command', command: `/bin/sh ${shellQuote(script)}` },
  };
}
