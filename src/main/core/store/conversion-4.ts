import { randomUUID } from 'node:crypto';

import type { Connection } from './sqlite';

/*
 * Migration 4's conversion (B11 Design §4, §16 item 2): what its SQL can't do, run by the migration
 * runner alone, within migration 4's transaction (migrations.ts), through the migration's own
 * connection. A corrallm of schema 3 journaled each canvas's run as one JSON object holding its run
 * state beside the window's manual submissions (`{ version: 2, state, messages, saveError? }`):
 * each becomes the run's own envelope (`{ format: 3, run, saveError? }`), and each submission your
 * message to its agent, unless a message already represents it (the core delivered it, under the
 * submission's native id, or with the submission's own id). Every canvas's run, opened since or
 * not, is converted, or none is: the migration is one transaction.
 *
 * Frozen, as every migration is once shipped: it reads what schema 3 kept as the code of schema 3
 * (main at 767a382) read it, its own copy of those checks and limits (src/shared/run.ts'
 * parseRunCheckpoint, src/shared/engine/delivery/submission-state.ts' decodeSubmissions), so that
 * it never changes as they do. A run it can't read so is left as it was: the journal, reading only
 * its own envelope, discards it as it next restores the canvas, saying so, as it discarded a run
 * it couldn't read before. Submissions kept no time of their own: theirs is when the run holding
 * them was journaled. Images were never kept.
 */

/** Converts the runs a corrallm of schema 3 journaled. Throws, outside migration 4. */
export function convertToSchema4(connection: Connection): void {
  if (
    !connection.isTransaction ||
    connection.prepare('PRAGMA user_version').get()?.user_version !== 3
  ) {
    throw new Error('Migration 4’s conversion runs only within migration 4.');
  }
  const runs = connection
    .prepare(
      `SELECT canvas_id, updated_at, json_extract(state, '$.version') AS version,
         json_type(state) AS type, json_type(state, '$.state') AS state_type,
         json_type(state, '$.messages') AS messages_type,
         json_extract(state, '$.state') AS state, json_extract(state, '$.messages') AS messages,
         json_extract(state, '$.saveError') AS save_error,
         json_type(state, '$.saveError') AS save_error_type,
         (SELECT count(*) FROM json_each(run.state)) AS keys,
         (SELECT count(*) FROM json_each(run.state)
           WHERE key NOT IN ('version', 'state', 'messages', 'saveError')) AS others
       FROM run ORDER BY canvas_id`,
    )
    .all();
  const rewrite = connection.prepare('UPDATE run SET state = ? WHERE canvas_id = ?');
  for (const row of runs) {
    const canvas = String(row.canvas_id);
    const kept = legacyRun(row);
    if (kept === undefined) continue;
    if (kept.submissions !== undefined) {
      importSubmissions(connection, canvas, Number(row.updated_at), kept.submissions);
    }
    rewrite.run(envelope(kept.run, kept.saveError), canvas);
  }
}

/** A submission record as a corrallm of schema 3 restored it. */
interface Submission {
  id: string;
  text: string;
  status: 'completed' | 'failed' | 'cancelled';
  after?: string;
  task?: { agent: string; item: string };
  retryOf?: string;
  result?: Result;
  unresolved?: boolean;
  images?: number;
}
interface Result {
  status: 'completed' | 'failed' | 'cancelled';
  reason: string;
  message?: string;
  resetsAt?: number;
}

/** What a journaled run held, as schema 3 read it: undefined for one it couldn't restore. */
function legacyRun(
  row: Record<string, unknown>,
): { run?: string; saveError?: string; submissions?: Map<string, Submission[]> } | undefined {
  if (row.type !== 'object') return undefined;
  const saveError = row.save_error_type === 'text' ? String(row.save_error) : undefined;
  if (row.save_error_type !== null && saveError === undefined) return undefined;
  // A size refusal journaled with no checkpoint that fit.
  if (row.version === null && saveError !== undefined && row.keys === 1) return { saveError };
  const updatedAt = row.updated_at;
  if (
    row.version !== 2 ||
    row.others !== 0 ||
    typeof updatedAt !== 'number' ||
    !Number.isSafeInteger(updatedAt) ||
    updatedAt < 0 ||
    !['object', 'array'].includes(String(row.state_type)) ||
    !['object', 'array'].includes(String(row.messages_type)) ||
    typeof row.state !== 'string' ||
    typeof row.messages !== 'string'
  ) {
    return undefined;
  }
  // The bounds the journal read each part within (parseRunCheckpoint).
  if (row.state.length + row.messages.length > MAX_RUN_BYTES) return undefined;
  if (!bounded(row.state) || !bounded(row.messages)) return undefined;
  const submissions = decodeSubmissions(row.messages);
  if (submissions === undefined) return undefined;
  return { run: row.state, ...(saveError === undefined ? {} : { saveError }), submissions };
}

/** The run's own envelope: its state as kept (SQLite's JSON text), and its size refusal. */
function envelope(run: string | undefined, saveError: string | undefined): string {
  return `{"format":3${run === undefined ? '' : `,"run":${run}`}${
    saveError === undefined ? '' : `,"saveError":${JSON.stringify(saveError)}`
  }}`;
}

/**
 * Each agent's submissions, your messages to it, in their order, after every message the canvas
 * has: matched, never by an equal body, to a message that represents one already, by the agent it
 * went to and the native id the core delivered it under, or by its own id.
 */
function importSubmissions(
  connection: Connection,
  canvas: string,
  at: number,
  submissions: ReadonlyMap<string, readonly Submission[]>,
): void {
  const rows = connection
    .prepare(
      `SELECT id, to_party, json_extract(delivery, '$.as') AS alias, display
       FROM message WHERE canvas_id = ? ORDER BY seq`,
    )
    .all(canvas);
  const byAlias = new Map<string, { id: string; display: unknown }>();
  const byId = new Map<string, { to: string; display: unknown }>();
  for (const { id, to_party: to, alias, display } of rows) {
    byId.set(String(id), { to: String(to), display });
    const key = aliasOf(String(to), alias);
    if (key !== undefined && !byAlias.has(key)) byAlias.set(key, { id: String(id), display });
  }
  const redisplay = connection.prepare('UPDATE message SET display = ? WHERE id = ?');
  const add = connection.prepare(
    `INSERT INTO message (id, canvas_id, from_party, to_party, kind, origin, body, display,
       resend_of, turn, state, delivery, sent_at)
     VALUES (?, ?, 'you', ?, 'text', ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const [agent, records] of submissions) {
    const to = `agent:${agent}`;
    // The message each submission is, by its native id: one there already, or a new one.
    const represented = new Map<string, { id: string; display: unknown } | undefined>();
    const ids = new Map<string, string>();
    for (const record of records) {
      const own = byId.get(record.id);
      const there =
        byAlias.get(`${to}\u0000${record.id}`) ??
        (own?.to === to ? { id: record.id, display: own.display } : undefined);
      represented.set(record.id, there);
      ids.set(record.id, there?.id ?? randomUUID());
    }
    for (const record of records) {
      const id = ids.get(record.id) ?? randomUUID();
      const there = represented.get(record.id);
      if (there !== undefined) {
        // Its own record stays as the core kept it; it only gains where its submission showed.
        const shown = displayOf(record);
        if (there.display === null && shown !== undefined) {
          redisplay.run(JSON.stringify(shown), there.id);
        }
        continue;
      }
      const body = bodyOf(record.text);
      const display = displayOf(record, body);
      const resendOf =
        record.retryOf === undefined
          ? undefined
          : (ids.get(record.retryOf) ?? byAlias.get(`${to}\u0000${record.retryOf}`)?.id);
      add.run(
        id,
        canvas,
        to,
        record.retryOf === undefined ? 'manual' : 'resend',
        body,
        display === undefined ? null : JSON.stringify(display),
        resendOf ?? null,
        JSON.stringify(record.result ?? plainResult(record.status)),
        record.unresolved === true ? 'unresolved' : 'replied',
        JSON.stringify({ at, as: record.id, attempt: 1 }),
        at,
      );
    }
  }
}

function aliasOf(to: string, alias: unknown): string | undefined {
  return typeof alias === 'string' ? `${to}\u0000${alias}` : undefined;
}

/**
 * Where a submission showed in its agent's queue, how many images it carried, and its whole text
 * where `body`, its message's, holds it cut.
 */
function displayOf(record: Submission, body?: string): Record<string, unknown> | undefined {
  const display = {
    ...(record.after === undefined ? {} : { after: record.after }),
    ...(record.task === undefined ? {} : { task: record.task }),
    ...(body === undefined || body === record.text ? {} : { text: record.text }),
    ...(record.images === undefined || record.images === 0 ? {} : { images: record.images }),
  };
  return Object.keys(display).length === 0 ? undefined : display;
}

/*
 * A message's body, frozen as schema 4 holds it: at most MAX_MESSAGE_BYTES (16 KiB) of UTF-8. A
 * submission held up to MAX_MESSAGE_LENGTH characters: a longer one's body is cut on a character's
 * boundary, marked so, its whole text in its display.
 */
const MAX_BODY_BYTES = 16 * 1024;
const CUT = '\n\n[corrallm: cut here; the whole message is in its transcript]';

function bodyOf(text: string): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= MAX_BODY_BYTES) return text;
  const room = MAX_BODY_BYTES - new TextEncoder().encode(CUT).length;
  // The decoder ends a character cut in two with U+FFFD, dropped here.
  const kept = new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, room));
  return `${kept.replace(/\uFFFD$/u, '')}${CUT}`;
}

/** A result for a record that kept none: its status, with that status's plainest reason. */
function plainResult(status: Submission['status']): Result {
  const reason = { completed: 'completed', failed: 'error', cancelled: 'interrupted' }[status];
  return { status, reason };
}

/*
 * Schema 3's checks, frozen. parseRunCheckpoint bounded a run's state and messages together within
 * MAX_RUN_BYTES, each within MAX_JSON_NODES values, nested at most 64 deep.
 */
const MAX_RUN_BYTES = 32 * 1024 * 1024;
const MAX_JSON_NODES = 200_000;

function bounded(text: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return false;
  }
  if (value === null || typeof value !== 'object') return false;
  const remaining = { nodes: MAX_JSON_NODES };
  const walk = (one: unknown, depth: number): boolean => {
    if (depth > 64 || --remaining.nodes < 0) return false;
    if (one === null || typeof one !== 'object') return true;
    return Object.values(one).every((child) => walk(child, depth + 1));
  };
  return walk(value, 0);
}

/*
 * decodeSubmissions, frozen: at most 32 MiB, 200 agents and 2,000 records; ids of at most
 * MAX_ID_LENGTH, with no control character; texts of at most MAX_MESSAGE_LENGTH; a record queued
 * or running as the profile closed restored as cancelled and unresolved, never sent again.
 */
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_AGENTS = 200;
const MAX_RECORDS = 2000;
const MAX_ID_LENGTH = 200;
const MAX_MESSAGE_LENGTH = 200_000;
const MAX_IMAGES = 20;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const RECORD_KEYS = [
  'id',
  'text',
  'images',
  'status',
  'after',
  'result',
  'task',
  'unresolved',
  'retryOf',
];
const STATUSES = ['queued', 'running', 'completed', 'failed', 'cancelled'];
const TURN_REASONS = [
  'completed',
  'interrupted',
  'taken-back',
  'usage-limit',
  'auth',
  'api',
  'declined',
  'start-failed',
  'connection-closed',
  'error',
];
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const UNRESOLVED: Result = {
  status: 'cancelled',
  reason: 'interrupted',
  message: 'Unresolved after restart; resume the queue to continue.',
};

/** Thrown inside the decoder for a record it refuses: the whole run is left as it was. */
class Invalid extends Error {}

function decodeSubmissions(serialized: string): Map<string, Submission[]> | undefined {
  try {
    if (serialized.length > MAX_BYTES) throw new Invalid();
    const root = record(JSON.parse(serialized) as unknown, ['version', 'agents']);
    if (root.version !== 1 || !Array.isArray(root.agents) || root.agents.length > MAX_AGENTS) {
      throw new Invalid();
    }
    const decoded = new Map<string, Submission[]>();
    let count = 0;
    for (const raw of root.agents) {
      const agent = record(raw, ['id', 'submissions']);
      const agentId = id(agent.id);
      if (decoded.has(agentId) || !Array.isArray(agent.submissions)) throw new Invalid();
      count += agent.submissions.length;
      if (count > MAX_RECORDS) throw new Invalid();
      const seen = new Set<string>();
      decoded.set(
        agentId,
        agent.submissions.map((one: unknown): Submission => {
          const value = record(one, RECORD_KEYS);
          const messageId = id(value.id);
          if (seen.has(messageId)) throw new Invalid();
          seen.add(messageId);
          if (
            typeof value.text !== 'string' ||
            value.text.length > MAX_MESSAGE_LENGTH ||
            !STATUSES.includes(value.status as string)
          ) {
            throw new Invalid();
          }
          if (value.unresolved !== undefined && typeof value.unresolved !== 'boolean') {
            throw new Invalid();
          }
          const unresolved = value.status === 'queued' || value.status === 'running';
          const result = value.result === undefined ? undefined : resultOf(value.result);
          const task = value.task === undefined ? undefined : record(value.task, ['agent', 'item']);
          const images = value.images === undefined ? undefined : imageCount(value.images);
          return {
            id: messageId,
            text: value.text,
            status: unresolved ? 'cancelled' : (value.status as Submission['status']),
            ...(images === undefined ? {} : { images }),
            ...(value.after === undefined ? {} : { after: id(value.after) }),
            ...(task === undefined ? {} : { task: { agent: id(task.agent), item: id(task.item) } }),
            ...(value.retryOf === undefined ? {} : { retryOf: id(value.retryOf) }),
            ...(unresolved
              ? { unresolved: true, result: UNRESOLVED }
              : {
                  ...(result === undefined ? {} : { result }),
                  ...(value.unresolved === undefined ? {} : { unresolved: value.unresolved }),
                }),
          };
        }),
      );
    }
    return decoded;
  } catch (error) {
    if (error instanceof Invalid || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function resultOf(raw: unknown): Result {
  const value = record(raw, ['status', 'reason', 'message', 'resetsAt']);
  if (
    !['completed', 'failed', 'cancelled'].includes(value.status as string) ||
    !TURN_REASONS.includes(value.reason as string)
  ) {
    throw new Invalid();
  }
  if (
    value.message !== undefined &&
    (typeof value.message !== 'string' || value.message.length > MAX_MESSAGE_LENGTH)
  ) {
    throw new Invalid();
  }
  if (
    value.resetsAt !== undefined &&
    (typeof value.resetsAt !== 'number' ||
      !Number.isSafeInteger(value.resetsAt) ||
      value.resetsAt < 0)
  ) {
    throw new Invalid();
  }
  return {
    status: value.status as Result['status'],
    reason: value.reason as string,
    ...(value.message === undefined ? {} : { message: value.message }),
    ...(value.resetsAt === undefined ? {} : { resetsAt: value.resetsAt }),
  };
}

/** How many images a record carried, checked as schema 3 checked their bytes (never kept). */
function imageCount(raw: unknown): number {
  if (!Array.isArray(raw) || raw.length > MAX_IMAGES) throw new Invalid();
  for (const one of raw) {
    const image = record(one, ['mediaType', 'data']);
    if (
      !IMAGE_TYPES.includes(image.mediaType as string) ||
      typeof image.data !== 'string' ||
      image.data.length === 0 ||
      image.data.length % 4 !== 0 ||
      image.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)
    ) {
      throw new Invalid();
    }
  }
  return raw.length;
}

function id(raw: unknown): string {
  if (
    typeof raw !== 'string' ||
    raw.length === 0 ||
    raw.length > MAX_ID_LENGTH ||
    /\p{Cc}/u.test(raw) ||
    ['__proto__', 'prototype', 'constructor'].includes(raw)
  ) {
    throw new Invalid();
  }
  return raw;
}

function record(raw: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (
    raw === null ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.keys(raw).some((key) => !allowed.includes(key))
  ) {
    throw new Invalid();
  }
  return raw as Record<string, unknown>;
}
