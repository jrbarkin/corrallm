import {
  IMAGE_TYPES,
  MAX_ID_LENGTH,
  MAX_IMAGE_BYTES,
  MAX_IMAGES,
  MAX_MESSAGE_LENGTH,
  TURN_REASONS,
} from '../../shared/session';
import type { MessageImage, TurnResult } from '../../shared/session';
import type { Session, SubmittedMessage } from './session';

const MAX_RECORDS = 2000;
const MAX_BYTES = 32 * 1024 * 1024;
/** The per-agent history limit; unfinished records are never dropped. */
const MAX_RECENT_RECORDS = 100;
/** The saved history budget, below the file reader's limit. */
const MAX_SAVED_BYTES = 4 * 1024 * 1024;
const STATUSES = ['queued', 'running', 'completed', 'failed', 'cancelled'] as const;
const RECORD_KEYS = ['id', 'text', 'images', 'status', 'after', 'result', 'task', 'unresolved'];

/** Keeps the newest settled records and every unfinished submission. */
export function pruneSubmissions(
  submissions: readonly SubmittedMessage[],
  limit = MAX_RECENT_RECORDS,
): SubmittedMessage[] {
  let excess = submissions.filter(settled).length - limit;
  return submissions.filter((message) => !settled(message) || excess-- <= 0);
}

function settled(message: SubmittedMessage): boolean {
  return message.status !== 'queued' && message.status !== 'running' && !message.unresolved;
}

/** Persists queue records, never the native transcript or a full assistant reply. */
export function encodeSubmissions(sessions: Readonly<Record<string, Session>>): string {
  const encoder = new TextEncoder();
  const agents = Object.entries(sessions).flatMap(([id, session]) => {
    const records = session.submissions ?? [];
    const unfinished = records.filter((message) => !settled(message)).length;
    const submissions = pruneSubmissions(records, Math.max(0, MAX_RECENT_RECORDS - unfinished)).map(
      (message) => {
        const persisted = { ...message };
        delete persisted.reply;
        delete persisted.images;
        return { message: persisted, bytes: encoder.encode(JSON.stringify(persisted)).length };
      },
    );
    return submissions.length ? [{ id, submissions }] : [];
  });
  let count = 0;
  let bytes = encoder.encode(
    JSON.stringify({
      version: 1,
      agents: agents.map(({ id }) => ({ id, submissions: [] })),
    }),
  ).length;
  for (const { submissions } of agents) {
    count += submissions.length;
    bytes += submissions.reduce((sum, record) => sum + record.bytes, 0) + submissions.length - 1;
  }
  const kept = agents.flatMap(({ id, submissions }) => {
    let remaining = submissions.length;
    const retained = submissions
      .filter(({ message, bytes: size }) => {
        if ((bytes <= MAX_SAVED_BYTES && count <= MAX_RECORDS) || !settled(message)) return true;
        bytes -= size + (remaining > 1 ? 1 : 0);
        remaining--;
        count--;
        return false;
      })
      .map(({ message }) => message);
    return retained.length ? [{ id, submissions: retained }] : [];
  });
  return JSON.stringify({ version: 1, agents: kept });
}

/** Parses completely before a caller changes any live state. */
export function decodeSubmissions(serialized: string): Map<string, SubmittedMessage[]> {
  if (serialized.length > MAX_BYTES) throw new RangeError('Submission records are too large');
  const root = record(JSON.parse(serialized) as unknown, ['version', 'agents']);
  if (root.version !== 1 || !Array.isArray(root.agents) || root.agents.length > 200) invalid();
  const decoded = new Map<string, SubmittedMessage[]>();
  let count = 0;
  for (const raw of root.agents) {
    const agent = record(raw, ['id', 'submissions']);
    const agentId = id(agent.id);
    if (decoded.has(agentId) || !Array.isArray(agent.submissions)) invalid();
    count += agent.submissions.length;
    if (count > MAX_RECORDS) throw new RangeError('Too many submission records');
    const seen = new Set<string>();
    const submissions = agent.submissions.map((raw): SubmittedMessage => {
      const value = record(raw, RECORD_KEYS);
      const messageId = id(value.id);
      if (seen.has(messageId)) invalid();
      seen.add(messageId);
      if (
        typeof value.text !== 'string' ||
        value.text.length > MAX_MESSAGE_LENGTH ||
        !STATUSES.includes(value.status as SubmittedMessage['status'])
      )
        invalid();
      if (value.unresolved !== undefined && typeof value.unresolved !== 'boolean') invalid();
      const unresolved = value.status === 'queued' || value.status === 'running';
      const result = value.result === undefined ? undefined : parseResult(value.result);
      const task = value.task === undefined ? undefined : record(value.task, ['agent', 'item']);
      return {
        id: messageId,
        text: value.text,
        status: unresolved ? 'cancelled' : (value.status as SubmittedMessage['status']),
        ...(value.images === undefined ? {} : { images: images(value.images) }),
        ...(value.after === undefined ? {} : { after: id(value.after) }),
        ...(task === undefined ? {} : { task: { agent: id(task.agent), item: id(task.item) } }),
        ...(unresolved
          ? {
              unresolved: true,
              result: {
                status: 'cancelled',
                reason: 'interrupted',
                message: 'Unresolved after restart; resume the queue to continue.',
              } as const,
            }
          : {
              ...(result === undefined ? {} : { result }),
              ...(value.unresolved === undefined ? {} : { unresolved: value.unresolved }),
            }),
      };
    });
    decoded.set(agentId, submissions);
  }
  return decoded;
}

function parseResult(raw: unknown): TurnResult {
  const value = record(raw, ['status', 'reason', 'message', 'resetsAt']);
  if (
    !['completed', 'failed', 'cancelled'].includes(value.status as string) ||
    !TURN_REASONS.includes(value.reason as TurnResult['reason'])
  )
    invalid();
  if (
    value.message !== undefined &&
    (typeof value.message !== 'string' || value.message.length > MAX_MESSAGE_LENGTH)
  )
    invalid();
  if (
    value.resetsAt !== undefined &&
    (typeof value.resetsAt !== 'number' ||
      !Number.isSafeInteger(value.resetsAt) ||
      value.resetsAt < 0)
  )
    invalid();
  return {
    status: value.status as TurnResult['status'],
    reason: value.reason as TurnResult['reason'],
    ...(value.message === undefined ? {} : { message: value.message }),
    ...(value.resetsAt === undefined ? {} : { resetsAt: value.resetsAt }),
  };
}

function images(raw: unknown): MessageImage[] {
  if (!Array.isArray(raw) || raw.length > MAX_IMAGES) invalid();
  return raw.map((raw): MessageImage => {
    const image = record(raw, ['mediaType', 'data']);
    if (
      !IMAGE_TYPES.includes(image.mediaType as MessageImage['mediaType']) ||
      typeof image.data !== 'string' ||
      image.data.length === 0 ||
      image.data.length % 4 !== 0 ||
      image.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)
    )
      invalid();
    return { mediaType: image.mediaType as MessageImage['mediaType'], data: image.data };
  });
}

function id(raw: unknown): string {
  if (
    typeof raw !== 'string' ||
    raw.length === 0 ||
    raw.length > MAX_ID_LENGTH ||
    /\p{Cc}/u.test(raw) ||
    ['__proto__', 'prototype', 'constructor'].includes(raw)
  )
    invalid();
  return raw;
}

function record(raw: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (
    raw === null ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.keys(raw).some((key) => !allowed.includes(key))
  )
    invalid();
  return raw as Record<string, unknown>;
}

function invalid(): never {
  throw new TypeError('Invalid submission records');
}
