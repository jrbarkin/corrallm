/*
 * Connected sessions: an agent's session run by the main process (Claude Code or Codex, in a
 * terminal or through a structured interface), what the renderer asks of it, and what main tells
 * it back. Main's connectors (src/main/sessions/) turn their CLI's own output into these events;
 * the renderer's connected driver (src/renderer/agent/connected.ts) plays them onto the session its
 * view shows (src/renderer/agent/session.ts).
 *
 * Keep this module free of Node, Electron and DOM imports: it is compiled into every process.
 */

/** The CLIs agents can be connected to: Claude Code and Codex. */
export const CLIS = ['claude', 'codex'] as const;
export type Cli = (typeof CLIS)[number];

/**
 * How an agent can be connected, besides simulated: each names what runs its session. Claude Code
 * in a terminal ('terminal') or through the Agent SDK ('sdk'); Codex in a terminal
 * ('codex-terminal') or through its app server ('app-server', JSON-RPC over stdio).
 */
export const CONNECTIONS = ['terminal', 'sdk', 'codex-terminal', 'app-server'] as const;
export type Connection = (typeof CONNECTIONS)[number];

/** The CLI each connection runs. */
export const CONNECTION_CLI: Readonly<Record<Connection, Cli>> = {
  terminal: 'claude',
  sdk: 'claude',
  'codex-terminal': 'codex',
  'app-server': 'codex',
};

/**
 * The connections whose view is their CLI's own terminal (src/shared/terminal.ts), rather than
 * corrallm's transcript and composer.
 */
export const TERMINAL_CONNECTIONS: readonly Connection[] = ['terminal', 'codex-terminal'];

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

/**
 * Codex's modes: its permission presets (what its /permissions offers, by their ids in its source,
 * codex-rs/utils/approval-presets), then plan mode. 'read-only': a read-only sandbox, asking before
 * anything more; 'auto' (Codex's Default): edits and commands in a sandbox of the project folder,
 * asking before leaving it; 'full-access': no sandbox and never asking; 'plan': Codex's plan
 * collaboration mode, which explores and proposes a plan before changing anything (with Default's
 * permissions).
 */
export const CODEX_MODES = ['read-only', 'auto', 'full-access', 'plan'] as const;
export type CodexMode = (typeof CODEX_MODES)[number];

/** A session's mode: one of its CLI's. */
export type SessionMode = PermissionMode | CodexMode;

/** Each CLI's modes. */
export const CLI_MODES: {
  readonly claude: readonly PermissionMode[];
  readonly codex: readonly CodexMode[];
} = {
  claude: PERMISSION_MODES,
  codex: CODEX_MODES,
};

/** The mode each CLI starts in unless told otherwise: Claude Code's Manual, Codex's Default. */
export const DEFAULT_MODES: { readonly claude: PermissionMode; readonly codex: CodexMode } = {
  claude: 'manual',
  codex: 'auto',
};

/** Whether `mode` is one of Claude Code's permission modes. */
export function isPermissionMode(mode: SessionMode): mode is PermissionMode {
  return (PERMISSION_MODES as readonly SessionMode[]).includes(mode);
}

/** Whether `mode` is one of `cli`'s modes. */
export function isModeOf(cli: Cli, mode: SessionMode): boolean {
  return (CLI_MODES[cli] as readonly SessionMode[]).includes(mode);
}

/** `mode` if it is one of `cli`'s, else the mode `cli` starts in. */
export function modeFor(cli: Cli, mode: SessionMode): SessionMode {
  return isModeOf(cli, mode) ? mode : DEFAULT_MODES[cli];
}

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
  /** One of its connection's CLI's modes. */
  mode: SessionMode;
}

/** The kinds of image the user can paste into a message (those Claude reads). */
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];

/** An image the user pasted into a message: its kind, and its bytes, base64-encoded. */
export interface MessageImage {
  mediaType: ImageType;
  data: string;
}

/**
 * A message the user sends: its id (the turn it starts ends naming it), its text, and the images
 * pasted into it, if any (only connected sessions see them).
 */
export interface UserMessage {
  id: string;
  text: string;
  images?: MessageImage[];
}

/**
 * A slash command a session offers (Claude Code's own, the user's and the project's commands and
 * skills, MCP prompts), as the composer completes it: typed as `/name`, then what it takes.
 */
export interface SlashCommand {
  /** Its name, without the slash. */
  name: string;
  description: string;
  /** What it takes after its name ("<file>"), or '' for nothing. */
  argumentHint: string;
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

/**
 * The modes a plan can be carried out in once approved, as Claude Code offers them. Codex carries
 * out a plan in its Default mode ('auto').
 */
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
  /**
   * How much of each of the user's plan's usage limits is used (Codex's rate-limit windows: the
   * 5-hour one, the weekly one), where the CLI says.
   */
  limits?: UsageLimit[];
}

/** A usage limit of the user's plan: a window of time, how much of it is used, when it resets. */
export interface UsageLimit {
  /** What it is called ("5h", "weekly"). */
  name: string;
  /** How much of it is used, from 0 to 100. */
  usedPercent: number;
  /** When it resets (milliseconds since the epoch), if the CLI said. */
  resetsAt: number | null;
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
  | { type: 'started'; model: string | null; mode: SessionMode; models: ModelChoice[] }
  /** The slash commands it offers now (sent once it runs, and again whenever they change). */
  | { type: 'commands'; commands: SlashCommand[] }
  /**
   * What a resumed session did before (its turns, as the events they were): shown unless the
   * transcript already shows them. Sent once it runs, outside any turn.
   */
  | { type: 'history'; events: SessionEvent[] }
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
   * or null where it offers no "always". `title`: what it asks, as the CLI words it ("Claude wants
   * to fetch example.com"), when it says.
   */
  | {
      type: 'permission';
      id: string;
      tool: string;
      summary: string;
      detail?: ToolDetail;
      always: string | null;
      title?: string;
    }
  | { type: 'question'; id: string; questions: AskedQuestion[] }
  /** Plan mode's plan (Markdown), for the user to approve. */
  | { type: 'plan'; id: string; plan: string }
  /** A prompt no longer waits for the user: its turn was interrupted, or it was answered elsewhere. */
  | { type: 'withdrawn'; id: string }
  /** Something to tell the user: compaction, a retry, a usage limit and when it resets, a login problem. */
  | { type: 'notice'; id: string; level: 'info' | 'warning' | 'error'; text: string }
  | { type: 'usage'; usage: SessionUsage }
  | { type: 'mode'; mode: SessionMode }
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
/** At most this many images in one message. */
export const MAX_IMAGES = 20;
/** The largest image the user may paste, in bytes (the Claude API's limit). */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** The longest text searched for when completing a file mention. */
export const MAX_FILE_QUERY_LENGTH = 500;
/** At most this many files are offered for a file mention. */
export const MAX_FILE_MATCHES = 50;
/** At most this many questions in one prompt (Claude Code asks 1 to 4). */
export const MAX_QUESTIONS = 4;
/** What a model's value may look like: an alias ('opus'), an id, or a provider's id or ARN. */
export const MODEL_PATTERN = /^[\w.:/@[\]-]{1,200}$/;
