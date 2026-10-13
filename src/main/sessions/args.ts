import type { IpcArgs } from '../../shared/ipc';
import {
  CONNECTIONS,
  IMAGE_TYPES,
  MAX_ANSWER_LENGTH,
  MAX_FILE_QUERY_LENGTH,
  MAX_ID_LENGTH,
  MAX_IMAGE_BYTES,
  MAX_IMAGES,
  MAX_MESSAGE_LENGTH,
  MAX_QUESTIONS,
  MODEL_PATTERN,
  PERMISSION_MODES,
  PLAN_MODES,
} from '../../shared/session';
import type {
  MessageImage,
  PermissionMode,
  PlanAnswer,
  SessionAnswer,
  SessionOptions,
  UserMessage,
} from '../../shared/session';

/*
 * Parsers for the session:* channels' arguments, which come from an untrusted renderer: each
 * checks every value (type, length, allowed values) and builds the contract's tuple afresh, or
 * throws. Nothing the renderer sent is passed on as it came.
 */

export function parseStartArgs(args: unknown[]): IpcArgs<'session:start'> {
  const [agentId, options] = expect(args, 2, 'an agent and how to start its session');
  const { connection, model, mode } = record(options, 'the session options', [
    'connection',
    'model',
    'mode',
  ]);
  const parsed: SessionOptions = {
    connection: oneOf(connection, CONNECTIONS, 'connection'),
    model: model === null ? null : parseModel(model),
    mode: parseMode(mode),
  };
  return [parseId(agentId, 'agent'), parsed];
}

export function parseSendArgs(args: unknown[]): IpcArgs<'session:send'> {
  const [agentId, message] = expect(args, 2, 'an agent and a message');
  const { id, text, images } = record(message, 'the message', ['id', 'text', 'images']);
  const pasted = images === undefined ? [] : parseImages(images);
  // A message may be only an image.
  if (typeof text !== 'string' || (text.trim() === '' && pasted.length === 0)) {
    throw new TypeError('Expected the message to have text');
  }
  if (text.length > MAX_MESSAGE_LENGTH) throw new RangeError('The message is too long');
  const parsed: UserMessage = {
    id: parseId(id, 'message'),
    text,
    ...(pasted.length === 0 ? {} : { images: pasted }),
  };
  return [parseId(agentId, 'agent'), parsed];
}

/** project:files: what to search the project folder's files for. */
export function parseFilesArgs(args: unknown[]): IpcArgs<'project:files'> {
  const [query] = expect(args, 1, 'what to search for');
  if (typeof query !== 'string' || query.length > MAX_FILE_QUERY_LENGTH) {
    throw new TypeError('Expected what to search for');
  }
  return [query];
}

/** The longest base64 an image of the largest size takes. */
const MAX_IMAGE_BASE64 = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** Images pasted into a message: a few, of the kinds Claude reads, base64-encoded, not too large. */
function parseImages(value: unknown): MessageImage[] {
  if (!Array.isArray(value) || value.length > MAX_IMAGES) {
    throw new TypeError(`Expected at most ${String(MAX_IMAGES)} images`);
  }
  return value.map((image): MessageImage => {
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
}

export function parseAnswerArgs(args: unknown[]): IpcArgs<'session:answer'> {
  const [agentId, promptId, answer] = expect(args, 3, 'an agent, a prompt and an answer');
  return [parseId(agentId, 'agent'), parseId(promptId, 'prompt'), parseAnswer(answer)];
}

/** For channels that take only the agent: session:interrupt, session:close. */
export function parseAgentArgs(args: unknown[]): [agentId: string] {
  const [agentId] = expect(args, 1, 'an agent');
  return [parseId(agentId, 'agent')];
}

export function parseModeArgs(args: unknown[]): IpcArgs<'session:mode'> {
  const [agentId, mode] = expect(args, 2, 'an agent and a mode');
  return [parseId(agentId, 'agent'), parseMode(mode)];
}

export function parseModelArgs(args: unknown[]): IpcArgs<'session:model'> {
  const [agentId, model] = expect(args, 2, 'an agent and a model');
  return [parseId(agentId, 'agent'), parseModel(model)];
}

function parseAnswer(value: unknown): SessionAnswer {
  const kind = isRecord(value) ? value.kind : undefined;
  switch (kind) {
    case 'permission': {
      const { answer } = record(value, 'the answer', ['kind', 'answer']);
      return {
        kind,
        answer: oneOf(answer, ['once', 'always', 'deny'] as const, 'permission answer'),
      };
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
    default:
      throw new TypeError('Expected a permission, question or plan answer');
  }
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

function parseMode(value: unknown): PermissionMode {
  return oneOf(value, PERMISSION_MODES, 'mode');
}

function parseModel(value: unknown): string {
  if (typeof value !== 'string' || !MODEL_PATTERN.test(value)) {
    throw new TypeError('Expected a model');
  }
  return value;
}

/** An id the renderer gives an agent, a message or a prompt: short, non-empty text. */
function parseId(value: unknown, what: string): string {
  if (typeof value !== 'string' || value === '' || value.length > MAX_ID_LENGTH) {
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
