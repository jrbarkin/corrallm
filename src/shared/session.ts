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

/** Which CLIs the user has: whether corrallm finds each, as its connections would run it. */
export type InstalledClis = Readonly<Record<Cli, boolean>>;

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

/**
 * How a tool call is going, as its CLI reports while it runs: how long it has run, and for a
 * subagent, what it is doing now, its tool uses and the tokens it has used (kept once it is done).
 */
export interface ToolProgress {
  seconds?: number;
  /** What a subagent is doing now, as the CLI words it ("Reading README.md"). */
  doing?: string;
  toolUses?: number;
  tokens?: number;
}

/** Work going on in the background (a subagent, a command), which the user can stop. */
export interface BackgroundTask {
  /** The CLI's id for it. */
  id: string;
  description: string;
  kind: 'agent' | 'command' | 'other';
  /** The tool call that started it, when known: its line in the transcript. */
  tool?: string;
}

export interface Todo {
  text: string;
  status: 'pending' | 'active' | 'done';
}

/**
 * A model a session offers: what the CLI calls it, and how the model picker shows it; and how hard
 * it can reason, where the CLI lets the user choose (Claude Code's /effort levels, Codex's reasoning
 * efforts, as their pickers offer them), with the effort it reasons at unless one is chosen, where
 * the CLI says (Codex does; Claude Code's is "the model's default").
 */
export interface ModelChoice {
  value: string;
  label: string;
  description?: string;
  efforts?: EffortChoice[];
  defaultEffort?: string;
}

/** A reasoning effort a model offers: what the CLI calls it ('high'), and how the picker shows it. */
export interface EffortChoice {
  value: string;
  label: string;
  description?: string;
}

/**
 * How a session is started: with the agent's settings for its connection's CLI (`AgentSettings`,
 * saved with the agent in its canvas's file). Main picks the folder (the canvas's project) and what
 * it resumes.
 */
export interface SessionOptions {
  connection: Connection;
  /** The model the agent is set to run, or null: the user's own default (their CLI's settings). */
  model: string | null;
  /**
   * The mode it starts in (one of its connection's CLI's), or null: the user's own default (their
   * Claude Code settings; Codex's Default, which leaves their own sandbox settings).
   */
  mode: SessionMode | null;
  /** The reasoning effort it is set to; null or absent: the user's own default, else the model's. */
  effort?: string | null;
}

/**
 * What an agent is set to run with in a CLI, each only if chosen: its model, its reasoning effort
 * and the mode its sessions start in (never one that never asks: UNASKING_MODES). Saved with the
 * agent in its canvas's file, one for each CLI it has run (so switching between Claude and Codex
 * loses neither), and shared by that CLI's connections: a Terminal agent's are passed on its CLI's
 * command line as it starts, a structured session's are its composer's choices.
 */
export interface AgentSettings {
  model?: string;
  effort?: string;
  mode?: SessionMode;
}

/**
 * What an agent's settings can be in a CLI, as told without starting a session (or a prompt): the
 * models it takes (with their efforts), and the user's own defaults, which apply where nothing is
 * chosen (null where the CLI's settings say none).
 */
export interface SettingsOptions {
  models: ModelChoice[];
  defaults: { model: string | null; effort: string | null; mode: SessionMode | null };
}

/**
 * The modes that never ask before acting: chosen only once confirmed, for a session, and never
 * what an agent is set to start in (AgentSettings).
 */
export const UNASKING_MODES: readonly SessionMode[] = ['bypassPermissions', 'full-access'];

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

/**
 * A conversation Claude Code kept for the project folder (its transcript), as /resume lists it.
 * Both connections keep theirs there: an agent can open any of them.
 */
export interface PastSession {
  /** Its session id: main opens it only if main listed it for this folder. */
  id: string;
  /** What it is called: the title it was given (/rename), its summary, or its first message. */
  title: string;
  /** When it last changed, in ms since the epoch. */
  modified: number;
  /** How large its transcript is, in bytes, when known. */
  bytes?: number;
  /** The git branch it ended on, when known. */
  branch?: string;
  /** Whether it is the agent's own: the one it runs, or would resume. */
  current: boolean;
}

/**
 * What restoring the files to how they were before a message would change (a preview), or
 * changed: Claude Code's file checkpoints.
 */
export interface FilesRewind {
  /** Whether they can be restored to that point; `error` says why not. */
  possible: boolean;
  error?: string;
  /** The files it changes, relative to the project folder where they are in it. */
  files: string[];
  /** The lines it adds and removes. */
  added: number;
  removed: number;
}

/** What rewinding to before a message restores, as Claude Code offers it. */
export const REWIND_RESTORES = ['both', 'conversation', 'code'] as const;
export type RewindRestore = (typeof REWIND_RESTORES)[number];

/** What a rewind did: the files it restored, if it did; whether the conversation went back. */
export interface RewindResult {
  files?: FilesRewind;
  conversation: boolean;
}

/** How an MCP server is, as Claude Code reports it. */
export const MCP_STATUSES = ['connected', 'failed', 'needs-auth', 'pending', 'disabled'] as const;
export type McpStatus = (typeof MCP_STATUSES)[number];

/** An MCP server a session has, as /mcp lists it. */
export interface McpServer {
  name: string;
  status: McpStatus;
  /** Where it is configured: user, project, local, a plugin, claude.ai… */
  scope?: string;
  /** What it says it is, once connected ("github 1.2.0"). */
  server?: string;
  /** How many tools it gives, once connected. */
  tools?: number;
  /** Why it failed. */
  error?: string;
}

/** What /mcp can do to a server. */
export const MCP_CHANGES = ['reconnect', 'enable', 'disable'] as const;
export type McpChange = (typeof MCP_CHANGES)[number];

/** A value of a form an MCP server asks the user to fill in: text, a number, yes or no, choices. */
export type FormValue = string | number | boolean | string[];

/** A field of a form an MCP server asks the user to fill in (an elicitation). */
export interface FormField {
  /** Its key in the answer. */
  name: string;
  label: string;
  description?: string;
  required: boolean;
  /** Text (`format`: an email, a URL, a date), a number, a whole number, yes or no, one or several choices. */
  kind: 'text' | 'number' | 'integer' | 'boolean' | 'choice' | 'choices';
  format?: 'email' | 'uri' | 'date' | 'date-time';
  /** What a choice offers: what is answered, and how it shows. */
  options?: { value: string; label: string }[];
  /** Its bounds: a number's, a text's length, or how many choices. */
  min?: number;
  max?: number;
  default?: FormValue;
}

/** How the user answers an MCP server's request: go ahead (with the form filled in), no, or not now. */
export const ELICITATION_ACTIONS = ['accept', 'decline', 'cancel'] as const;
export type ElicitationAction = (typeof ELICITATION_ACTIONS)[number];

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
 * What a session's CLI asks the user in its own terminal (a Terminal session's), as corrallm lists
 * it outside the terminal: a permission (the tool, and what it acts on), its questions, a plan to
 * approve, whether to trust the project folder (asked in or out of a turn, as the CLI starts), or
 * anything else it waits on, in its own words. corrallm never answers it: the user does, in the
 * terminal.
 */
export type TerminalAsk =
  | { kind: 'permission'; id: string; tool: string; summary: string }
  | { kind: 'question'; id: string; questions: AskedQuestion[] }
  | { kind: 'plan'; id: string; plan: string }
  /** Whether to trust the project folder: its CLI's dialog the first time it runs there. */
  | { kind: 'trust'; id: string }
  | { kind: 'other'; id: string; text: string };

/**
 * The modes a plan can be carried out in once approved, as Claude Code offers them. Codex carries
 * out a plan in its Default mode ('auto').
 */
export const PLAN_MODES = ['auto', 'acceptEdits', 'manual'] as const;
export type PlanMode = (typeof PLAN_MODES)[number];

/** How the user answers a plan: go ahead in a mode; or keep planning, saying what to change. */
export type PlanAnswer = { approve: true; mode: PlanMode } | { approve: false; feedback: string };

/**
 * The user's answer to a prompt a session showed. A permission denied with `feedback` (what to do
 * instead) lets Claude go on with it; denied without, the turn stops, as in Claude Code.
 */
export type SessionAnswer =
  | { kind: 'permission'; answer: 'once' | 'always' | 'deny'; feedback?: string }
  /** An answer to each of the questions asked, in order. */
  | { kind: 'question'; answers: string[] }
  | { kind: 'plan'; answer: PlanAnswer }
  /** An MCP server's request answered: accepted (with the form's values), declined, or cancelled. */
  | { kind: 'elicitation'; action: ElicitationAction; values?: Record<string, FormValue> };

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
  /**
   * The session runs (started, or resumed): its model and mode, and the models it offers; the
   * reasoning effort it runs at, where its model offers a choice (null: the model's default).
   * `modes`: the modes it can switch to, when not all of them (bypassing permissions turned off
   * in the user's or their organization's settings).
   */
  | {
      type: 'started';
      model: string | null;
      mode: SessionMode;
      models: ModelChoice[];
      effort?: string | null;
      modes?: SessionMode[];
    }
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
      progress?: ToolProgress;
    }
  | { type: 'todos'; id: string; items: Todo[] }
  /**
   * The work going on in the background now (every such task: it replaces the last list). Sent
   * whenever that changes, in a turn or not; a session that starts has none.
   */
  | { type: 'tasks'; tasks: BackgroundTask[] }
  /** What the user might send next, as the CLI predicts it after a turn: the composer offers it. */
  | { type: 'suggestion'; text: string }
  /**
   * What the CLI asks the user in its own terminal now (a Terminal session's), every ask (it
   * replaces the last list; none once it goes on). Shown outside the terminal, never answered
   * there: the user answers in the terminal. A session that starts asks nothing yet.
   */
  | { type: 'asking'; asks: TerminalAsk[] }
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
  /**
   * An MCP server asks the user something (an elicitation): to fill in a form (`fields`), or to
   * open a link (`url`) and go on there.
   */
  | {
      type: 'elicitation';
      id: string;
      server: string;
      message: string;
      fields?: FormField[];
      url?: string;
    }
  /** A prompt no longer waits for the user: its turn was interrupted, or it was answered elsewhere. */
  | { type: 'withdrawn'; id: string }
  /**
   * Something to tell the user: compaction, a retry, a usage limit and when it resets, a login
   * problem. `switchTo`: the connection the agent can switch to, to get past it (Terminal, for an
   * Agent SDK session on a Claude subscription login).
   */
  | {
      type: 'notice';
      id: string;
      level: 'info' | 'warning' | 'error';
      text: string;
      switchTo?: Connection;
    }
  /**
   * The conversation was cleared (/clear): Claude starts afresh, under a new session id. The
   * transcript keeps what came before, marked off.
   */
  | { type: 'cleared'; id: string }
  | { type: 'usage'; usage: SessionUsage }
  | { type: 'mode'; mode: SessionMode }
  | { type: 'model'; model: string }
  /** The reasoning effort it runs at now (null: its model's default). */
  | { type: 'effort'; effort: string | null }
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
/** At most this many fields in an MCP server's form, and choices in one of them. */
export const MAX_FORM_FIELDS = 50;
/** The longest name of an MCP server the renderer may give. */
export const MAX_MCP_NAME_LENGTH = 200;
/**
 * What a model's value may look like: an alias ('opus'), an id, or a provider's id or ARN; never
 * with a dash first, which a command line would take for a flag.
 */
export const MODEL_PATTERN = /^(?!-)[\w.:/@[\]-]{1,200}$/;
/** What a reasoning effort's value may look like ('low', 'xhigh'). */
export const EFFORT_PATTERN = /^[a-z][a-z0-9_-]{0,39}$/;
