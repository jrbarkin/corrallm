import type { AdapterId, ConnectionId } from '../adapter';
import type { SessionFeatures } from '../features';
import type {
  AgentStartSettings,
  BackgroundTask,
  DiffLine,
  EffortChoice,
  MessageImage,
  ModelChoice,
  SessionMode,
  SessionUsage,
  SlashCommand,
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
  SessionUsage,
  SlashCommand,
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

/**
 * An entry of the transcript. `parent`: the Agent tool call a subagent's entry belongs to.
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
  | { id: string; kind: 'todos'; items: Todo[] }
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
  /**
   * The turn's images are what its connection can't take (B16 C3), not the session: its message
   * waits, whole, until its agent runs where they can go, or it is taken back.
   */
  images?: true;
}

export interface Session {
  entries: Entry[];
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
  /**
   * What its ready generation can do now (B16 C1), as its summary projects it: null while none is
   * ready. A view reads it to decide whether a panel its connection declares can open.
   */
  features?: SessionFeatures | null;
  /** The work a connected session runs in the background now, which the user can stop. */
  tasks?: readonly BackgroundTask[];
  /** What a connected session predicts the user sends next, until a turn starts. */
  suggestion?: string;
  /**
   * Why corrallm can't hear a connected session's replies, as it said when it started (its CLI's
   * settings turn off the hooks it listens to): the queues' Run can't read them.
   */
  unheard?: string;
}

/**
 * The user's messages of `conversation` since its last /clear (what came before it is another
 * conversation), oldest first. A message not marked with its conversation is
 * taken to be of any.
 */
function messagesOf(
  entries: readonly Entry[],
  conversation: Conversation | undefined,
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
  conversation: Conversation | undefined,
): Extract<Entry, { kind: 'user' }> | undefined {
  return messagesOf(entries, conversation)[0];
}

/**
 * The user's messages a rewind of `conversation` can go back to, oldest first (B16 C4): those its
 * CLI has (`reached`), marked as that conversation's (an unmarked one proves nothing), since its
 * last clear (one marked as its, or unmarked). Its owner is the agent's actual adapter, which the
 * caller names: no conversation is taken for another's.
 */
export function rewindPointsOf(
  entries: readonly Entry[],
  conversation: Conversation,
): { id: string; text: string }[] {
  const ours = entries.filter(
    (entry) =>
      (entry.kind === 'user' && entry.conversation === conversation) ||
      (entry.kind === 'cleared' &&
        (entry.conversation === undefined || entry.conversation === conversation)),
  );
  const cleared = ours.findLastIndex((entry) => entry.kind === 'cleared');
  return ours
    .slice(cleared + 1)
    .flatMap((entry) =>
      entry.kind === 'user' && entry.reached === true ? [{ id: entry.id, text: entry.text }] : [],
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
