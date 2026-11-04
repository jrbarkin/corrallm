import type {
  Entry,
  MessageImage,
  Mode,
  ModelChoice,
  Session,
  SettledPromptEntry,
  SessionUsage,
  SlashCommand,
  BackgroundTask,
  TurnResult,
} from '../../../../shared/model/session';
import type { AgentStartSettings } from '../../../../shared/session';
import { mergeHistory } from './history';

/*
 * How a session changes (src/shared/model/session.ts): each action a driver plays onto it
 * (receive.ts, unavailable.ts), or the mailbox takes for it (delivery/mailbox.ts), reduced.
 */

/** Ended owner prompts retained per agent, in their original transcript order. */
const MAX_ENDED_PROMPT_ENTRIES = 100;

export type SessionAction =
  /** A turn starts with the user's message. */
  | { type: 'start'; entry: Extract<Entry, { kind: 'user' }>; before?: string }
  /** The CLI's receipt, including its final text and place after any earlier native messages. */
  | { type: 'received'; id: string; text: string }
  | { type: 'add'; entry: Entry }
  /** Replaces the entry `id` with what `update` makes of it. */
  | { type: 'update'; id: string; update: (entry: Entry) => Entry }
  /** The owner settles a prompt and drops only the oldest ended entries beyond the cap. */
  | { type: 'settlePrompt'; entry: SettledPromptEntry }
  /** Appends text to the text or thinking entry `id`. */
  | { type: 'stream'; id: string; text: string }
  /** Mid-turn: working, or waiting on the user (as a connected session says). */
  | { type: 'status'; status: 'working' | 'waiting' }
  | {
      type: 'end';
      id: string;
      seconds: number;
      messages?: readonly string[];
      result: TurnResult;
    }
  | { type: 'queue'; id: string; text: string; images?: MessageImage[] }
  | { type: 'unqueue'; id: string }
  /**
   * The session would not start (it said why), so the turn of the user's message `id` never went:
   * the message leaves the transcript for the head of the queue, unsent, and the session is idle.
   */
  | { type: 'refuse'; id: string }
  /** The mode, model or effort: chosen by the user, or as the session says. */
  | { type: 'mode'; mode: Mode | null }
  | { type: 'model'; model: string }
  | { type: 'effort'; effort: string | null }
  /** A connected session runs, started with the agent's settings `settings`; or none (undefined). */
  | { type: 'running'; settings: AgentStartSettings | undefined }
  /**
   * A connected session started: the models (and modes, if not all) it offers, its model and mode,
   * its effort (where its model offers a choice), and whether what it runs with asks before it
   * acts, where its mode doesn't say.
   */
  | {
      type: 'connected';
      models: readonly ModelChoice[];
      model: string | null;
      mode: Mode | null;
      modes?: readonly Mode[];
      effort?: string | null;
      asks?: boolean;
    }
  | { type: 'usage'; usage: SessionUsage }
  | { type: 'commands'; commands: readonly SlashCommand[] }
  | { type: 'tasks'; tasks: readonly BackgroundTask[] }
  | { type: 'suggestion'; text: string }
  /** corrallm can't hear the session's replies, and why. */
  | { type: 'unheard'; text: string }
  /** What a resumed session did before: what the transcript does not show yet goes in (history.ts). */
  | { type: 'restore'; entries: Entry[] }
  /**
   * Another conversation takes the transcript's place (/resume), or this one rewound: the
   * transcript empties, and what it used, ran in the background and predicted with it; what the
   * user chose stays.
   */
  | { type: 'clear' };

/**
 * Whether a session's change was only a streamed word or thought (a `stream` action): it appends to
 * a text or thinking entry and changes nothing else (the session's status, its queue, its user
 * messages, its mode and its prompts stay as they were), so what reads only those need not look
 * again. A reply streams many, and under load many arrive in one turn of the event loop. A change
 * no action made (`undefined`) is never one.
 */
export function streamed(action: SessionAction | undefined): boolean {
  return action?.type === 'stream';
}

/**
 * `entries` with entry `id` replaced by what `change` makes of it (entry ids are unique), found from
 * the newest: a reply streams its words, and a thought its seconds, into the last entries of what
 * may be a long transcript, so each is one entry replaced and the rest copied as they are, never a
 * callback per entry. A new list even where no entry has that id.
 */
function replaced(entries: readonly Entry[], id: string, change: (entry: Entry) => Entry): Entry[] {
  const at = entries.findLastIndex((entry) => entry.id === id);
  const entry = entries[at];
  return entry === undefined ? [...entries] : entries.with(at, change(entry));
}

export function reduce(session: Session, action: SessionAction): Session {
  const update = (id: string, change: (entry: Entry) => Entry): Entry[] =>
    session.entries.map((entry) => {
      if (entry.id !== id) return entry;
      const next = change(entry);
      return next;
    });
  switch (action.type) {
    case 'start': {
      // What was predicted for it is no longer.
      const before =
        action.before === undefined
          ? -1
          : session.entries.findIndex((entry) => entry.id === action.before);
      const started: Session = {
        ...session,
        status: 'working',
        entries:
          before === -1
            ? [...session.entries, action.entry]
            : [...session.entries.slice(0, before), action.entry, ...session.entries.slice(before)],
      };
      delete started.suggestion;
      return started;
    }
    case 'add':
      return { ...session, entries: [...session.entries, action.entry] };
    case 'received': {
      const sent = session.entries.find((entry) => entry.id === action.id);
      if (sent?.kind !== 'user') return session;
      const received: Entry = { ...sent, text: action.text, reached: true };
      return {
        ...session,
        entries: sent.reached
          ? update(action.id, () => received)
          : [...session.entries.filter((entry) => entry.id !== action.id), received],
      };
    }
    case 'settlePrompt': {
      const entries = update(action.entry.id, (entry) =>
        entry.kind === 'prompt' ? action.entry : entry,
      );
      let excess =
        entries.filter((entry) => entry.kind === 'prompt' && entry.outcome !== undefined).length -
        MAX_ENDED_PROMPT_ENTRIES;
      return {
        ...session,
        entries:
          excess <= 0
            ? entries
            : entries.filter((entry) => {
                if (excess > 0 && entry.kind === 'prompt' && entry.outcome !== undefined) {
                  excess--;
                  return false;
                }
                return true;
              }),
      };
    }
    case 'update':
      return { ...session, entries: replaced(session.entries, action.id, action.update) };
    case 'stream':
      return {
        ...session,
        entries: replaced(session.entries, action.id, (entry) =>
          entry.kind === 'text' || entry.kind === 'thinking'
            ? { ...entry, text: entry.text + action.text }
            : entry,
        ),
      };
    case 'status':
      return { ...session, status: action.status };
    case 'end': {
      const { id, seconds, result } = action;
      const interrupted = result.status === 'cancelled';
      const failed = result.status === 'failed';
      const entries = session.entries.map((entry): Entry => {
        return interrupted && entry.kind === 'tool' && entry.status === 'running'
          ? { ...entry, status: 'interrupted' }
          : entry;
      });
      return {
        ...session,
        status: 'idle',
        entries: [
          ...entries,
          {
            id,
            kind: 'end',
            seconds,
            interrupted,
            ...(failed ? { failed: true } : {}),
            result,
          },
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
    case 'refuse': {
      const message = session.entries.find((entry) => entry.id === action.id);
      if (message?.kind !== 'user') return session;
      const entries = session.entries.filter((entry) => entry !== message);
      // Said once: the session says why again each time it would not start.
      const [before, last] = entries.slice(-2);
      if (before?.kind === 'notice' && last?.kind === 'notice' && sameNotice(before, last)) {
        entries.pop();
      }
      const { id, text, images } = message;
      return {
        ...session,
        entries,
        status: 'idle',
        queued: [{ id, text, ...(images === undefined ? {} : { images }) }, ...session.queued],
      };
    }
    case 'mode':
      return { ...session, mode: action.mode };
    case 'model':
      return { ...session, model: action.model };
    case 'effort':
      return { ...session, effort: action.effort };
    case 'running': {
      const next = { ...session };
      delete next.running;
      return action.settings === undefined ? next : { ...next, running: action.settings };
    }
    case 'connected': {
      const { models, model, mode, modes, effort, asks } = action;
      // A session that starts runs nothing in the background yet, and asks nothing.
      const next: Session = { ...session, models, model, mode, tasks: [] };
      if (modes === undefined) delete next.modes;
      else next.modes = modes;
      if (asks === undefined) delete next.asks;
      else next.asks = asks;
      if (effort !== undefined) next.effort = effort;
      // One that can't hear its CLI says so after it starts.
      delete next.unheard;
      return next;
    }
    case 'usage':
      return { ...session, usage: action.usage };
    case 'commands':
      return { ...session, commands: action.commands };
    case 'tasks':
      return { ...session, tasks: action.tasks };
    case 'suggestion':
      return { ...session, suggestion: action.text };
    case 'unheard':
      return { ...session, unheard: action.text };
    case 'restore':
      return { ...session, entries: mergeHistory(session.entries, action.entries) };
    case 'clear': {
      // What the core's prompt owner holds open still waits (B13 C9): only it ends that.
      const waiting = session.entries.filter(
        (entry) => entry.kind === 'prompt' && entry.outcome === undefined,
      );
      const next: Session = { ...session, entries: waiting, status: 'idle', tasks: [] };
      delete next.usage;
      delete next.suggestion;
      return next;
    }
  }
}

/** Whether two notices say the same thing, the same way. */
function sameNotice(
  a: Extract<Entry, { kind: 'notice' }>,
  b: Extract<Entry, { kind: 'notice' }>,
): boolean {
  return a.level === b.level && a.text === b.text && a.switchTo === b.switchTo;
}
