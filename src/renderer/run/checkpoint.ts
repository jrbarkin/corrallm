import { CONNECTIONS } from '../../shared/session';
import type { AgentRun, Outcome, Run, TaskAttempt } from './runner';

/** Queue state and the minimal result evidence needed by conditions; no session transcript.
 * TODO(V2): full transcript and terminal-screen snapshots, if native CLI history is insufficient.
 */
export interface SavedRun {
  version: 1;
  run: Run;
  replies: [string, string][];
  held: [string, boolean][];
  arrived: [string, number][];
  ended: string[];
  past: [string, Outcome][];
  due: [string, { time: string; at: number | undefined }][];
  usageDecided: [string, { choice: 'goOn' | 'wait'; until: number }][];
  warned: string[];
}

type RecordValue = Record<string, unknown>;
const record = (v: unknown): v is RecordValue =>
  typeof v === 'object' &&
  v !== null &&
  !Array.isArray(v) &&
  Object.keys(v).every((key) => !['__proto__', 'constructor', 'prototype'].includes(key));
const string = (v: unknown): v is string => typeof v === 'string' && v.length <= 2_000_000;
const number = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const boolean = (v: unknown): v is boolean => typeof v === 'boolean';
const oneOf = (v: unknown, values: readonly string[]) =>
  typeof v === 'string' && values.includes(v);
const outcome = (v: unknown): v is Outcome =>
  oneOf(v, ['succeeded', 'failed', 'cancelled', 'skipped', 'timedOut', 'stopped']);
const values = (v: unknown, check: (v: unknown) => boolean) =>
  record(v) && Object.keys(v).length <= 20_000 && Object.values(v).every(check);
const optional = (v: RecordValue, key: string, check: (v: unknown) => boolean) =>
  v[key] === undefined || check(v[key]);
const array = (v: unknown, check: (v: unknown) => boolean) =>
  Array.isArray(v) && v.length <= 20_000 && v.every(check);
const entries = (v: unknown, check: (v: unknown) => boolean) =>
  array(
    v,
    (entry) => Array.isArray(entry) && entry.length === 2 && string(entry[0]) && check(entry[1]),
  );
const attempt = (v: unknown): v is TaskAttempt =>
  record(v) &&
  string(v.id) &&
  number(v.startedAt) &&
  oneOf(v.status, ['running', 'succeeded', 'failed', 'uncertain', 'cancelled']) &&
  optional(v, 'endedAt', number) &&
  ['reason', 'text', 'message'].every((key) => optional(v, key, string));

function agent(v: unknown): v is AgentRun {
  if (
    !record(v) ||
    !oneOf(v.status, ['running', 'waiting', 'asking', 'stopped', 'done']) ||
    !values(v.outcomes, outcome)
  )
    return false;
  return (
    optional(v, 'current', string) &&
    optional(v, 'until', number) &&
    optional(v, 'asExpected', (x) => values(x, boolean)) &&
    optional(v, 'changes', (x) => values(x, (notes) => array(notes, string))) &&
    optional(v, 'attempts', (x) => values(x, (attempts) => array(attempts, attempt))) &&
    optional(
      v,
      'problem',
      (x) =>
        record(x) &&
        oneOf(x.kind, ['failed', 'uncertain', 'cancelled']) &&
        string(x.agent) &&
        string(x.reason) &&
        string(x.text) &&
        optional(x, 'conditionKey', string),
    ) &&
    optional(v, 'rounds', (x) =>
      values(
        x,
        (round) =>
          record(round) &&
          number(round.round) &&
          Number.isInteger(round.round) &&
          round.round >= 1 &&
          optional(round, 'more', (n) => number(n) && Number.isInteger(n) && n >= 0),
      ),
    ) &&
    optional(
      v,
      'refused',
      (x) =>
        record(x) &&
        string(x.agent) &&
        string(x.text) &&
        oneOf(x.connection, ['simulated', ...CONNECTIONS]) &&
        oneOf(x.switchTo, CONNECTIONS),
    ) &&
    optional(
      v,
      'usage',
      (x) =>
        record(x) &&
        oneOf(x.backend, ['Claude', 'Codex']) &&
        oneOf(x.window, ['fiveHour', 'weekly']) &&
        number(x.percent) &&
        number(x.used) &&
        (x.resetsAt === null || number(x.resetsAt)),
    )
  );
}

/** Reject malformed checkpoints before changing any live state. */
export function readRun(text: string): SavedRun {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new Error('The saved run is not valid JSON.');
  }
  if (
    !record(v) ||
    v.version !== 1 ||
    !record(v.run) ||
    !boolean(v.run.running) ||
    !optional(v.run, 'paused', boolean) ||
    !values(v.run.agents, agent) ||
    !entries(v.replies, string) ||
    !entries(v.held, boolean) ||
    !entries(v.arrived, number) ||
    !array(v.ended, string) ||
    !entries(v.past, outcome) ||
    !entries(v.due, (x) => record(x) && string(x.time) && optional(x, 'at', number)) ||
    !entries(
      v.usageDecided,
      (x) => record(x) && oneOf(x.choice, ['goOn', 'wait']) && number(x.until),
    ) ||
    !array(v.warned, string)
  )
    throw new Error('The saved run has an invalid or unsupported format.');
  return v as unknown as SavedRun;
}
