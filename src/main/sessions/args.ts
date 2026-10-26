import type { IpcArgs } from '../../shared/ipc';
import {
  CODEX_MODES,
  ELICITATION_ACTIONS,
  EFFORT_PATTERN,
  MAX_ANSWER_LENGTH,
  MAX_ID_LENGTH,
  MAX_FORM_FIELDS,
  MAX_QUESTIONS,
  MODEL_PATTERN,
  PERMISSION_MODES,
  PLAN_MODES,
} from '../../shared/session';
import type { FormValue, PlanAnswer, SessionAnswer, SessionMode } from '../../shared/session';

/*
 * Parsers for the session:* channels' arguments, which come from an untrusted renderer: each
 * checks every value (type, length, allowed values) and builds the contract's tuple afresh, or
 * throws. Nothing the renderer sent is passed on as it came.
 */

export function parseAnswerArgs(args: unknown[]): IpcArgs<'session:answer'> {
  const [agentId, promptId, answer] = expect(args, 3, 'an agent, a prompt and an answer');
  return [parseId(agentId, 'agent'), parseId(promptId, 'prompt'), parseAnswer(answer)];
}

/** For channels that take only the agent: session:interrupt and session:availability. */
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
