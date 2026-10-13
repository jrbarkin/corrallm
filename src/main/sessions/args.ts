import type { IpcArgs } from '../../shared/ipc';
import { MAX_TERMINAL_COLS, MAX_TERMINAL_INPUT, MAX_TERMINAL_ROWS } from '../../shared/terminal';
import {
  CONNECTIONS,
  MAX_ANSWER_LENGTH,
  MAX_ID_LENGTH,
  MAX_MESSAGE_LENGTH,
  MAX_QUESTIONS,
  MODEL_PATTERN,
  PERMISSION_MODES,
  PLAN_MODES,
} from '../../shared/session';
import type {
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
  const { id, text } = record(message, 'the message', ['id', 'text']);
  if (typeof text !== 'string' || text.trim() === '') {
    throw new TypeError('Expected the message to have text');
  }
  if (text.length > MAX_MESSAGE_LENGTH) throw new RangeError('The message is too long');
  const parsed: UserMessage = { id: parseId(id, 'message'), text };
  return [parseId(agentId, 'agent'), parsed];
}

export function parseAnswerArgs(args: unknown[]): IpcArgs<'session:answer'> {
  const [agentId, promptId, answer] = expect(args, 3, 'an agent, a prompt and an answer');
  return [parseId(agentId, 'agent'), parseId(promptId, 'prompt'), parseAnswer(answer)];
}

/** For channels that take only the agent: session:interrupt, session:close, terminal:attach and terminal:detach. */
export function parseAgentArgs(args: unknown[]): [agentId: string] {
  const [agentId] = expect(args, 1, 'an agent');
  return [parseId(agentId, 'agent')];
}

/** terminal:input: an agent, and the keystrokes typed (any characters: they are keys). */
export function parseTerminalInputArgs(args: unknown[]): IpcArgs<'terminal:input'> {
  const [agentId, data] = expect(args, 2, 'an agent and what was typed');
  if (typeof data !== 'string' || data === '' || data.length > MAX_TERMINAL_INPUT) {
    throw new TypeError('Expected what was typed');
  }
  return [parseId(agentId, 'agent'), data];
}

/** terminal:resize: an agent, and its terminal's columns and rows. */
export function parseTerminalResizeArgs(args: unknown[]): IpcArgs<'terminal:resize'> {
  const [agentId, cols, rows] = expect(args, 3, 'an agent and a size');
  const count = (value: unknown, max: number) => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) {
      throw new TypeError(
        `Expected a terminal size of up to ${String(MAX_TERMINAL_COLS)}×${String(MAX_TERMINAL_ROWS)}`,
      );
    }
    return value;
  };
  return [
    parseId(agentId, 'agent'),
    count(cols, MAX_TERMINAL_COLS),
    count(rows, MAX_TERMINAL_ROWS),
  ];
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
