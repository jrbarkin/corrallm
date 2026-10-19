/*
 * Program Status reports (OSC 7501): how a CLI tells a terminal that asks whether it is working,
 * waiting on the user, done, idle or failed. corrallm's terminal
 * answers the CLI's probe for it (screen.ts) and follows the reports to know what the session is
 * doing. The protocol: https://www.superlogical.com/rex/docs/build/program-status
 *
 *   ESC ] 7501 ; ? ST                                   the probe; a terminal that supports it
 *                                                       answers the same (`PROBE_REPLY`)
 *   ESC ] 7501 ; state=working:app=agent BEL            a report: key=value pairs, ':' between
 */

/** The OSC number of Program Status reports. */
export const PROGRAM_STATUS = 7501;
/** What a terminal answers the CLI's probe with, to say it supports the reports. */
export const PROBE_REPLY = '\x1b]7501;?\x1b\\';

const STATES = ['idle', 'working', 'done', 'blocked', 'error', 'clear'] as const;
const KINDS = ['permission', 'question', 'auth'] as const;

/** One report, for the session itself (no `id`) or one of its background tasks (an `id`). */
export interface ProgramStatus {
  /**
   * idle: nothing has run yet, or the last turn was stopped (interrupted); working; done: the last
   * turn completed; blocked: waiting on the user; error: the last turn failed; clear: the CLI is
   * going (with no id, every record is dropped).
   */
  state: (typeof STATES)[number];
  /** What a blocked session waits for: a permission prompt, an answer to a question, a login. */
  kind?: (typeof KINDS)[number];
  /** How far along it is, 0 to 100. */
  progress?: number;
  /** Which record: a background task's (a/b paths); none for the session's own. */
  id?: string;
  title?: string;
  /** What it is doing, waiting for, or what failed. */
  msg?: string;
}

/**
 * The report in an OSC 7501 sequence's data (what follows "7501;"), or undefined if it is not
 * one (the probe, or something malformed). Unknown keys are ignored, as the protocol asks.
 */
export function parseProgramStatus(data: string): ProgramStatus | undefined {
  const fields = new Map<string, string>();
  for (const pair of data.split(':')) {
    const at = pair.indexOf('=');
    if (at > 0) fields.set(pair.slice(0, at), pair.slice(at + 1));
  }
  const state = STATES.find((one) => one === fields.get('state'));
  if (state === undefined) return undefined;
  const report: ProgramStatus = { state };
  const kind = KINDS.find((one) => one === fields.get('kind'));
  if (kind !== undefined) report.kind = kind;
  const progress = Number(fields.get('progress'));
  if (fields.has('progress') && Number.isInteger(progress) && progress >= 0 && progress <= 100) {
    report.progress = progress;
  }
  const id = fields.get('id');
  if (id !== undefined && id !== '') report.id = id;
  const title = decode(fields.get('title'), 192);
  if (title !== undefined) report.title = title;
  const msg = decode(fields.get('msg'), 2048);
  if (msg !== undefined) report.msg = msg;
  return report;
}

/** Base64 UTF-8 text, up to `max` bytes; undefined if absent, empty or not base64. */
function decode(value: string | undefined, max: number): string | undefined {
  if (value === undefined || value === '' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    return undefined;
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length === 0 || bytes.length > max) return undefined;
  return bytes.toString('utf8');
}
