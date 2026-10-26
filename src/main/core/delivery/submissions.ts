import { MAX_MESSAGE_BYTES } from '../../../shared/api/limits';
import { decodeSubmissions, encodeRecords } from '../engine/delivery/submission-state';
import { agentOf, agentParty } from '../../../shared/model/messages';
import type { Message, MessageDisplay } from '../../../shared/model/messages';
import type { SubmittedMessage } from '../../../shared/model/queue';
import { MAX_ID_LENGTH, MAX_MESSAGE_LENGTH } from '../../../shared/session';
import type { TurnResult } from '../../../shared/session';
import type { MessageStore } from './messages';

/*
 * Your manual submissions, as the mailbox keeps them (B11 Design §4, from schema 4): each your
 * message to its agent (origin manual, or resend for one you resent), never a run checkpoint's,
 * until B11's view rows replace the engines' submissions (X12, X13). The journal (run-journal.ts)
 * keeps an engine's submissions so (`keepSubmissions`, within the write that journals its run),
 * and gives them back as its run is restored (`submissionsOf`), in the form the engine restores.
 *
 * A submission is matched, never by an equal body, to a message that represents it already: by
 * the agent it went to and the native id it was sent under (the message's delivery.as), or by its
 * own id. One that does keeps its own record, gaining only where its submission showed; one that
 * doesn't is made, once: its body the submission's text, cut to the most a message holds
 * (MAX_MESSAGE_BYTES) where it is longer, whose whole text its display then shows and gives back
 * (a submission held more than a message may). What its engine still runs, or what waits in its
 * session, is kept as a restart would leave it (unresolved, never sent again) until its turn ends,
 * so that it is never active to delivery, which never sent it. A message made so is changed as its
 * submission does, while this core runs; one given back as a run was restored, or one delivery
 * made, never is.
 */

/** What the bridge knows of a canvas's store, while this core runs. */
interface Bridged {
  /** The messages it made, by the agent's party and the native id: changed as they do. */
  made: Map<string, string>;
  /** Every submission it has seen, made or not: never made again, though its message goes. */
  seen: Set<string>;
}
const bridged = new WeakMap<MessageStore, Bridged>();

function bridgeOf(store: MessageStore): Bridged {
  let bridge = bridged.get(store);
  if (bridge === undefined) {
    bridge = { made: new Map(), seen: new Set() };
    bridged.set(store, bridge);
  }
  return bridge;
}

const keyOf = (to: string, as: string): string => `${to}\u0000${as}`;

/**
 * The submission records of a checkpoint, as the engine restores them (decodeSubmissions): each
 * one no engine restores (a native prompt longer than it keeps, an id it doesn't) left out, said
 * on the console, rather than failing the write that journals the run and its messages. Throws
 * for what isn't an engine's records at all.
 */
export function recordsIn(serialized: string): Map<string, SubmittedMessage[]> {
  try {
    return decodeSubmissions(serialized);
  } catch (error) {
    const root: unknown = JSON.parse(serialized);
    if (!isRecord(root) || root.version !== 1 || !Array.isArray(root.agents)) throw error;
    const kept = new Map<string, SubmittedMessage[]>();
    let left = 0;
    for (const agent of root.agents as unknown[]) {
      const submissions = isRecord(agent) ? agent.submissions : undefined;
      if (!isRecord(agent) || !Array.isArray(submissions)) throw error;
      for (const one of submissions as unknown[]) {
        try {
          for (const [id, records] of decodeSubmissions(
            JSON.stringify({ version: 1, agents: [{ id: agent.id, submissions: [one] }] }),
          )) {
            kept.set(id, [...(kept.get(id) ?? []), ...records]);
          }
        } catch {
          left += 1;
        }
      }
    }
    console.error(
      `${String(left)} submission record(s) no engine restores were left out of the run’s messages.`,
    );
    return kept;
  }
}

/**
 * Keeps each agent's submissions as your messages in the canvas's store: within the write that
 * journals its run, which writes the store's changes too, or with the store's next.
 */
export function keepSubmissions(
  store: MessageStore,
  records: ReadonlyMap<string, readonly SubmittedMessage[]>,
  now: number,
): void {
  const bridge = bridgeOf(store);
  let represented: Map<string, Message> | undefined;
  for (const [agent, submissions] of records) {
    const to = agentParty(agent);
    for (const record of submissions) {
      const key = keyOf(to, record.id);
      const { state, turn } = outcomeOf(record);
      const body = bodyOf(record.text);
      const display = displayOf(record, body);
      const made = bridge.made.get(key);
      if (made !== undefined) {
        const message = store.get(made);
        if (message === undefined) continue;
        if (message.state !== state || JSON.stringify(message.turn) !== JSON.stringify(turn)) {
          store.update(made, { state, turn });
        }
        if (JSON.stringify(store.displayOf(made)) !== JSON.stringify(display)) {
          store.redisplay(made, display);
        }
        continue;
      }
      if (bridge.seen.has(key)) continue;
      bridge.seen.add(key);
      represented ??= aliases(store);
      const own = store.get(record.id);
      const there = represented.get(key) ?? (own?.to === to ? own : undefined);
      if (there !== undefined) {
        // Its own record stays as it is kept; it only gains where its submission showed.
        const shown = displayOf(record);
        if (store.displayOf(there.id) === undefined && shown !== undefined) {
          store.redisplay(there.id, shown);
        }
        continue;
      }
      const resendOf =
        record.retryOf === undefined
          ? undefined
          : (bridge.made.get(keyOf(to, record.retryOf)) ??
            represented.get(keyOf(to, record.retryOf))?.id);
      const message = store.add({
        from: 'you',
        to,
        kind: 'text',
        origin: record.retryOf === undefined ? 'manual' : 'resend',
        ...(display === undefined ? {} : { display }),
        body,
        ...(resendOf === undefined ? {} : { resendOf }),
        turn,
        state,
        delivery: { at: now, as: record.id, attempt: 1 },
      });
      bridge.made.set(key, message.id);
      represented.set(key, message);
    }
  }
}

/**
 * Your submissions as the canvas's store keeps them, in the form an engine restores
 * (encodeSubmissions'): each of your messages to an agent the session had (its native id its
 * delivery's), by agent, in their order. What went on as the core stopped is restored unresolved.
 */
export function submissionsOf(store: MessageStore): string {
  const bridge = bridgeOf(store);
  const agents = new Map<string, SubmittedMessage[]>();
  // How each turn delivery handed ended: kept on its reply.
  const ended = new Map<string, TurnResult>();
  for (const message of store.all()) {
    if (message.kind === 'text' && message.replyTo !== undefined && message.turn !== undefined) {
      ended.set(message.replyTo, message.turn);
    }
  }
  for (const message of store.all()) {
    const record = recordOf(store, message, ended.get(message.id));
    const agent = agentOf(message.to);
    if (record === undefined || agent === undefined || message.delivery === undefined) continue;
    bridge.seen.add(keyOf(message.to, message.delivery.as));
    const records = agents.get(agent) ?? [];
    records.push(record);
    agents.set(agent, records);
  }
  return encodeRecords(agents);
}

/**
 * A message of yours to an agent, as the submission its session had (how its turn ended its own,
 * or its reply's): none for any other.
 */
function recordOf(
  store: MessageStore,
  message: Message,
  replied: TurnResult | undefined,
): SubmittedMessage | undefined {
  const origin = store.originOf(message.id);
  const as = message.delivery?.as;
  // Yours alone: a party's message, resent or not, was never a submission.
  if (
    message.kind !== 'text' ||
    message.from !== 'you' ||
    (origin !== 'manual' && origin !== 'resend') ||
    as === undefined ||
    !isId(as)
  ) {
    return undefined;
  }
  const display = store.displayOf(message.id);
  const text = display?.text ?? message.body;
  if (text.length > MAX_MESSAGE_LENGTH) return undefined;
  const status = statusOf(
    message.turn === undefined && replied !== undefined ? { ...message, turn: replied } : message,
  );
  if (status === undefined) return undefined;
  const original = message.resendOf === undefined ? undefined : store.get(message.resendOf);
  const retryOf = original?.delivery?.as;
  const after = display?.after;
  const task = display?.task;
  return {
    id: as,
    text,
    ...status,
    ...(after !== undefined && isId(after) ? { after } : {}),
    ...(task !== undefined && isId(task.agent) && isId(task.item)
      ? { task: { agent: task.agent, item: task.item } }
      : {}),
    ...(retryOf !== undefined && isId(retryOf) ? { retryOf } : {}),
  };
}

/** How a message's submission stands: as its session had it, or as a restart leaves it. */
function statusOf(
  message: Message,
): Pick<SubmittedMessage, 'status' | 'result' | 'unresolved'> | undefined {
  const { state, turn } = message;
  const result = turn === undefined ? {} : { result: turn };
  switch (state) {
    case 'replied':
      return { status: turn?.status ?? 'completed', ...result };
    case 'withdrawn':
      return { status: 'cancelled', ...result };
    case 'unresolved':
      return { status: 'cancelled', unresolved: true, ...result };
    case 'delivering':
    case 'delivered':
      // Its turn went on as the core stopped: restored unresolved, never sent again.
      return { status: 'running' };
    default:
      // Not yet a submission: delivery sends it, or sent it as another.
      return undefined;
  }
}

/** A submission's message, as it stands: what its engine runs still, a restart's outcome. */
function outcomeOf(record: SubmittedMessage): {
  state: 'replied' | 'unresolved';
  turn: TurnResult;
} {
  if (record.status === 'queued' || record.status === 'running' || record.unresolved === true) {
    return {
      state: 'unresolved',
      turn: record.unresolved === true && record.result !== undefined ? record.result : UNRESOLVED,
    };
  }
  return { state: 'replied', turn: record.result ?? plainResult(record.status) };
}

const UNRESOLVED: TurnResult = {
  status: 'cancelled',
  reason: 'interrupted',
  message: 'Unresolved after restart; resume the queue to continue.',
};

/** A result for a record that has none: its status, with that status's plainest reason. */
function plainResult(status: 'completed' | 'failed' | 'cancelled'): TurnResult {
  const reason = ({ completed: 'completed', failed: 'error', cancelled: 'interrupted' } as const)[
    status
  ];
  return { status, reason };
}

/**
 * Where a submission showed in its agent's queue, and its whole text where `body`, its message's,
 * holds it cut.
 */
function displayOf(record: SubmittedMessage, body?: string): MessageDisplay | undefined {
  const text = body === undefined || body === record.text ? undefined : record.text;
  if (record.after === undefined && record.task === undefined && text === undefined) {
    return undefined;
  }
  return {
    ...(record.after === undefined ? {} : { after: record.after }),
    ...(record.task === undefined
      ? {}
      : { task: { agent: record.task.agent, item: record.task.item } }),
    ...(text === undefined ? {} : { text }),
  };
}

/** How a submission cut to the most a message holds is marked. */
const CUT = '\n\n[corrallm: cut here; the whole message is in its transcript]';

/**
 * A submission's text as its message's body holds it: whole, or cut on a character's boundary to
 * the most a message holds (MAX_MESSAGE_BYTES of UTF-8), marked so.
 */
function bodyOf(text: string): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= MAX_MESSAGE_BYTES) return text;
  const room = MAX_MESSAGE_BYTES - new TextEncoder().encode(CUT).length;
  // The decoder ends a character cut in two with U+FFFD, dropped here.
  const kept = new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, room));
  return `${kept.replace(/\uFFFD$/u, '')}${CUT}`;
}

/** The store's messages to agents, by the agent's party and the native id each went under. */
function aliases(store: MessageStore): Map<string, Message> {
  const found = new Map<string, Message>();
  for (const message of store.all()) {
    const as = message.delivery?.as;
    if (as === undefined || agentOf(message.to) === undefined) continue;
    const key = keyOf(message.to, as);
    if (!found.has(key)) found.set(key, message);
  }
  return found;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** An id the engine restores (submission-state.ts' decodeSubmissions). */
function isId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH &&
    !/\p{Cc}/u.test(value) &&
    !['__proto__', 'prototype', 'constructor'].includes(value)
  );
}
