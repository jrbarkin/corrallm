import type { AgentId } from '../api/ids';
import type { ConnectionId } from '../adapter';
import type { BackgroundTask, SlashCommand } from '../session';
import type { Message, MessageDisplay, MessageOrigin } from './messages';
import type { QueueItem } from './queue';
import type { Run } from './run';
import { isOpen, turnReply } from './session';
import type { Entry, Session } from './session';

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
export interface RunView extends Omit<RunSnapshot, 'agents'> {
  readonly agents: Readonly<Record<AgentId, RunSnapshot['agents'][string]>>;
  readonly notices: readonly RunNotice[];
  readonly saveError?: string;
}

/** The single summary DTO, matching session.get (entries travel on the per-agent topic). */
export interface SessionSummary {
  readonly agent: string;
  readonly connection: ConnectionId;
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
}

/** Images are counted for display, never serialized as bytes on the general topic. */
export type EntryView = ReadonlyData<
  | Exclude<Entry, { kind: 'user' }>
  | (Omit<Extract<Entry, { kind: 'user' }>, 'images'> & { images?: number })
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

function share(next: unknown, previous: unknown): unknown {
  if (typeof next === 'function') throw new TypeError('A view contains data, never a function.');
  if (next === null || typeof next !== 'object') return next;
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
  return Object.freeze(
    Array.isArray(next) ? entries.map(([, value]) => value) : Object.fromEntries(entries),
  );
}

export function runView(
  run: Run,
  previous?: RunView,
  meta: { notices?: readonly RunNotice[]; saveError?: string } = {},
): RunView {
  return projectData(
    {
      ...run,
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
): SessionView {
  const last = session.entries.findLast((entry) => entry.kind === 'user');
  const summary: SessionSummary = {
    agent,
    connection,
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
    reply: last === undefined ? null : turnReply(session, last.id) || null,
  };
  const entries = Object.fromEntries(
    session.entries.map((entry): readonly [string, EntryView] => {
      if (entry.kind !== 'user') return [entry.id, entry];
      const { images, ...rest } = entry;
      return [entry.id, images?.length ? { ...rest, images: images.length } : rest];
    }),
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
