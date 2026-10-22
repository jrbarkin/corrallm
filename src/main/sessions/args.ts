import { adapterIn, connectionIn, isStartMode } from '../../shared/adapter';
import type { AdapterId, Catalog } from '../../shared/adapter';
import type { IpcArgs } from '../../shared/ipc';
import { parseRole } from '../../shared/role';
import { MAX_NODE_ID } from '../../shared/model/canvas';
import {
  CODEX_MODES,
  ELICITATION_ACTIONS,
  EFFORT_PATTERN,
  IMAGE_TYPES,
  imageBytes,
  MAX_ANSWER_LENGTH,
  MAX_ID_LENGTH,
  MAX_FORM_FIELDS,
  MAX_MCP_NAME_LENGTH,
  MAX_MESSAGE_LENGTH,
  MAX_QUESTIONS,
  MCP_CHANGES,
  MODEL_PATTERN,
  PERMISSION_MODES,
  PLAN_MODES,
  REWIND_RESTORES,
} from '../../shared/session';
import { MAX_IMAGE_BYTES, MAX_IMAGE_TOTAL, MAX_IMAGES } from '../../shared/api/limits';
import type {
  FormValue,
  MessageImage,
  PlanAnswer,
  SessionAnswer,
  SessionMode,
  SessionOptions,
  UserMessage,
} from '../../shared/session';
import { isNativeId } from './id';

/*
 * Parsers for the session:* channels' arguments, which come from an untrusted renderer: each
 * checks every value (type, length, allowed values) and builds the contract's tuple afresh, or
 * throws. Nothing the renderer sent is passed on as it came.
 */

export function parseStartArgs(args: unknown[], catalog: Catalog): IpcArgs<'session:start'> {
  const [agentId, options] = expect(args, 2, 'an agent and how to start its session');
  const { connection, model, mode, effort, role } = record(options, 'the session options', [
    'connection',
    'model',
    'mode',
    'effort',
    'role',
  ]);
  const authoredRole = parseRole(role);
  const connected = connectionIn(catalog, typeof connection === 'string' ? connection : '');
  if (!connected) {
    const all = catalog.adapters.flatMap((adapter) => adapter.connections.map((one) => one.id));
    throw new TypeError(`Expected a connection: ${all.join(', ')}`);
  }
  const { adapter, connection: started } = connected;
  const parsed: SessionOptions = {
    connection: started.id,
    model: model === null ? null : parseModel(model),
    // One its connection starts in (each asks), or null for the user's own.
    mode: mode === null ? null : parseStartMode(mode, catalog, adapter.id, started.id),
    ...(effort === undefined ? {} : { effort: parseEffort(effort) }),
    ...(authoredRole === undefined ? {} : { role: authoredRole }),
  };
  return [parseId(agentId, 'agent'), parsed];
}

/** A mode `connection` (one of `adapter`'s) starts its sessions in: never one that never asks. */
function parseStartMode(
  value: unknown,
  catalog: Catalog,
  adapter: AdapterId,
  connection: string,
): SessionMode {
  const mode = parseMode(value);
  if (!isStartMode(catalog, adapter, connection, mode)) {
    throw new TypeError(`Expected a mode ${connection} sessions start in`);
  }
  return mode;
}

export function parseSendArgs(args: unknown[]): IpcArgs<'session:send'> {
  const [agentId, message] = expect(args, 2, 'an agent and a message');
  const { id, text, images, origin, task } = record(message, 'the message', [
    'id',
    'text',
    'images',
    'origin',
    'task',
  ]);
  if (origin !== undefined && origin !== 'queue') throw new TypeError('Expected a queue origin');
  let taskMessage;
  if (task !== undefined) {
    if (origin !== 'queue') throw new TypeError('Expected a queue origin for the task');
    const fields = record(task, 'the task', ['agent', 'item', 'attempt']);
    taskMessage = {
      agent: parseId(fields.agent, 'agent', MAX_NODE_ID),
      item: parseId(fields.item, 'item', MAX_NODE_ID),
      attempt: parseId(fields.attempt, 'attempt'),
    };
  }
  const pasted = images === undefined ? [] : parseImages(images);
  // A message may be only an image.
  if (typeof text !== 'string' || (text.trim() === '' && pasted.length === 0)) {
    throw new TypeError('Expected the message to have text');
  }
  if (text.length > MAX_MESSAGE_LENGTH) throw new RangeError('The message is too long');
  const parsed: UserMessage = {
    id: parseId(id, 'message'),
    text,
    ...(origin === undefined ? {} : { origin }),
    ...(taskMessage === undefined ? {} : { task: taskMessage }),
    ...(pasted.length === 0 ? {} : { images: pasted }),
  };
  return [parseId(agentId, 'agent'), parsed];
}

/** The longest base64 an image of the largest size takes. */
const MAX_IMAGE_BASE64 = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** Images pasted into a message: a few, of the kinds Claude reads, base64-encoded, not too large. */
function parseImages(value: unknown): MessageImage[] {
  if (!Array.isArray(value) || value.length > MAX_IMAGES) {
    throw new TypeError(`Expected at most ${String(MAX_IMAGES)} images`);
  }
  const images = value.map((image): MessageImage => {
    const { mediaType, data } = record(image, 'an image', ['mediaType', 'data']);
    if (
      typeof data !== 'string' ||
      data.length === 0 ||
      data.length % 4 !== 0 ||
      !BASE64.test(data)
    ) {
      throw new TypeError('Expected an image, base64-encoded');
    }
    if (data.length > MAX_IMAGE_BASE64) throw new RangeError('The image is too large');
    return { mediaType: oneOf(mediaType, IMAGE_TYPES, 'kind of image'), data };
  });
  const bytes = images.reduce((sum, { data }) => sum + imageBytes(data), 0);
  if (bytes > MAX_IMAGE_TOTAL) throw new RangeError('The images are too large together');
  return images;
}

export function parseAnswerArgs(args: unknown[]): IpcArgs<'session:answer'> {
  const [agentId, promptId, answer] = expect(args, 3, 'an agent, a prompt and an answer');
  return [parseId(agentId, 'agent'), parseId(promptId, 'prompt'), parseAnswer(answer)];
}

/** session:options: one of the adapters the catalog lists. */
export function parseOptionsArgs(args: unknown[], catalog: Catalog): IpcArgs<'session:options'> {
  const [adapter] = expect(args, 1, 'an adapter');
  return [parseAdapter(adapter, catalog)];
}

/** For channels that take only the agent: session:interrupt and session:close. */
export function parseAgentArgs(args: unknown[]): [agentId: string] {
  const [agentId] = expect(args, 1, 'an agent');
  return [parseId(agentId, 'agent')];
}

/** session:fresh: which adapter's remembered conversation the agent should replace. */
export function parseFreshArgs(args: unknown[], catalog: Catalog): IpcArgs<'session:fresh'> {
  const [agentId, adapter] = expect(args, 2, 'an agent and an adapter');
  return [parseId(agentId, 'agent'), parseAdapter(adapter, catalog)];
}

/** One of the adapters the catalog lists. */
function parseAdapter(value: unknown, catalog: Catalog): AdapterId {
  const found = adapterIn(catalog, typeof value === 'string' ? value : '');
  if (!found) {
    throw new TypeError(`Expected an adapter: ${catalog.adapters.map((a) => a.id).join(', ')}`);
  }
  return found.id;
}

/** session:resume: an agent, and the id of a conversation (main opens it only if it listed it). */
export function parseResumeArgs(args: unknown[]): IpcArgs<'session:resume'> {
  const [agentId, sessionId] = expect(args, 2, 'an agent and a conversation');
  if (!isNativeId(sessionId)) {
    throw new TypeError("Expected the conversation's id");
  }
  return [parseId(agentId, 'agent'), sessionId];
}

/** session:rewind-preview: an agent, and one of its messages. */
export function parseRewindPreviewArgs(args: unknown[]): IpcArgs<'session:rewind-preview'> {
  const [agentId, messageId] = expect(args, 2, 'an agent and a message');
  return [parseId(agentId, 'agent'), parseId(messageId, 'message')];
}

/** session:rewind: an agent, one of its messages, and what to restore to before it. */
export function parseRewindArgs(args: unknown[]): IpcArgs<'session:rewind'> {
  const [agentId, messageId, restore] = expect(args, 3, 'an agent, a message and what to restore');
  return [
    parseId(agentId, 'agent'),
    parseId(messageId, 'message'),
    oneOf(restore, REWIND_RESTORES, 'thing to restore'),
  ];
}

/** session:mcp-change: an agent, one of its MCP servers by name, and what to do to it. */
export function parseMcpChangeArgs(args: unknown[]): IpcArgs<'session:mcp-change'> {
  const [agentId, server, change] = expect(args, 3, 'an agent, an MCP server and a change');
  if (
    typeof server !== 'string' ||
    server === '' ||
    server.length > MAX_MCP_NAME_LENGTH ||
    /\p{Cc}/u.test(server)
  ) {
    throw new TypeError('Expected the MCP server’s name');
  }
  return [parseId(agentId, 'agent'), server, oneOf(change, MCP_CHANGES, 'change to an MCP server')];
}

export function parseModeArgs(args: unknown[]): IpcArgs<'session:mode'> {
  const [agentId, mode] = expect(args, 2, 'an agent and a mode');
  return [parseId(agentId, 'agent'), parseMode(mode)];
}

export function parseModelArgs(args: unknown[]): IpcArgs<'session:model'> {
  const [agentId, model] = expect(args, 2, 'an agent and a model');
  return [parseId(agentId, 'agent'), parseModel(model)];
}

/** session:effort: an agent, and a reasoning effort (null: its model's default). */
export function parseEffortArgs(args: unknown[]): IpcArgs<'session:effort'> {
  const [agentId, effort] = expect(args, 2, 'an agent and a reasoning effort');
  return [parseId(agentId, 'agent'), parseEffort(effort)];
}

/** session:stopTask: an agent, and the id of a task its session runs (main checks it does). */
export function parseStopTaskArgs(args: unknown[]): IpcArgs<'session:stopTask'> {
  const [agentId, taskId] = expect(args, 2, 'an agent and a task');
  return [parseId(agentId, 'agent'), parseId(taskId, 'task')];
}

function parseAnswer(value: unknown): SessionAnswer {
  const kind = isRecord(value) ? value.kind : undefined;
  switch (kind) {
    case 'permission': {
      const { answer, feedback } = record(value, 'the answer', ['kind', 'answer', 'feedback']);
      const given = oneOf(answer, ['once', 'always', 'deny'] as const, 'permission answer');
      if (feedback === undefined) return { kind, answer: given };
      // "No, and tell Claude what to do differently".
      if (typeof feedback !== 'string' || feedback.length > MAX_ANSWER_LENGTH) {
        throw new TypeError('Expected what to do instead, as text');
      }
      if (given !== 'deny') throw new TypeError('What to do instead goes only with a no');
      return { kind, answer: given, feedback };
    }
    case 'question': {
      const { answers } = record(value, 'the answer', ['kind', 'answers']);
      if (
        !Array.isArray(answers) ||
        answers.length === 0 ||
        answers.length > MAX_QUESTIONS ||
        !answers.every((a): a is string => typeof a === 'string' && a.length <= MAX_ANSWER_LENGTH)
      ) {
        throw new TypeError('Expected an answer to each question');
      }
      return { kind, answers: [...answers] };
    }
    case 'plan': {
      const { answer } = record(value, 'the answer', ['kind', 'answer']);
      return { kind, answer: parsePlanAnswer(answer) };
    }
    case 'elicitation': {
      const { action, values } = record(value, 'the answer', ['kind', 'action', 'values']);
      const parsed = oneOf(action, ELICITATION_ACTIONS, 'answer to an MCP server');
      return values === undefined
        ? { kind, action: parsed }
        : { kind, action: parsed, values: parseFormValues(values) };
    }
    default:
      throw new TypeError('Expected a permission, question, plan or MCP server answer');
  }
}

/**
 * A form's values, by field: text, numbers, yes or no, or choices, within the limits. Whether they
 * are what the form asks is the session's to check (it has the form).
 */
function parseFormValues(value: unknown): Record<string, FormValue> {
  const fail = () => new TypeError('Expected the form’s values');
  if (!isRecord(value)) throw fail();
  const entries = Object.entries(value);
  if (entries.length > MAX_FORM_FIELDS) throw fail();
  const text = (item: unknown): item is string =>
    typeof item === 'string' && item.length <= MAX_ANSWER_LENGTH;
  return Object.fromEntries(
    entries.map(([name, given]): [string, FormValue] => {
      if (name === '' || name.length > MAX_ID_LENGTH) throw fail();
      if (text(given) || typeof given === 'boolean') return [name, given];
      if (typeof given === 'number' && Number.isFinite(given)) return [name, given];
      if (Array.isArray(given) && given.length <= MAX_FORM_FIELDS && given.every(text)) {
        return [name, [...given]];
      }
      throw fail();
    }),
  );
}

function parsePlanAnswer(value: unknown): PlanAnswer {
  if (isRecord(value) && value.approve === true) {
    const { mode } = record(value, 'the plan answer', ['approve', 'mode']);
    return { approve: true, mode: oneOf(mode, PLAN_MODES, 'mode to carry out the plan in') };
  }
  const { approve, feedback } = record(value, 'the plan answer', ['approve', 'feedback']);
  if (approve !== false || typeof feedback !== 'string' || feedback.length > MAX_ANSWER_LENGTH) {
    throw new TypeError('Expected the plan approved, or what to change in it');
  }
  return { approve: false, feedback };
}

/** Any adapter's mode: the manager checks it is one of the running session's adapter. */
function parseMode(value: unknown): SessionMode {
  return oneOf<SessionMode>(value, [...PERMISSION_MODES, ...CODEX_MODES], 'mode');
}

/** A reasoning effort ('high'), or null for the model's default. */
function parseEffort(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !EFFORT_PATTERN.test(value)) {
    throw new TypeError('Expected a reasoning effort');
  }
  return value;
}

function parseModel(value: unknown): string {
  if (typeof value !== 'string' || !MODEL_PATTERN.test(value)) {
    throw new TypeError('Expected a model');
  }
  return value;
}

/** An id the renderer gives an agent, a message or a prompt: short, non-empty text. */
function parseId(value: unknown, what: string, max = MAX_ID_LENGTH): string {
  if (typeof value !== 'string' || value === '' || value.length > max) {
    throw new TypeError(`Expected the ${what}'s id`);
  }
  return value;
}

function expect(args: unknown[], count: number, what: string): unknown[] {
  if (args.length !== count) throw new TypeError(`Expected ${what}`);
  return args;
}

/** `value` as an object with only the keys `keys` (any of them may be missing). */
function record(value: unknown, what: string, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value) || !Object.keys(value).every((key) => keys.includes(key))) {
    throw new TypeError(`Expected ${what}`);
  }
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], what: string): T {
  const found = allowed.find((one) => one === value);
  if (found === undefined) throw new TypeError(`Expected a ${what}: ${allowed.join(', ')}`);
  return found;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
