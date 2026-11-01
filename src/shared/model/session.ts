import type { AdapterId, ConnectionId } from '../adapter';
import type {
  AgentStartSettings,
  AskedQuestion,
  BackgroundTask,
  DiffLine,
  EffortChoice,
  ElicitationAction,
  FormField,
  MessageImage,
  ModelChoice,
  PlanAnswer,
  SessionMode,
  SessionUsage,
  SlashCommand,
  TerminalAsk,
  Todo,
  ToolDetail,
  ToolProgress,
  ToolStatus,
  TurnResult,
} from '../session';
import type { LiveOutcome, SettledPromptView } from './prompt-views';
import type { Prompt as CorePrompt } from './prompts';
import type { SubmittedMessage } from './queue';

export type {
  BackgroundTask,
  DiffLine,
  EffortChoice,
  MessageImage,
  ModelChoice,
  PlanAnswer,
  SessionUsage,
  SlashCommand,
  TerminalAsk,
  Todo,
  ToolDetail,
  ToolProgress,
  ToolStatus,
  TurnResult,
};

/*
 * An agent's session, as its view shows it: a transcript of turns (the user's message, then what
 * the agent does: thinking, text, tool calls, prompts for the user, a to-do list, notices), whether
 * it is working, messages queued while it works, and the tools the user always allows. A driver
 * plays native turns onto it (src/main/core/engine/transcript/); unsupported connections keep work unsent.
 */

/**
 * A native mode in which the agent asks before acting.
 */
export type Mode = SessionMode;

/**
 * Which conversation the transcript's messages are of: an agent's adapter's (main resumes one per
 * adapter, whichever of its connections runs it: the catalog's adapterOf), or an unsupported
 * submission's ('unavailable'). An agent that runs another way keeps its transcript, so it may
 * hold several.
 */
export type Conversation = AdapterId;

/** How the user answered a permission prompt: allow this once, always allow the tool, or deny. */
export type Answer = 'once' | 'always' | 'deny';

/** A question the agent asked, with the user's answer once given. */
export interface SessionQuestion extends AskedQuestion {
  answer?: string;
}

/**
 * An entry of the transcript. `parent`: the Agent tool call a subagent's entry belongs to.
 * Prompts (permission, question, plan) are `withdrawn` when the session stops waiting for them.
 */
export type Entry =
  /**
   * The user's message, with the images pasted into it; once echoed, its text as sent to the CLI,
   * including any core-added framing or withdrawal notes. `reached`: a connected session's CLI has
   * it (main said so, by its id, or it is from the session's history): what a rewind can go back
   * to. `conversation`: the one it was sent in.
   */
  | {
      id: string;
      kind: 'user';
      text: string;
      images?: MessageImage[];
      /** Native prompt-answer provenance, retained internally so token views withhold its text. */
      promptReply?: true;
      reached?: true;
      conversation?: Conversation;
    }
  | { id: string; kind: 'text'; text: string; parent?: string }
  | { id: string; kind: 'thinking'; text: string; seconds: number; parent?: string }
  | {
      id: string;
      kind: 'tool';
      tool: string;
      summary: string;
      status: ToolStatus;
      detail?: ToolDetail;
      parent?: string;
      /** How it is going, as a connected session reports: time, a subagent's work. */
      progress?: ToolProgress;
    }
  | {
      id: string;
      kind: 'permission';
      tool: string;
      summary: string;
      /** What it would do: an edit's diff, a command. */
      detail?: ToolDetail;
      /** What "always" allows, as the CLI words it; null where it offers none. */
      always?: string | null;
      /** What it asks, as the CLI words it, when it says. */
      title?: string;
      answer?: Answer;
      /** What the user told Claude to do instead, with a no. */
      feedback?: string;
      withdrawn?: boolean;
    }
  | { id: string; kind: 'question'; questions: SessionQuestion[]; withdrawn?: boolean }
  /** Plan mode's plan (Markdown), to approve or not. */
  | { id: string; kind: 'plan'; plan: string; answer?: PlanAnswer; withdrawn?: boolean }
  | { id: string; kind: 'todos'; items: Todo[] }
  /**
   * An MCP server asks the user something (an elicitation): to fill in a form (`fields`), or to
   * open a link (`url`); then how they answered.
   */
  | {
      id: string;
      kind: 'elicitation';
      server: string;
      message: string;
      fields?: FormField[];
      url?: string;
      answer?: ElicitationAction;
      withdrawn?: boolean;
    }
  /**
   * What the session tells the user: compaction, a usage limit, a login problem. `switchTo`: the
   * connection the agent can switch to, to get past it (offered with the notice).
   */
  | {
      id: string;
      kind: 'notice';
      level: 'info' | 'warning' | 'error';
      text: string;
      switchTo?: ConnectionId;
    }
  /**
   * A prompt the core's prompt owner holds (B13 C9), placed by the core as it is raised, under its
   * PromptId, and settled in place as it ends; never from a CLI or its history. While it waits:
   * the prompt as admitted (`prompt`), its Needs id (`need`, what `reply` names), its agent's name
   * as it was raised (the core's words for a form), and whether it is the core's stand-in for a
   * terminal's wait it couldn't show. Once it ends: what was asked, in short, and how it ended.
   * Every read goes through B13 C11's selector (`entryFor`).
   */
  | OpenPromptEntry
  | SettledPromptEntry
  /** Where the conversation was cleared (/clear): it starts afresh after it. */
  | { id: string; kind: 'cleared'; conversation?: Conversation }
  /** The end of a turn: how long it took, and whether the user interrupted it, or it failed. */
  | {
      id: string;
      kind: 'end';
      seconds: number;
      interrupted: boolean;
      failed?: boolean;
      result?: TurnResult;
    };

/** A prompt the core's owner holds, waiting (B13 C9): see Entry. */
export interface OpenPromptEntry {
  id: string;
  kind: 'prompt';
  need: string;
  prompt: CorePrompt;
  name: string;
  standIn?: true;
  outcome?: never;
}

/** A prompt the core's owner held, ended (B13 C9): see Entry. */
export interface SettledPromptEntry {
  id: string;
  kind: 'prompt';
  need: string;
  /** Yours: a token reads `tokenTitle` for its title, where it reads another (an MCP server's tool). */
  prompt: SettledPromptView;
  tokenTitle?: string;
  outcome: LiveOutcome;
}

/**
 * Why a connected session would not start, as it said (a notice offering another connection), and
 * the connection that would: a message sent to it is kept, queued, until the agent runs that way.
 */
export interface Refusal {
  text: string;
  switchTo?: ConnectionId;
}

/** An entry the user answers while the turn waits. */
export type Prompt = Extract<Entry, { kind: 'permission' | 'question' | 'plan' | 'elicitation' }>;

export interface Session {
  entries: Entry[];
  /** Runtime index maintained by SessionStore; plain session inputs may supply entries alone. */
  prompts?: readonly Prompt[];
  /** Live manual messages only: not automation sends or restored native history. */
  submissions?: readonly SubmittedMessage[];
  /** Working on a turn; waiting (mid-turn) for the user to answer a prompt; or idle. */
  status: 'idle' | 'working' | 'waiting';
  /** Messages sent while it works, sent in order once it is idle. */
  queued: { id: string; text: string; images?: MessageImage[] }[];
  /** Its reported mode, or null until the native session says. */
  mode: Mode | null;
  /**
   * Whether what a connected session runs with asks before it acts, as it said where its mode
   * doesn't (null: settings of the user's own that are none of its modes); absent where it didn't.
   * A Terminal's initial value is its trusted pre-launch default until its hooks report a mode.
   */
  asks?: boolean;
  /** The model picked for it; null for its agent's default. */
  model: string | null;
  /**
   * What a connected session that runs was started with (the agent's settings then), absent while
   * none runs: its settings may have changed since, which a restart applies.
   */
  running?: AgentStartSettings;
  /** The models a connected session offers, once it has started: what the model picker lists. */
  models?: readonly ModelChoice[];
  /** The modes a connected session can switch to, when not all (bypassing turned off). */
  modes?: readonly Mode[];
  /**
   * How hard its model reasons (one of the efforts its model offers), where its connection lets
   * the user choose; null for the model's default.
   */
  effort?: string | null;
  /** What a connected session has used, as it last said. */
  usage?: SessionUsage;
  /** The slash commands a connected session offers, as the composer completes them. */
  commands?: readonly SlashCommand[];
  /** The work a connected session runs in the background now, which the user can stop. */
  tasks?: readonly BackgroundTask[];
  /** What a connected session predicts the user sends next, until a turn starts. */
  suggestion?: string;
  /** What a Terminal session's Claude Code asks the user in its terminal now (answered there). */
  asking?: readonly TerminalAsk[];
  /**
   * Why corrallm can't hear a connected session's replies, as it said when it started (its CLI's
   * settings turn off the hooks it listens to): the queues' Run can't read them.
   */
  unheard?: string;
}

/**
 * The user's messages of `conversation` since its last /clear (what came before it is another
 * conversation, as in Claude Code), oldest first. A message not marked with its conversation is
 * taken to be of any.
 */
function messagesOf(
  entries: readonly Entry[],
  conversation: Conversation,
): Extract<Entry, { kind: 'user' }>[] {
  const ours = entries.filter(
    (entry): entry is Extract<Entry, { kind: 'user' | 'cleared' }> =>
      (entry.kind === 'user' || entry.kind === 'cleared') &&
      (entry.conversation === undefined || entry.conversation === conversation),
  );
  const cleared = ours.findLastIndex((entry) => entry.kind === 'cleared');
  return ours.slice(cleared + 1).filter((entry) => entry.kind === 'user');
}

/**
 * The message a chat is named by: the first of the conversation the agent is on now
 * (`conversation`), since its last /clear.
 */
export function chatStart(
  entries: readonly Entry[],
  conversation: Conversation,
): Extract<Entry, { kind: 'user' }> | undefined {
  return messagesOf(entries, conversation)[0];
}

/**
 * The user's messages a rewind can go back to, oldest first: those Claude Code has (`reached`), of
 * its conversation now, since the last /clear (what came before it is another conversation, as in
 * Claude Code). Only an Agent SDK agent rewinds.
 */
export function rewindPoints(entries: readonly Entry[]): { id: string; text: string }[] {
  return messagesOf(entries, 'claude-code').flatMap((entry) =>
    entry.reached === true ? [{ id: entry.id, text: entry.text }] : [],
  );
}

/**
 * What a chat is called: the start of its first message, on one line, cut at a word and ended
 * with "…" when longer than `max` characters.
 */
export function threadTitle(text: string, max = 36): string {
  const line = text.trim().replace(/\s+/g, ' ');
  if (line.length <= max) return line;
  const cut = line.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export const NEW_SESSION: Session = {
  entries: [],
  status: 'idle',
  queued: [],
  mode: null,
  model: null,
};

/** Whether a prompt still waits for the user. */
export function isOpen(entry: Entry): entry is Prompt {
  switch (entry.kind) {
    case 'permission':
    case 'plan':
    case 'elicitation':
      return entry.answer === undefined && entry.withdrawn !== true;
    case 'question':
      return entry.withdrawn !== true && entry.questions.some((q) => q.answer === undefined);
    default:
      return false;
  }
}

/**
 * What the agent replied in the turn the user's message `id` started: the text of its replies
 * (not its subagents'), from that message to the turn's end, a paragraph each. '' if it said
 * nothing, or the message is not in the transcript.
 */
export function turnReply(session: Session, id: string): string {
  const start = session.entries.findIndex((entry) => entry.id === id);
  if (start === -1) return '';
  const end = session.entries.findIndex((entry, i) => i > start && entry.kind === 'end');
  return session.entries
    .slice(start + 1, end === -1 ? undefined : end)
    .flatMap((entry) =>
      entry.kind === 'text' && entry.parent === undefined && entry.text.trim() !== ''
        ? [entry.text.trim()]
        : [],
    )
    .join('\n\n');
}

/**
 * What a question card asks (graph/Questions.tsx): one an agent asks in its session (a `question`
 * entry), offering its answers by name; it may also have a header (a chip), say what each answer
 * means, and take several answers (`multiple`).
 */
export interface CardQuestion {
  id: string;
  text: string;
  header?: string;
  options?: readonly (string | { label: string; description?: string })[];
  multiple?: boolean;
  answer?: string;
}

/** A question asked in a session, as corrallm's question cards show it (graph/Questions.tsx). */
export interface AskedInSession {
  /** The question prompt it is in, and where in it. */
  prompt: string;
  index: number;
  /** With Claude Code's header, what each answer means, and whether several may be given. */
  question: CardQuestion;
}

/** Every question a session asked and still waits on, or that was answered. */
export function sessionQuestions(session: Session): AskedInSession[] {
  return session.entries.flatMap((entry) =>
    entry.kind === 'question' && entry.withdrawn !== true ? promptQuestions(entry) : [],
  );
}

/** The questions of one question prompt, each as a question card shows it, with its answer once given. */
export function promptQuestions(entry: Extract<Entry, { kind: 'question' }>): AskedInSession[] {
  return entry.questions.map((q, index) => ({
    prompt: entry.id,
    index,
    question: {
      id: `${entry.id}#${String(index)}`,
      text: q.text,
      ...(q.header === '' ? {} : { header: q.header }),
      ...(q.options.length > 0 ? { options: q.options } : {}),
      ...(q.multiple ? { multiple: true } : {}),
      ...(q.answer === undefined ? {} : { answer: q.answer }),
    },
  }));
}

/** The answers to the question prompt `id`, once every question in it has one. */
export function answersOf(session: Session, id: string): string[] | undefined {
  const entry = session.entries.find((e) => e.id === id);
  if (entry?.kind !== 'question') return undefined;
  const answers = entry.questions.map((q) => q.answer);
  return answers.every((a) => a !== undefined) ? answers : undefined;
}
