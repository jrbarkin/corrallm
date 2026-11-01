import type { CanvasId } from '../canvas';
import type { TurnResult } from '../session';
import { MAX_NODE_ID } from './canvas';
import type { SettledDecision } from './settled';

/*
 * Messages (API Spec §5): what parties send each other on a canvas, as the core keeps them (its
 * message store, src/main/core/delivery/messages.ts). A party is you, corrallm itself, one of the
 * canvas's agents, or an orchestrator outside corrallm, by the name a person gave its token. A
 * message to an agent waits until the agent is idle and nothing holds it, is delivered to its
 * session as a turn, and once that turn ends, what the agent replied is a message back to its
 * sender. Records (corrallm telling a party something) are never delivered as turns.
 *
 * Keep this module free of Node, Electron and DOM imports: it is compiled into every process.
 */

/**
 * Who sends or receives a message: you, corrallm, an agent of the canvas (by its id), or an outside
 * orchestrator (by its token's name). The prefixes keep an agent named "you" from posing as you.
 */
export type PartyId = 'you' | 'corrallm' | `agent:${string}` | `outside:${string}`;

/**
 * A party id's shape: what a party id passed to an operation, or read back from the store, must
 * look like. An agent's holds its node's id, which may be any text (line breaks too).
 */
export const PARTY_PATTERN = new RegExp(
  `^(you|corrallm|agent:[\\s\\S]{1,${String(MAX_NODE_ID)}}|outside:[A-Za-z][A-Za-z0-9._-]{0,31})$`,
);

/** The party an agent of the canvas is. */
export const agentParty = (agent: string): PartyId => `agent:${agent}`;

/** The agent a party is, if it is one. */
export function agentOf(party: PartyId): string | undefined {
  return party.startsWith('agent:') ? party.slice('agent:'.length) : undefined;
}

/** The name of the outside orchestrator a party is, if it is one. */
export function outsideOf(party: PartyId): string | undefined {
  return party.startsWith('outside:') ? party.slice('outside:'.length) : undefined;
}

/**
 * Where a message is. pending: waiting to be delivered to its agent. delivering: journaled, and
 * handed to the agent's session. delivered: the session has it (a message to an agent, its turn
 * going on), or it was stored for a party that reads it (you, an outside orchestrator). replied:
 * its turn ended. answered: a prompt it carried was answered. withdrawn: taken back before or
 * during its turn. expired: an ask whose deadline passed. unresolved: cut off while it was being
 * delivered, or delivered with no turn end (a crash, a restart, a closed canvas): never sent again.
 */
export const MESSAGE_STATES = [
  'pending',
  'delivering',
  'delivered',
  'replied',
  'answered',
  'withdrawn',
  'expired',
  'unresolved',
] as const;
export type MessageState = (typeof MESSAGE_STATES)[number];

/**
 * What a message is: text from a party (`message`, an agent's reply); a prompt carried to another
 * answerer than you; or a record: a task's verdict (`result`), a prompt's end (`settled`), or
 * corrallm telling a party something (`notice`).
 */
export const MESSAGE_KINDS = ['text', 'prompt', 'result', 'settled', 'notice'] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

/**
 * How a message came to be (B11 §3), as the core records it, never as a caller says: typed by you
 * (`manual`: your sends, which go past the run's holds); a party's or corrallm's (`party`: another
 * party's message or an agent's reply, a prompt carried, a record); the run's own (`run`); or one
 * you asked to send again (`resend`, which waits on the holds as any other's does). Who wrote it is
 * its `from`, which this never changes.
 */
export const MESSAGE_ORIGINS = ['manual', 'party', 'run', 'resend'] as const;
export type MessageOrigin = (typeof MESSAGE_ORIGINS)[number];

/**
 * What a view shows of a message beside its body: where it goes in its agent's queue (`after` the
 * task it followed, `task` the held task it corrected), the text shown for it if not its body, how
 * many images it carried and whether it can't be sent without them (images themselves are never
 * kept, so one that requires them is never sent once they are gone).
 */
export interface MessageDisplay {
  readonly after?: string;
  readonly task?: { readonly agent: string; readonly item: string };
  readonly text?: string;
  readonly images?: number;
  readonly requiresImages?: true;
}

/**
 * A message, as the core keeps it. `delivery`: when it was handed to the agent's session, the id
 * the session was sent it under (its turn ends naming that id), and which attempt that was.
 * `task`: the queue task a hand-off, an ask or a verdict belongs to. `turn`: how the turn an
 * agent's reply came from ended, or why a message ended withdrawn or unresolved. `by`: who
 * withdrew it. `resendOf`: the message it sends again, at your request (never a reply to it:
 * `replyTo` is only a reply's, or a record's about another message). `settled`: for a record of a
 * native prompt's decision, what was decided, typed and value-free (./settled.ts), never changed
 * after; yours alone to read. Images a message carried are never kept.
 */
export interface Message {
  id: string;
  canvas: CanvasId;
  from: PartyId;
  to: PartyId;
  kind: MessageKind;
  /** At most MAX_MESSAGE_BYTES of UTF-8 (src/shared/api/limits.ts). */
  body: string;
  replyTo?: string;
  resendOf?: string;
  task?: { agent: string; item: string; attempt: string };
  turn?: TurnResult;
  state: MessageState;
  delivery?: { at: number; as: string; attempt: number };
  by?: PartyId;
  settled?: SettledDecision;
  /** When it was sent, in epoch ms. */
  at: number;
}

/**
 * Whether a message is settled: nothing more will happen to it. A message to an agent isn't while
 * it waits, is being delivered or its turn goes on; one cut off isn't either, so it can be retried.
 */
export function isSettled(message: Message): boolean {
  switch (message.state) {
    case 'pending':
    case 'delivering':
    case 'unresolved':
      return false;
    case 'delivered':
      return agentOf(message.to) === undefined || message.kind !== 'text';
    default:
      return true;
  }
}
