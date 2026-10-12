/*
 * An agent's session, as its view shows it: a transcript of turns (the user's message, then what
 * the agent does: thinking, text, tool calls, permission prompts, a to-do list), whether it is
 * working, messages queued while it works, and the tools the user always allows. A scripted
 * player (player.ts) drives it for now; a real agent will later.
 */

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

/** When the agent asks before acting: Claude Code's permission modes (its settings' names). */
export type Mode = 'manual' | 'acceptEdits' | 'plan' | 'bypassPermissions' | 'auto';

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

export type Entry =
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'text'; text: string }
  | { id: string; kind: 'thinking'; text: string; seconds: number }
  | {
      id: string;
      kind: 'tool';
      tool: string;
      summary: string;
      status: ToolStatus;
      detail?: ToolDetail;
    }
  | { id: string; kind: 'permission'; tool: string; summary: string; answer?: Answer }
  | { id: string; kind: 'todos'; items: Todo[] }
  /** The end of a turn: how long it took, and whether the user interrupted it. */
  | { id: string; kind: 'end'; seconds: number; interrupted: boolean };

export interface Session {
  entries: Entry[];
  /** Working on a turn; waiting (mid-turn) for a permission answer; or idle. */
  status: 'idle' | 'working' | 'waiting';
  /** Messages sent while it works, sent in order once it is idle. */
  queued: { id: string; text: string }[];
  /** Tools the user said to always allow: it no longer asks about them. */
  allowed: string[];
  mode: Mode;
  /** The model picked for it; null for its agent's default. */
  model: string | null;
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
  /** Appends text to the text entry `id`. */
  | { type: 'stream'; id: string; text: string }
  /** Shows a permission prompt and waits for its answer. */
  | { type: 'ask'; entry: Extract<Entry, { kind: 'permission' }> }
  | { type: 'answer'; id: string; answer: Answer }
  | { type: 'end'; id: string; seconds: number; interrupted: boolean }
  | { type: 'queue'; id: string; text: string }
  | { type: 'unqueue'; id: string }
  | { type: 'mode'; mode: Mode }
  | { type: 'model'; model: string };

export function reduce(session: Session, action: SessionAction): Session {
  const update = (id: string, change: (entry: Entry) => Entry): Entry[] =>
    session.entries.map((entry) => (entry.id === id ? change(entry) : entry));
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
          entry.kind === 'text' ? { ...entry, text: entry.text + action.text } : entry,
        ),
      };
    case 'ask':
      return { ...session, status: 'waiting', entries: [...session.entries, action.entry] };
    case 'answer': {
      const asked = session.entries.find((e) => e.id === action.id);
      if (asked?.kind !== 'permission') return session;
      const always = action.answer === 'always' && !session.allowed.includes(asked.tool);
      return {
        ...session,
        status: 'working',
        allowed: always ? [...session.allowed, asked.tool] : session.allowed,
        entries: update(action.id, (entry) => ({ ...entry, answer: action.answer })),
      };
    }
    case 'end': {
      const { id, seconds, interrupted } = action;
      const entries = interrupted
        ? session.entries.map((entry) =>
            entry.kind === 'tool' && entry.status === 'running'
              ? { ...entry, status: 'interrupted' as const }
              : entry,
          )
        : session.entries;
      return {
        ...session,
        status: 'idle',
        entries: [...entries, { id, kind: 'end', seconds, interrupted }],
      };
    }
    case 'queue':
      return { ...session, queued: [...session.queued, { id: action.id, text: action.text }] };
    case 'unqueue':
      return { ...session, queued: session.queued.filter((q) => q.id !== action.id) };
    case 'mode':
      return { ...session, mode: action.mode };
    case 'model':
      return { ...session, model: action.model };
  }
}
