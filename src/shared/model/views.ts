import {
  MAX_ASKING_BYTES,
  MAX_SESSION_REPLY_BYTES,
  MAX_SUGGESTION_BYTES,
  MAX_TERMINAL_ASKS,
} from '../api/limits';
import type { PartyId } from './messages';
import type { AgentId } from '../api/ids';
import type { ConnectionId } from '../adapter';
import type { FallbackView } from './fallback';
import type { HandoffView } from './handoff';
import { MAX_QUESTIONS } from '../session';
import type { BackgroundTask, SlashCommand, TerminalAsk } from '../session';
import type { Message, MessageDisplay, MessageOrigin } from './messages';
import type { QueueItem } from './queue';
import type { Run } from './run';
import { isOpen, turnReply } from './session';
import type { Entry, Session } from './session';
import { entryFor } from './prompt-views';
import type { PromptEntryView } from './prompt-views';

/** Wire/view data only. No mutable store, callback or timer is part of a view. */
export type ReadonlyData<T> = T extends string | number | boolean | null | undefined
  ? T
  : T extends readonly (infer E)[]
    ? readonly ReadonlyData<E>[]
    : T extends object
      ? { readonly [K in keyof T]: ReadonlyData<T[K]> }
      : T;

/** The current engine snapshot is structurally compatible with the future read-only view. */
export type RunSnapshot = ReadonlyData<Run>;
export interface RunNotice {
  readonly id: string;
  readonly level: 'info' | 'warning' | 'error';
  readonly text: string;
  readonly agent?: AgentId;
}
export type RunAgentView = RunSnapshot['agents'][string] & { readonly pauses?: readonly PartyId[] };
export interface RunGroupView {
  readonly pauses: readonly PartyId[];
}
/**
 * The run as a view shows it. Who stopped it and who decided in it (`pausedBy`, `decided`: R9's
 * stamps, which the core's run controls read) stay the core's: no view carries them.
 */
export interface RunView extends Omit<
  RunSnapshot,
  'agents' | 'individualPauses' | 'groupPauses' | 'pausedBy' | 'decided'
> {
  readonly agents: Readonly<Record<AgentId, RunAgentView>>;
  readonly groups: Readonly<Record<string, RunGroupView>>;
  readonly notices: readonly RunNotice[];
  readonly saveError?: string;
}

/** What a terminal asks, as a summary carries it: bounded, `cut` where it was. */
export type AskView = TerminalAsk & { readonly cut?: true };

/** The single summary DTO, matching session.get (entries travel on the per-agent topic). */
export interface SessionSummary {
  readonly agent: string;
  readonly connection: ConnectionId;
  /** Where it is in the fallback chain you set, and whether corrallm switches it (B11a C11). */
  readonly fallback: ReadonlyData<FallbackView> | null;
  /** Its handoff: when its latest was kept, how long, and its state (B11a C11); no text. */
  readonly handoff: ReadonlyData<HandoffView> | null;
  readonly status: Session['status'];
  readonly paused: boolean;
  readonly queued: number;
  readonly prompts: number;
  readonly unheard?: string;
  readonly tasks: readonly ReadonlyData<BackgroundTask>[];
  readonly commands: readonly ReadonlyData<SlashCommand>[];
  readonly mode: Session['mode'];
  readonly model: Session['model'];
  readonly effort: string | null;
  readonly models: ReadonlyData<NonNullable<Session['models']>>;
  readonly modes?: ReadonlyData<Session['modes']>;
  readonly running?: ReadonlyData<Session['running']>;
  readonly usage?: ReadonlyData<Session['usage']>;
  readonly reply: string | null;
  readonly replyCut?: true;
  /** What its CLI predicts you send next, for your composer: yours alone (summaryFor). */
  readonly suggestion?: string;
  /** What its terminal asks you now, bounded (askingView): yours alone (summaryFor). */
  readonly asking?: readonly ReadonlyData<AskView>[];
}

/**
 * Images are counted for display, never serialized as bytes on the general topic; a prompt the
 * core's owner holds is read through B13 C11's selector (PromptEntryView).
 */
export type EntryView = ReadonlyData<
  | Exclude<Entry, { kind: 'user' | 'prompt' }>
  | (Omit<Extract<Entry, { kind: 'user' }>, 'images' | 'promptReply'> & { images?: number })
  | PromptEntryView
>;
export interface SessionView {
  readonly summary: SessionSummary;
  readonly entries: Readonly<Record<string, EntryView>>;
  readonly order: readonly string[];
}

export interface MessageView extends ReadonlyData<Message> {
  readonly origin: MessageOrigin;
  readonly display?: MessageDisplay;
}
export interface AuthoredRow {
  readonly kind: 'authored';
  readonly key: string;
  readonly item: ReadonlyData<QueueItem>;
}
export interface MessageRow {
  readonly kind: 'message';
  readonly key: string;
  readonly message: MessageView;
}
export type QueueRow = AuthoredRow | MessageRow;

/** Detach a data snapshot from mutable engine inputs, sharing equal subtrees with the last view. */
export function projectData<T>(next: T, previous?: ReadonlyData<T>): ReadonlyData<T> {
  return share(next, previous) as ReadonlyData<T>;
}

// Only snapshots this projector deep-froze can skip a visit; native input objects still detach.
const projected = new WeakSet<object>();
function share(next: unknown, previous: unknown): unknown {
  if (typeof next === 'function') throw new TypeError('A view contains data, never a function.');
  if (next === null || typeof next !== 'object') return next;
  if (projected.has(next) && (previous === undefined || next === previous)) return next;
  const old =
    previous !== null && typeof previous === 'object'
      ? (previous as Record<string, unknown>)
      : undefined;
  const entries = Object.entries(next).map(
    ([key, value]) => [key, share(value, old?.[key])] as const,
  );
  if (
    old &&
    Array.isArray(next) === Array.isArray(previous) &&
    Object.keys(old).length === entries.length &&
    entries.every(([key, value]) => Object.hasOwn(old, key) && Object.is(old[key], value))
  )
    return previous;
  const result = Object.freeze(
    Array.isArray(next) ? entries.map(([, value]) => value) : Object.fromEntries(entries),
  );
  projected.add(result);
  return result;
}

export function runView(
  run: Run,
  previous?: RunView,
  meta: { notices?: readonly RunNotice[]; saveError?: string } = {},
): RunView {
  const { agents, individualPauses, groupPauses, ...top } = run;
  // R9's stamps stay the core's.
  delete top.pausedBy;
  delete top.decided;
  const causes = (pauses: Run['individualPauses']) => {
    const byId = new Map<string, PartyId[]>();
    for (const { id, by } of pauses ?? []) {
      const parties = byId.get(id) ?? [];
      parties.push(by);
      byId.set(id, parties);
    }
    return byId;
  };
  const individual = causes(individualPauses);
  const entries = new Map<string, RunAgentView>(Object.entries(agents));
  for (const [id, pauses] of individual)
    entries.set(id, { ...(entries.get(id) ?? { status: 'waiting', outcomes: {} }), pauses });
  return projectData(
    {
      ...top,
      agents: Object.fromEntries(entries),
      groups: Object.fromEntries([...causes(groupPauses)].map(([id, pauses]) => [id, { pauses }])),
      notices: meta.notices ?? [],
      ...(meta.saveError === undefined ? {} : { saveError: meta.saveError }),
    },
    previous,
  );
}

export function sessionView(
  agent: AgentId,
  connection: ConnectionId,
  session: Session,
  paused = false,
  previous?: SessionView,
  fallback: FallbackView | null = null,
  handoff: HandoffView | null = null,
): SessionView {
  const last = session.entries.findLast((entry) => entry.kind === 'user');
  const summary: SessionSummary = {
    agent,
    connection,
    fallback,
    handoff,
    status: session.status,
    paused,
    queued: session.queued.length,
    prompts:
      (session.prompts ?? session.entries.filter(isOpen)).length + (session.asking?.length ?? 0),
    ...(session.unheard === undefined ? {} : { unheard: session.unheard }),
    tasks: session.tasks ?? [],
    commands: session.commands ?? [],
    mode: session.mode,
    model: session.model,
    effort: session.effort ?? null,
    models: session.models ?? [],
    ...(session.modes === undefined ? {} : { modes: session.modes }),
    ...(session.running === undefined ? {} : { running: session.running }),
    ...(session.usage === undefined ? {} : { usage: session.usage }),
    ...summaryReply(last === undefined ? null : turnReply(session, last.id) || null),
    ...presentationOf(session),
  };
  const entries = Object.fromEntries(
    session.entries.map((entry): readonly [string, EntryView] => [
      entry.id,
      entryFor(entry, 'you'),
    ]),
  );
  return projectData({ summary, entries, order: session.entries.map(({ id }) => id) }, previous);
}

/** The caller/runtime supplies provenance; a sender or task link alone never establishes it. */
export function messageView(
  message: Message,
  origin: MessageOrigin,
  display?: MessageDisplay,
  previous?: MessageView,
): MessageView {
  return projectData(
    { ...message, origin, ...(display === undefined ? {} : { display }) },
    previous,
  );
}

/** A display projection, never runner input, document rows or authored wait targets. */
export function queueRows(
  queue: readonly QueueItem[],
  messages: readonly MessageView[],
): readonly QueueRow[] {
  const rows: QueueRow[] = [];
  const displayed = messages.filter(
    (message) => message.kind === 'text' && message.origin !== 'run',
  );
  const put = (after: string | undefined) => {
    for (const message of displayed.filter((one) => one.display?.after === after))
      rows.push(Object.freeze({ kind: 'message', key: `message/${message.id}`, message }));
  };
  put(undefined);
  for (const item of queue) {
    rows.push(
      Object.freeze({
        kind: 'authored',
        key: `item/${encodeURIComponent(item.id)}`,
        item: projectData(item),
      }),
    );
    put(item.id);
  }
  const ids = new Set(queue.map(({ id }) => id));
  for (const message of displayed)
    if (message.display?.after !== undefined && !ids.has(message.display.after))
      rows.push(Object.freeze({ kind: 'message', key: `message/${message.id}`, message }));
  return Object.freeze(rows);
}

/**
 * What a summary shows you beyond the session's state: its CLI's suggestion, whole and within
 * MAX_SUGGESTION_BYTES (one longer is left out, never cut), and its terminal's asks (askingView).
 */
export function presentationOf(session: Pick<Session, 'suggestion' | 'asking'>): {
  suggestion?: string;
  asking?: AskView[];
} {
  const { suggestion } = session;
  const asking = askingView(session.asking ?? []);
  return {
    ...(suggestion !== undefined && suggestion !== '' && utf8(suggestion) <= MAX_SUGGESTION_BYTES
      ? { suggestion }
      : {}),
    ...(asking === undefined ? {} : { asking }),
  };
}

/**
 * A summary as `yours` (you) or anyone else sees it: what is for your composer and your Needs (a
 * suggestion, the terminal's asks in full) is yours alone; a token sees how many prompts there are
 * and Needs' own words.
 */
export function summaryFor(summary: SessionSummary, yours: boolean): SessionSummary {
  if (yours || (summary.suggestion === undefined && summary.asking === undefined)) return summary;
  const seen = { ...summary };
  delete seen.suggestion;
  delete seen.asking;
  return seen;
}

/** A text's UTF-8 length. */
function utf8(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** The longest an ask's text is (its plan, a question's text, an output, a summary). */
const ASK_TEXT = 8000;
/** The longest a short field of an ask is (a tool, a header, an option's label). */
const ASK_LABEL = 200;
/** The longest an option's description is. */
const ASK_DESCRIPTION = 1000;
/** The most options a question shows, and lines a diff shows (each at most ASK_LINE). */
const ASK_OPTIONS = 16;
const ASK_LINES = 200;
const ASK_LINE = 400;
/** The longest id an ask may have: a Need's id must be able to name it. */
const ASK_ID = 256;

/**
 * What a terminal asks, as a summary carries it (B11 §16.3a: the summary always fits its frame):
 * the newest MAX_TERMINAL_ASKS whose ids a Need can name, each text cut to its bound, then the
 * newest of those whose JSON fits MAX_ASKING_BYTES together; the newest alone, if even it doesn't,
 * cut to its gist. Each one cut says so (`cut`); its Need, and the terminal, keep it whole.
 */
export function askingView(asks: readonly TerminalAsk[]): AskView[] | undefined {
  const views = asks
    .filter(({ id }) => id.length > 0 && id.length <= ASK_ID)
    .slice(-MAX_TERMINAL_ASKS)
    .map(boundedAsk);
  const kept: AskView[] = [];
  let bytes = 2;
  for (const view of views.reverse()) {
    let one = view;
    if (kept.length === 0 && bytes + utf8(JSON.stringify(one)) + 1 > MAX_ASKING_BYTES)
      one = gistOf(one);
    const size = utf8(JSON.stringify(one)) + 1;
    if (bytes + size > MAX_ASKING_BYTES) break;
    kept.unshift(one);
    bytes += size;
  }
  return kept.length === 0 ? undefined : kept;
}

/** The first `most` UTF-16 units of `value`, never half a character. */
function cutAt(value: string, most: number): string {
  if (value.length <= most) return value;
  const code = value.charCodeAt(most - 1);
  return value.slice(0, code >= 0xd800 && code <= 0xdbff ? most - 1 : most);
}

/** An ask with each text cut to its bound, marked `cut` if any was. */
function boundedAsk(ask: TerminalAsk): AskView {
  const was = { cut: false };
  const text = (value: string, most: number) => {
    if (value.length > most) was.cut = true;
    return cutAt(value, most);
  };
  const list = <T>(values: readonly T[], most: number): T[] => {
    if (values.length > most) was.cut = true;
    return values.slice(0, most);
  };
  const view = ((): TerminalAsk => {
    switch (ask.kind) {
      case 'permission': {
        const { detail } = ask;
        return {
          kind: 'permission',
          id: ask.id,
          tool: text(ask.tool, ASK_LABEL),
          summary: text(ask.summary, ASK_TEXT),
          ...(detail === undefined
            ? {}
            : {
                detail:
                  detail.kind === 'output'
                    ? { kind: 'output', text: text(detail.text, ASK_TEXT) }
                    : {
                        ...detail,
                        lines: list(detail.lines, ASK_LINES).map((line) => ({
                          kind: line.kind,
                          text: text(line.text, ASK_LINE),
                        })),
                      },
              }),
        };
      }
      case 'question':
        return {
          kind: 'question',
          id: ask.id,
          questions: list(ask.questions, MAX_QUESTIONS).map((question) => ({
            header: text(question.header, ASK_LABEL),
            text: text(question.text, ASK_TEXT),
            options: list(question.options, ASK_OPTIONS).map((option) => ({
              label: text(option.label, ASK_LABEL),
              description: text(option.description, ASK_DESCRIPTION),
            })),
            multiple: question.multiple,
          })),
        };
      case 'plan':
        return { kind: 'plan', id: ask.id, plan: text(ask.plan, ASK_TEXT) };
      case 'trust':
        return { kind: 'trust', id: ask.id };
      case 'other':
        return { kind: 'other', id: ask.id, text: text(ask.text, ASK_TEXT) };
    }
  })();
  return was.cut ? { ...view, cut: true } : view;
}

/** An ask cut to its gist, for one too big even alone: what it is, in a line. */
function gistOf(ask: AskView): AskView {
  const gist = ((): TerminalAsk => {
    switch (ask.kind) {
      case 'permission':
        return {
          kind: 'permission',
          id: ask.id,
          tool: cutAt(ask.tool, ASK_LABEL),
          summary: cutAt(ask.summary, ASK_LABEL),
        };
      case 'question': {
        const [first] = ask.questions;
        return {
          kind: 'question',
          id: ask.id,
          questions: first
            ? [
                {
                  header: cutAt(first.header, ASK_LABEL),
                  text: cutAt(first.text, ASK_LABEL),
                  options: [],
                  multiple: first.multiple,
                },
              ]
            : [],
        };
      }
      case 'plan':
        return { kind: 'plan', id: ask.id, plan: cutAt(ask.plan, ASK_LABEL) };
      case 'trust':
        return { kind: 'trust', id: ask.id };
      case 'other':
        return { kind: 'other', id: ask.id, text: cutAt(ask.text, ASK_LABEL) };
    }
  })();
  return { ...gist, cut: true };
}

/** Summary text only; transcript entries retain the complete reply. Count UTF-8 code points. */
export function summaryReply(reply: string | null): Pick<SessionSummary, 'reply' | 'replyCut'> {
  if (reply === null) return { reply };
  let bytes = 0;
  let end = 0;
  for (const character of reply) {
    const code = character.codePointAt(0) ?? 0;
    const size = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    if (bytes + size > MAX_SESSION_REPLY_BYTES)
      return { reply: reply.slice(0, end), replyCut: true };
    bytes += size;
    end += character.length;
  }
  return { reply };
}
