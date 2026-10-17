import { MAX_ANSWER_LENGTH, MAX_MESSAGE_LENGTH } from '../../shared/session';
import type { Message } from '../../shared/messages';
import { isSessionId } from '../sessions/id';

/*
 * corrallm's API: each operation defined once (its name, what it does, its arguments as MCP lists
 * them, who may see it), so every transport serves the same ones. MCP serves them as tools
 * (mcp.ts), listed to each client by the scope its token gives it; the one command line, `corrallm
 * wait`, calls the one an MCP client can't wait on itself. What they do is an Api: the dev host's
 * (src/main/host/), and later the app's.
 */

/**
 * Who a client is to the API, by its token: an agent corrallm runs, a lead (an agent you let manage
 * corrallm), or an orchestrator outside corrallm (Claude Code in a terminal) you gave a token.
 */
export type Scope = 'agent' | 'lead' | 'outside';

/** A JSON Schema, as MCP lists a tool's arguments. */
export type JsonSchema = Readonly<Record<string, unknown>>;

export interface Operation<A> {
  name: string;
  description: string;
  input: JsonSchema;
  /** Who it is listed to (and who may call it). */
  scopes: readonly Scope[];
  /** Whether MCP lists it: not what only the command line calls (wait). */
  listed: boolean;
  /** Its arguments, from what a client sent: throws an ArgumentError saying what is wrong. */
  parse(args: unknown): A;
}

/** Arguments a client sent that the operation can't take. */
export class ArgumentError extends Error {}

export interface MessageArgs {
  /** The agent it is for, by name. */
  to: string;
  body: string;
  /** The message it answers, if any. */
  replyTo?: string;
}

export interface ReplyArgs {
  /** The message it answers. */
  to: string;
  /** What was chosen, of the message's choices (several where it allows that). */
  choices?: string[];
  /** What was said: a free answer, or what to do instead. */
  text?: string;
}

export interface WaitArgs {
  /** Only what belongs to that message: answers to it, and what its turn asks. */
  for?: string;
  /** How long to wait before giving up (and returning nothing). */
  timeoutSeconds: number;
}

/** How an agent stands, as status says. */
export interface AgentStatus {
  name: string;
  state: 'idle' | 'working' | 'asking' | 'stopped';
  model: string | null;
  effort: string | null;
  /** Its CLI's conversation (Codex's thread), once it has one. */
  thread: string | null;
  /** The message it works on, or asks about. */
  current: string | null;
}

export interface Status {
  agents: AgentStatus[];
  /** What waits for the caller: messages to it not answered yet. */
  pending: Message[];
}

/** What the operations do, for a caller (`from`: its name, from its token). */
export interface Api {
  message(from: string, args: MessageArgs): Promise<{ id: string }>;
  reply(from: string, args: ReplyArgs): Promise<{ id: string }>;
  status(from: string): Promise<Status>;
  wait(from: string, args: WaitArgs, signal: AbortSignal): Promise<Message | null>;
}

/** An agent's name: letters, digits and . _ -. */
const NAME = /^[\w.-]{1,64}$/;
const MAX_CHOICES = 20;
const MAX_CHOICE = 200;
const MAX_WAIT_SECONDS = 3600;
const DEFAULT_WAIT_SECONDS = 600;

export const OPERATIONS = {
  message: {
    name: 'message',
    description:
      'Send a message to another agent. It returns at once with the message’s id; the agent ' +
      'takes it as a turn once it is free, and its reply comes back to you as a message.',
    input: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'The agent it is for, by name.' },
        body: { type: 'string', description: 'What to say.' },
        replyTo: { type: 'string', description: 'The id of the message it answers, if any.' },
      },
      required: ['to', 'body'],
      additionalProperties: false,
    },
    scopes: ['agent', 'lead', 'outside'],
    listed: true,
    parse: (args): MessageArgs => {
      const value = object(args, ['to', 'body', 'replyTo']);
      return {
        to: name(value.to, 'to'),
        body: text(value.body, 'body', MAX_MESSAGE_LENGTH, true),
        ...(value.replyTo === undefined ? {} : { replyTo: id(value.replyTo, 'replyTo') }),
      };
    },
  },
  reply: {
    name: 'reply',
    description:
      'Answer a message to you: a question (with its choices, or in your own words), an ' +
      'approval an agent’s CLI asked for (approve, always or deny, with what to do instead), or ' +
      'an agent’s reply, as a follow-up in its conversation.',
    input: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'The id of the message you answer.' },
        choices: {
          type: 'array',
          items: { type: 'string' },
          description: 'The values of the choices you pick, of those it offers.',
        },
        text: { type: 'string', description: 'What you say: an answer, or what to do instead.' },
      },
      required: ['to'],
      additionalProperties: false,
    },
    scopes: ['agent', 'lead', 'outside'],
    listed: true,
    parse: (args): ReplyArgs => {
      const value = object(args, ['to', 'choices', 'text']);
      if (value.choices === undefined && value.text === undefined) {
        throw new ArgumentError('Answer with choices, text, or both.');
      }
      return {
        to: id(value.to, 'to'),
        ...(value.choices === undefined ? {} : { choices: choices(value.choices) }),
        ...(value.text === undefined
          ? {}
          : { text: text(value.text, 'text', MAX_ANSWER_LENGTH, false) }),
      };
    },
  },
  status: {
    name: 'status',
    description:
      'How each agent stands (idle, working, asking), and the messages to you not answered yet.',
    input: { type: 'object', properties: {}, additionalProperties: false },
    scopes: ['lead', 'outside'],
    listed: true,
    parse: (args): Record<string, never> => {
      object(args, []);
      return {};
    },
  },
  wait: {
    name: 'wait',
    description:
      'Wait until a message to you arrives (a question, an approval, an agent’s reply), and ' +
      'return it; nothing if none came in time. For the command line: an MCP client is told.',
    input: {
      type: 'object',
      properties: {
        for: { type: 'string', description: 'Only what belongs to that message.' },
        timeoutSeconds: { type: 'number', description: 'How long to wait (at most 3600).' },
      },
      additionalProperties: false,
    },
    scopes: ['outside'],
    listed: false,
    parse: (args): WaitArgs => {
      const value = object(args, ['for', 'timeoutSeconds']);
      const seconds = value.timeoutSeconds ?? DEFAULT_WAIT_SECONDS;
      if (
        typeof seconds !== 'number' ||
        !Number.isFinite(seconds) ||
        seconds <= 0 ||
        seconds > MAX_WAIT_SECONDS
      ) {
        throw new ArgumentError(
          `timeoutSeconds is a number of seconds, up to ${String(MAX_WAIT_SECONDS)}.`,
        );
      }
      return {
        ...(value.for === undefined ? {} : { for: id(value.for, 'for') }),
        timeoutSeconds: seconds,
      };
    },
  },
} as const satisfies {
  message: Operation<MessageArgs>;
  reply: Operation<ReplyArgs>;
  status: Operation<Record<string, never>>;
  wait: Operation<WaitArgs>;
};

export type OperationName = keyof typeof OPERATIONS;

/** The operations listed (and callable) for a scope. */
export function operationsFor(scope: Scope): Operation<unknown>[] {
  return Object.values(OPERATIONS).filter((operation) =>
    (operation.scopes as readonly Scope[]).includes(scope),
  );
}

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ArgumentError('The arguments are an object.');
  }
  const unknown = Object.keys(value).find((key) => !keys.includes(key));
  if (unknown !== undefined) throw new ArgumentError(`It takes no ${unknown}.`);
  return value as Record<string, unknown>;
}

function name(value: unknown, what: string): string {
  if (typeof value !== 'string' || !NAME.test(value)) {
    throw new ArgumentError(`${what} is an agent's name.`);
  }
  return value;
}

function id(value: unknown, what: string): string {
  if (!isSessionId(value)) throw new ArgumentError(`${what} is a message's id.`);
  return value;
}

function text(value: unknown, what: string, max: number, required: boolean): string {
  if (typeof value !== 'string' || (required && value.trim() === '') || value.length > max) {
    throw new ArgumentError(`${what} is text, up to ${String(max)} characters.`);
  }
  return value;
}

function choices(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_CHOICES ||
    !value.every(
      (choice) => typeof choice === 'string' && choice !== '' && choice.length <= MAX_CHOICE,
    )
  ) {
    throw new ArgumentError('choices is a list of the values it offers.');
  }
  return value as string[];
}
