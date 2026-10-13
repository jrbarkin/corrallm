import type {
  AskedQuestion,
  DiffLine,
  MessageImage,
  ModelChoice,
  PermissionMode,
  PlanAnswer,
  SessionUsage,
  SlashCommand,
  Todo,
  ToolDetail,
  ToolStatus,
} from '../../shared/session';
import type { Question } from '../graph/queue';

export type {
  DiffLine,
  MessageImage,
  ModelChoice,
  PlanAnswer,
  SessionUsage,
  SlashCommand,
  Todo,
  ToolDetail,
  ToolStatus,
};

/*
 * An agent's session, as its view shows it: a transcript of turns (the user's message, then what
 * the agent does: thinking, text, tool calls, prompts for the user, a to-do list, notices), whether
 * it is working, messages queued while it works, and the tools the user always allows. A driver
 * plays turns onto it (driver.ts): the scripted one (scripted.ts), or a connected one fed by the
 * real CLI (connected.ts).
 */

/** When the agent asks before acting: Claude Code's permission modes (its settings' names). */
export type Mode = PermissionMode;

/** The modes as Claude Code's desktop app names them, in the order Shift+Tab cycles them. */
export const MODES: readonly { mode: Mode; label: string; description: string }[] = [
  { mode: 'manual', label: 'Manual', description: 'Asks before editing files or running commands' },
  {
    mode: 'acceptEdits',
    label: 'Accept edits',
    description: 'Edits files freely; asks before commands',
  },
  { mode: 'plan', label: 'Plan', description: 'Reads and proposes a plan; changes nothing' },
  { mode: 'bypassPermissions', label: 'Bypass permissions', description: 'Never asks' },
  { mode: 'auto', label: 'Auto', description: 'Decides for itself what needs your approval' },
];

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
  /** The user's message, with the images pasted into it. */
  | { id: string; kind: 'user'; text: string; images?: MessageImage[] }
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
      withdrawn?: boolean;
    }
  | { id: string; kind: 'question'; questions: SessionQuestion[]; withdrawn?: boolean }
  /** Plan mode's plan (Markdown), to approve or not. */
  | { id: string; kind: 'plan'; plan: string; answer?: PlanAnswer; withdrawn?: boolean }
  | { id: string; kind: 'todos'; items: Todo[] }
  /** What the session tells the user: compaction, a usage limit, a login problem. */
  | { id: string; kind: 'notice'; level: 'info' | 'warning' | 'error'; text: string }
  /** The end of a turn: how long it took, and whether the user interrupted it, or it failed. */
  | { id: string; kind: 'end'; seconds: number; interrupted: boolean; failed?: boolean };

/** An entry the user answers while the turn waits. */
export type Prompt = Extract<Entry, { kind: 'permission' | 'question' | 'plan' }>;

export interface Session {
  entries: Entry[];
  /** Working on a turn; waiting (mid-turn) for the user to answer a prompt; or idle. */
  status: 'idle' | 'working' | 'waiting';
  /** Messages sent while it works, sent in order once it is idle. */
  queued: { id: string; text: string; images?: MessageImage[] }[];
  /** Tools the user said to always allow: it no longer asks about them. */
  allowed: string[];
  mode: Mode;
  /** The model picked for it; null for its agent's default. */
  model: string | null;
  /** The models a connected session offers, once it has started: what the model picker lists. */
  models?: readonly ModelChoice[];
  /** What a connected session has used, as it last said. */
  usage?: SessionUsage;
  /** The slash commands a connected session offers, as the composer completes them. */
  commands?: readonly SlashCommand[];
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
  allowed: [],
  mode: 'manual',
  model: null,
};

export type SessionAction =
  /** A turn starts with the user's message. */
  | { type: 'start'; entry: Extract<Entry, { kind: 'user' }> }
  | { type: 'add'; entry: Entry }
  /** Replaces the entry `id` with what `update` makes of it. */
  | { type: 'update'; id: string; update: (entry: Entry) => Entry }
  /** Appends text to the text or thinking entry `id`. */
  | { type: 'stream'; id: string; text: string }
  /** Shows a prompt and waits for its answer. */
  | { type: 'ask'; entry: Prompt }
  | { type: 'answer'; id: string; answer: Answer }
  /** Answers question `index` of the question prompt `id`. */
  | { type: 'answerQuestion'; id: string; index: number; answer: string }
  | { type: 'answerPlan'; id: string; answer: PlanAnswer }
  /** The prompt `id` no longer waits for an answer. */
  | { type: 'withdraw'; id: string }
  /** Mid-turn: working, or waiting on the user (as a connected session says). */
  | { type: 'status'; status: 'working' | 'waiting' }
  | { type: 'end'; id: string; seconds: number; interrupted: boolean; failed?: boolean }
  | { type: 'queue'; id: string; text: string; images?: MessageImage[] }
  | { type: 'unqueue'; id: string }
  | { type: 'mode'; mode: Mode }
  | { type: 'model'; model: string }
  /** A connected session started: the models it offers, and its model and mode. */
  | { type: 'connected'; models: readonly ModelChoice[]; model: string | null; mode: Mode }
  | { type: 'usage'; usage: SessionUsage }
  | { type: 'commands'; commands: readonly SlashCommand[] }
  /** What a resumed session did before: entries put ahead of the transcript's. */
  | { type: 'restore'; entries: Entry[] };

/** Whether a prompt still waits for the user. */
export function isOpen(entry: Entry): entry is Prompt {
  switch (entry.kind) {
    case 'permission':
    case 'plan':
      return entry.answer === undefined && entry.withdrawn !== true;
    case 'question':
      return entry.withdrawn !== true && entry.questions.some((q) => q.answer === undefined);
    default:
      return false;
  }
}

export function reduce(session: Session, action: SessionAction): Session {
  const update = (id: string, change: (entry: Entry) => Entry): Entry[] =>
    session.entries.map((entry) => (entry.id === id ? change(entry) : entry));
  /** `entries`, the turn waiting while one of their prompts is open, and working otherwise. */
  const settled = (entries: Entry[]): Session => ({
    ...session,
    entries,
    status: session.status === 'idle' ? 'idle' : entries.some(isOpen) ? 'waiting' : 'working',
  });
  switch (action.type) {
    case 'start':
      return { ...session, status: 'working', entries: [...session.entries, action.entry] };
    case 'add':
      return { ...session, entries: [...session.entries, action.entry] };
    case 'update':
      return { ...session, entries: update(action.id, action.update) };
    case 'stream':
      return {
        ...session,
        entries: update(action.id, (entry) =>
          entry.kind === 'text' || entry.kind === 'thinking'
            ? { ...entry, text: entry.text + action.text }
            : entry,
        ),
      };
    case 'ask':
      return { ...session, status: 'waiting', entries: [...session.entries, action.entry] };
    case 'answer': {
      const asked = session.entries.find((e) => e.id === action.id);
      if (asked?.kind !== 'permission') return session;
      const always = action.answer === 'always' && !session.allowed.includes(asked.tool);
      return {
        ...settled(
          update(action.id, (entry) =>
            entry.kind === 'permission' ? { ...entry, answer: action.answer } : entry,
          ),
        ),
        allowed: always ? [...session.allowed, asked.tool] : session.allowed,
      };
    }
    case 'answerQuestion':
      return settled(
        update(action.id, (entry) =>
          entry.kind === 'question'
            ? {
                ...entry,
                questions: entry.questions.map((q, i) =>
                  i === action.index ? { ...q, answer: action.answer } : q,
                ),
              }
            : entry,
        ),
      );
    case 'answerPlan':
      return settled(
        update(action.id, (entry) =>
          entry.kind === 'plan' ? { ...entry, answer: action.answer } : entry,
        ),
      );
    case 'withdraw':
      return settled(
        update(action.id, (entry) => (isOpen(entry) ? { ...entry, withdrawn: true } : entry)),
      );
    case 'status':
      return { ...session, status: action.status };
    case 'end': {
      const { id, seconds, interrupted, failed } = action;
      const entries = session.entries.map((entry): Entry => {
        if (isOpen(entry)) return { ...entry, withdrawn: true };
        return interrupted && entry.kind === 'tool' && entry.status === 'running'
          ? { ...entry, status: 'interrupted' }
          : entry;
      });
      return {
        ...session,
        status: 'idle',
        entries: [
          ...entries,
          { id, kind: 'end', seconds, interrupted, ...(failed ? { failed: true } : {}) },
        ],
      };
    }
    case 'queue': {
      const { id, text, images } = action;
      return {
        ...session,
        queued: [...session.queued, { id, text, ...(images === undefined ? {} : { images }) }],
      };
    }
    case 'unqueue':
      return { ...session, queued: session.queued.filter((q) => q.id !== action.id) };
    case 'mode':
      return { ...session, mode: action.mode };
    case 'model':
      return { ...session, model: action.model };
    case 'connected':
      return { ...session, models: action.models, model: action.model, mode: action.mode };
    case 'usage':
      return { ...session, usage: action.usage };
    case 'commands':
      return { ...session, commands: action.commands };
    case 'restore':
      return { ...session, entries: [...action.entries, ...session.entries] };
  }
}

/** A question asked in a session, as corrallm's question cards show it (graph/Questions.tsx). */
export interface AskedInSession {
  /** The question prompt it is in, and where in it. */
  prompt: string;
  index: number;
  question: Question;
}

/** The questions a session asked that still wait for an answer, oldest first. */
export function pendingSessionQuestions(session: Session): AskedInSession[] {
  return sessionQuestions(session).filter(({ question }) => question.answer === undefined);
}

/** Every question a session asked and still waits on, or that was answered. */
export function sessionQuestions(session: Session): AskedInSession[] {
  return session.entries.flatMap((entry) =>
    entry.kind === 'question' && entry.withdrawn !== true
      ? entry.questions.map((q, index) => ({
          prompt: entry.id,
          index,
          question: {
            id: `${entry.id}#${String(index)}`,
            text: q.text,
            ...(q.options.length > 0 ? { options: q.options.map((o) => o.label) } : {}),
            ...(q.answer === undefined ? {} : { answer: q.answer }),
          },
        }))
      : [],
  );
}

/** The answers to the question prompt `id`, once every question in it has one. */
export function answersOf(session: Session, id: string): string[] | undefined {
  const entry = session.entries.find((e) => e.id === id);
  if (entry?.kind !== 'question') return undefined;
  const answers = entry.questions.map((q) => q.answer);
  return answers.every((a) => a !== undefined) ? answers : undefined;
}
