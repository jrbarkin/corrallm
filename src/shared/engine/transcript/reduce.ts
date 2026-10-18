import { isOpen } from '../../model/session';
import type {
  Answer,
  Entry,
  MessageImage,
  Mode,
  ModelChoice,
  PlanAnswer,
  Prompt,
  Session,
  SessionUsage,
  SlashCommand,
  BackgroundTask,
  TerminalAsk,
  TurnResult,
} from '../../model/session';
import type { AgentStartSettings, ElicitationAction } from '../../session';
import { mergeHistory } from './history';

/*
 * How a session changes (src/shared/model/session.ts): each action a driver plays onto it
 * (receive.ts, unavailable.ts), or the mailbox takes for it (delivery/mailbox.ts), reduced.
 */

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
  /** Answers a permission prompt; `feedback`, with a no: what to do instead. */
  | { type: 'answer'; id: string; answer: Answer; feedback?: string }
  /** Answers question `index` of the question prompt `id`. */
  | { type: 'answerQuestion'; id: string; index: number; answer: string }
  | { type: 'answerPlan'; id: string; answer: PlanAnswer }
  | { type: 'answerElicitation'; id: string; action: ElicitationAction }
  /** The prompt `id` no longer waits for an answer. */
  | { type: 'withdraw'; id: string }
  /** Mid-turn: working, or waiting on the user (as a connected session says). */
  | { type: 'status'; status: 'working' | 'waiting' }
  | {
      type: 'end';
      id: string;
      seconds: number;
      interrupted: boolean;
      failed?: boolean;
      messages?: readonly string[];
      result?: TurnResult;
    }
  | { type: 'queue'; id: string; text: string; images?: MessageImage[] }
  | { type: 'unqueue'; id: string }
  /**
   * The session would not start (it said why), so the turn of the user's message `id` never went:
   * the message leaves the transcript for the head of the queue, unsent, and the session is idle.
   */
  | { type: 'refuse'; id: string }
  /** The mode, model or effort: chosen by the user, or as the session says. */
  | { type: 'mode'; mode: Mode }
  | { type: 'model'; model: string }
  | { type: 'effort'; effort: string | null }
  /** A connected session runs, started with the agent's settings `settings`; or none (undefined). */
  | { type: 'running'; settings: AgentStartSettings | undefined }
  /**
   * A connected session started: the models (and modes, if not all) it offers, its model and mode,
   * and its effort (where its model offers a choice).
   */
  | {
      type: 'connected';
      models: readonly ModelChoice[];
      model: string | null;
      mode: Mode;
      modes?: readonly Mode[];
      effort?: string | null;
    }
  | { type: 'usage'; usage: SessionUsage }
  | { type: 'commands'; commands: readonly SlashCommand[] }
  | { type: 'tasks'; tasks: readonly BackgroundTask[] }
  | { type: 'suggestion'; text: string }
  | { type: 'asking'; asks: readonly TerminalAsk[] }
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
    case 'start': {
      // What was predicted for it is no longer.
      const started: Session = {
        ...session,
        status: 'working',
        entries: [...session.entries, action.entry],
      };
      delete started.suggestion;
      return started;
    }
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
      return settled(
        update(action.id, (entry) =>
          entry.kind === 'permission'
            ? {
                ...entry,
                answer: action.answer,
                ...(action.feedback === undefined ? {} : { feedback: action.feedback }),
              }
            : entry,
        ),
      );
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
    case 'answerElicitation':
      return settled(
        update(action.id, (entry) =>
          entry.kind === 'elicitation' ? { ...entry, answer: action.action } : entry,
        ),
      );
    case 'withdraw':
      return settled(
        update(action.id, (entry) => (isOpen(entry) ? { ...entry, withdrawn: true } : entry)),
      );
    case 'status':
      return { ...session, status: action.status };
    case 'end': {
      const { id, seconds, interrupted, failed, result } = action;
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
          {
            id,
            kind: 'end',
            seconds,
            interrupted,
            ...(failed ? { failed: true } : {}),
            ...(result === undefined ? {} : { result }),
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
      const { models, model, mode, modes, effort } = action;
      // A session that starts runs nothing in the background yet, and asks nothing.
      const next: Session = { ...session, models, model, mode, tasks: [] };
      if (modes === undefined) delete next.modes;
      else next.modes = modes;
      if (effort !== undefined) next.effort = effort;
      delete next.asking;
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
    case 'asking': {
      if (action.asks.length > 0) return { ...session, asking: action.asks };
      const asked: Session = { ...session };
      delete asked.asking;
      return asked;
    }
    case 'unheard':
      return { ...session, unheard: action.text };
    case 'restore':
      return { ...session, entries: mergeHistory(session.entries, action.entries) };
    case 'clear': {
      const next: Session = { ...session, entries: [], status: 'idle', tasks: [] };
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
