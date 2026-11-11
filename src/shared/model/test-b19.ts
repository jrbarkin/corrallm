import type { CanvasId } from '../canvas';
import { AskSettlement } from './asks';
import type { Message } from './messages';
import { HANDOFF_EVIDENCE, QUEUE_HANDOFF } from './purpose';
import { recordEntryFor } from './records';
import type { RecordAbout, RecordEntryView } from './records';
import type { MessageView } from './views';

/*
 * For tests (B19 X1): the rows the window projects, built as the core writes them, so that every
 * renderer and shared test reads one shape. Plain data, no clock and no random: a fixture's ids
 * count up, so a test names what it expects. Nothing here runs a CLI, and nothing here may reach
 * the renderer's bundle: only tests import it.
 */

export const B19_CANVAS = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d' as CanvasId;

let count = 0;
/** A message id no other fixture has used: `00000000-0000-4000-8000-0000000000NN`. */
export function nextId(): string {
  count += 1;
  return `00000000-0000-4000-8000-${String(count).padStart(12, '0')}`;
}

/**
 * A queue hand-off from `owner`'s queue (its item `item`) to `recipient`, as the core records it:
 * origin run, purpose handoff, its task the item's attempt, pending until delivery sends it.
 */
export function handoff(
  owner: string,
  recipient: string,
  fields: Partial<MessageView> & { item?: string } = {},
): MessageView {
  const { item = 'hand', ...rest } = fields;
  const id = rest.id ?? nextId();
  return {
    id,
    canvas: B19_CANVAS,
    from: `agent:${owner}`,
    to: `agent:${recipient}`,
    kind: 'text',
    body: 'Review this',
    at: 1_700_000_000_000,
    state: 'pending',
    origin: 'run',
    task: { agent: owner, item, attempt: `attempt-${id.slice(-4)}` },
    purpose: QUEUE_HANDOFF,
    ...rest,
  };
}

/** The evidence a hand-off's turn left: the recipient's record to the owner, never a turn. */
export function evidenceFor(original: MessageView, body = 'APPROVED'): MessageView {
  return {
    id: nextId(),
    canvas: B19_CANVAS,
    from: original.to,
    to: original.from,
    kind: 'text',
    body,
    at: original.at + 1,
    state: 'delivered',
    origin: 'run',
    replyTo: original.id,
    ...(original.task === undefined ? {} : { task: original.task }),
    turn: { status: 'completed', reason: 'completed' },
    purpose: HANDOFF_EVIDENCE,
  };
}

/** The run's own direct send for an item (a message to its own agent): no purpose. */
export function runSend(agent: string, fields: Partial<MessageView> = {}): MessageView {
  return {
    id: nextId(),
    canvas: B19_CANVAS,
    from: `agent:${agent}`,
    to: `agent:${agent}`,
    kind: 'text',
    body: 'Do it',
    at: 1_700_000_000_000,
    state: 'delivering',
    origin: 'run',
    task: { agent, item: 'own', attempt: 'attempt-own' },
    ...fields,
  };
}

/** A party's ordinary message to an agent. */
export function partyMessage(
  from: string,
  to: string,
  fields: Partial<MessageView> = {},
): MessageView {
  return {
    id: nextId(),
    canvas: B19_CANVAS,
    from: from === 'you' ? 'you' : `agent:${from}`,
    to: `agent:${to}`,
    kind: 'text',
    body: 'Hello',
    at: 1_700_000_000_000,
    state: 'pending',
    origin: 'party',
    ...fields,
  };
}

/** A run hold's decision as its agent's window shows it. */
export function holdRecord(agent: string, choice = 'approve'): RecordEntryView {
  const about: RecordAbout = {
    v: 1,
    agent,
    need: `hold/${encodeURIComponent(agent)}/0a1b2c3d/ok`,
    hold: { choice },
  };
  const message: Message = {
    id: nextId(),
    canvas: B19_CANVAS,
    from: 'corrallm',
    to: 'you',
    kind: 'settled',
    body: 'private words that never reach a window',
    state: 'delivered',
    by: 'you',
    at: 1_700_000_000_000,
  };
  return recordEntryFor(message, about);
}

/** An ask's end, as its recipient agent's window shows it (`asker`: the party that asked). */
export function askRecord(agent: string, asker: Message['to'] = 'you'): RecordEntryView {
  const about: RecordAbout = { v: 1, agent, need: 'ask/00000000-0000-4000-8000-0000000000aa' };
  const message: Message = {
    id: nextId(),
    canvas: B19_CANVAS,
    from: 'corrallm',
    to: asker,
    kind: 'settled',
    body: 'private words that never reach a window',
    state: 'delivered',
    at: 1_700_000_000_000,
    settled: AskSettlement.parse({
      v: 1,
      ask: { questions: 1 },
      outcome: { type: 'dismissed' },
    }),
  };
  return recordEntryFor(message, about);
}
