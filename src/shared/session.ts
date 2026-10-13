/*
 * Connected sessions: an agent's session run by the main process (Claude Code in a terminal, or
 * through the Agent SDK), what the renderer asks of it, and what main tells it back. Main's
 * connectors (src/main/sessions/) turn their CLI's own output into these events; the renderer's
 * connected driver (src/renderer/agent/connected.ts) plays them onto the session its view shows
 * (src/renderer/agent/session.ts).
 *
 * Keep this module free of Node, Electron and DOM imports: it is compiled into every process.
 */

/** How a Claude agent can be connected, besides simulated: the CLI in a terminal, or the Agent SDK. */
export const CONNECTIONS = ['terminal', 'sdk'] as const;
export type Connection = (typeof CONNECTIONS)[number];

/**
 * Claude Code's permission modes, by its settings' names, in the order Shift+Tab cycles them.
 * 'manual' is what the CLI also calls 'default'.
 */
export const PERMISSION_MODES = [
  'manual',
  'acceptEdits',
  'plan',
  'bypassPermissions',
  'auto',
] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export type ToolStatus = 'running' | 'done' | 'failed' | 'interrupted';

export interface DiffLine {
  kind: 'add' | 'remove' | 'same';
  text: string;
}

/** What a tool call shows when opened: an edit's diff, or a command's output. */
export type ToolDetail =
  | { kind: 'diff'; added: number; removed: number; lines: DiffLine[] }
  | { kind: 'output'; text: string };

export interface Todo {
  text: string;
  status: 'pending' | 'active' | 'done';
}

/** A model a session offers: what the CLI calls it, and how the model picker shows it. */
export interface ModelChoice {
  value: string;
  label: string;
  description?: string;
}

/** How a session is started. Main picks the folder (the canvas's project) and what it resumes. */
export interface SessionOptions {
  connection: Connection;
  /** The model to start with (a value its models gave before), or null for the CLI's default. */
  model: string | null;
  mode: PermissionMode;
}

/** A message the user sends: its id (the turn it starts ends naming it) and its text. */
export interface UserMessage {
  id: string;
  text: string;
}

/** A question the agent asks the user (Claude Code's AskUserQuestion), with answers to pick from. */
export interface AskedQuestion {
  /** A short name for it, as a chip shows it. */
  header: string;
  text: string;
  options: { label: string; description: string }[];
  /** Whether several answers may be picked: they are given joined with ", ". */
  multiple: boolean;
}

/** The modes a plan can be carried out in once approved, as Claude Code offers them. */
export const PLAN_MODES = ['auto', 'acceptEdits', 'manual'] as const;
export type PlanMode = (typeof PLAN_MODES)[number];

/** How the user answers a plan: go ahead in a mode; or keep planning, saying what to change. */
export type PlanAnswer = { approve: true; mode: PlanMode } | { approve: false; feedback: string };

/** The user's answer to a prompt a session showed. */
export type SessionAnswer =
  | { kind: 'permission'; answer: 'once' | 'always' | 'deny' }
  /** An answer to each of the questions asked, in order. */
  | { kind: 'question'; answers: string[] }
  | { kind: 'plan'; answer: PlanAnswer };

/** What a session has used: null where its CLI has not said. */
export interface SessionUsage {
  /** Its cost so far, in US dollars: an estimate when the user is on a subscription. */
  costUsd: number | null;
  /** Tokens in its context window now, and the window's size. */
  contextTokens: number | null;
  contextWindow: number | null;
}

/**
 * What happened in a connected session.
 *
 * A turn starts with the user's message ('user': one the renderer sent, echoed with its id, or one
 * typed straight into a terminal, told as soon as it is known) and ends with exactly one 'end',
 * naming the messages it answered (none, for a turn the CLI started by itself, as when a background
 * task reports back).
 * In between the session is working, or waiting on the user while a prompt ('permission',
 * 'question', 'plan') is open. Entries are by id: the first event with an id adds the entry, later
 * ones stream more text into it ('text', 'thinking') or replace it ('tool', 'todos'). `parent` is
 * the Agent tool call a subagent's entry belongs to.
 */
export type SessionEvent =
  /** The session runs (started, or resumed): its model and mode, and the models it offers. */
  | { type: 'started'; model: string | null; mode: PermissionMode; models: ModelChoice[] }
  | { type: 'user'; id: string; text: string }
  | { type: 'status'; status: 'working' | 'waiting' }
  | { type: 'text'; id: string; text: string; parent?: string }
  | { type: 'thinking'; id: string; text: string; parent?: string }
  | {
      type: 'tool';
      id: string;
      tool: string;
      /** What it acts on: a file, a command, a pattern. */
      summary: string;
      status: ToolStatus;
      detail?: ToolDetail;
      parent?: string;
    }
  | { type: 'todos'; id: string; items: Todo[] }
  /**
   * It asks before running a tool. `always`: what answering "always" allows, as the CLI words it,
   * or null where it offers no "always".
   */
  | {
      type: 'permission';
      id: string;
      tool: string;
      summary: string;
      detail?: ToolDetail;
      always: string | null;
    }
  | { type: 'question'; id: string; questions: AskedQuestion[] }
  /** Plan mode's plan (Markdown), for the user to approve. */
  | { type: 'plan'; id: string; plan: string }
  /** A prompt no longer waits for the user: its turn was interrupted, or it was answered elsewhere. */
  | { type: 'withdrawn'; id: string }
  /** Something to tell the user: compaction, a retry, a usage limit and when it resets, a login problem. */
  | { type: 'notice'; id: string; level: 'info' | 'warning' | 'error'; text: string }
  | { type: 'usage'; usage: SessionUsage }
  | { type: 'mode'; mode: PermissionMode }
  | { type: 'model'; model: string }
  /** The turn ended: interrupted by the user, or failed (an API error, a usage limit). */
  | { type: 'end'; messages: string[]; seconds: number; interrupted: boolean; failed: boolean }
  /**
   * The session stopped: its process exited, or main closed it (for another canvas or project).
   * `error` says why, when it failed. The next message starts it again, resuming it.
   */
  | { type: 'closed'; error?: string };

/** The longest id the renderer may give an agent, a message or a prompt. */
export const MAX_ID_LENGTH = 200;
/** The longest message the renderer may send, in characters. */
export const MAX_MESSAGE_LENGTH = 200_000;
/** The longest answer to a question or a plan. */
export const MAX_ANSWER_LENGTH = 20_000;
/** At most this many questions in one prompt (Claude Code asks 1 to 4). */
export const MAX_QUESTIONS = 4;
/** What a model's value may look like: an alias ('opus'), an id, or a provider's id or ARN. */
export const MODEL_PATTERN = /^[\w.:/@[\]-]{1,200}$/;
