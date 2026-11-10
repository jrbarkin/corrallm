import { z } from 'zod';

import { MAX_NEED_ID } from '../api/limits';
import { AskOutcome } from './asks';
import { MAX_NODE_ID } from './canvas';
import { PARTY_PATTERN } from './messages';
import type { Message, PartyId } from './messages';
import { PromptKind } from './prompts';
import type { ChoiceHint } from './prompts';
import type { PromptReader } from './prompt-views';
import { SettledOutcome, SubjectType } from './settled';

/*
 * Settled records in the window (B19 Design §9 C3): how something the core settled ended, shown in
 * its agent's transcript and Terminal bar as a typed display entry (`RecordEntryView`), projected
 * from the record's row by one selector, `recordsFor`, which `session.transcript` and the session
 * topic both read. It is not a second log: the record's row is the only one, kept by the message
 * store's own retention, and its entry is gone with it.
 *
 * - Which records: those the core wrote with an association (`RecordAbout`, the message's `about`
 *   column, migration 13), the agent whose window shows it and the Needs item it settled, written
 *   as the record is, from what the core resolved, never read from names or words: a run hold's
 *   decision (with the choice it picked, by key, and whether words went with it, never the words),
 *   a native prompt's decision, and an ask's end, in its recipient agent's window. A record kept
 *   before migration 13 has none, so it stays in your messages alone.
 * - Deduplicated with B13's owner entries (`shownRecord`): a native prompt's decision its owner made
 *   while this core runs is its owner entry's (settled in place, or still open after a refusal),
 *   never the window's, however that entry ends; one kept from before (a restart, its canvas opened
 *   again), when no owner entry is left, is the window's: one that took effect, or a crash cut off
 *   (`unresolved`).
 * - Its id is its record's message id, namespaced (`record/<id>`), so a reload, a reconnect or a
 *   restart finds the same entry, never a second; its position is the core's: the window leads its
 *   agent's transcript, in the message store's order, so neither native history nor /clear moves it.
 * - At most MAX_RECORD_ENTRIES (the newest) per agent, within the message store's retention: B13's
 *   100 ended owner entries and every live prompt are counted apart and unchanged.
 * - Yours alone: records of decisions are addressed to you, and no token reaching a session reads
 *   one, in its transcript, its topic, a count or an error.
 * - Value-free: what kind of thing was settled, how (a choice's key, hint or count, a form's action,
 *   an ask's outcome), by whom and when, and whether corrallm can tell it took effect: never a
 *   title, label, command, path, plan, feedback, answer, value or the record's words.
 *
 * Keep this module free of Node, Electron and DOM imports: it is compiled into every process.
 */

/** How many ended records each agent's window shows, the newest. */
export const MAX_RECORD_ENTRIES = 100;

/** What a record entry's id starts with: its record's message id follows. */
export const RECORD_ENTRY = 'record/';

/** A record entry's id: its record's message id, namespaced. */
export function recordEntryId(message: string): string {
  return `${RECORD_ENTRY}${message}`;
}

/**
 * The words that say corrallm was cut off answering a native prompt: its answer may not have reached
 * the CLI, and it isn't given again (decisions.ts' `recoverDecisions` ends a record's words with it).
 */
export const UNRESOLVED_ANSWER =
  'corrallm stopped as it was answering, so it may not have reached the agent’s CLI. It isn’t sent again: look at the agent’s session.';

/** A run hold's choice, by its key (src/shared/model/run-words.ts): never its label. */
const HoldChoice = z.string().regex(/^[a-z][A-Za-z]{0,31}$/);

/**
 * A record's association (B19 C3), core-written with the record and never changed after (the
 * message's `about` column, migration 13): the agent whose window shows it, the Needs item it
 * settled, and for a run hold's decision what was chosen, by key, and whether words went with it.
 * Never words, a title or a label.
 */
export const RecordAbout = z
  .strictObject({
    v: z.literal(1),
    agent: z.string().min(1).max(MAX_NODE_ID),
    need: z.string().min(1).max(MAX_NEED_ID),
    hold: z
      .strictObject({ choice: HoldChoice.optional(), words: z.literal(true).optional() })
      .optional(),
  })
  .refine(({ need, hold }) => hold === undefined || need.startsWith('hold/'), 'Only a hold’s')
  .refine(({ agent, need }) => {
    // A hold's or a prompt's Needs item names its agent, escaped: it is the agent's.
    const [kind, named] = need.split('/');
    if (kind !== 'hold' && kind !== 'prompt') return true;
    try {
      return named !== undefined && decodeURIComponent(named) === agent;
    } catch {
      return false;
    }
  }, 'Its Needs item is its agent’s');
export type RecordAbout = z.infer<typeof RecordAbout>;

/** What a record settled, value-free (RecordEntryView). */
export const RecordView = z.discriminatedUnion('type', [
  /** A run hold's decision: the choice picked, by key, and whether words went with it. */
  z.strictObject({
    type: z.literal('hold'),
    choice: HoldChoice.optional(),
    words: z.literal(true).optional(),
  }),
  /** A native prompt's decision: its kind, its subject's type, and what was chosen. */
  z.strictObject({
    type: z.literal('prompt'),
    prompt: z.strictObject({ kind: PromptKind, subject: SubjectType.optional() }),
    outcome: SettledOutcome,
    secret: z.literal(true).optional(),
  }),
  /** An ask's end: whose it was, how many questions it asked, and how it ended. */
  z.strictObject({
    type: z.literal('ask'),
    asker: z.string().regex(PARTY_PATTERN),
    questions: z.int().min(1),
    outcome: AskOutcome,
  }),
]);
export type RecordView = z.infer<typeof RecordView>;

/**
 * A settled record as its agent's window shows it (B19 C3): a transcript entry of its own kind,
 * under its record's id namespaced, naming the record (`message`, which your messages hold while
 * it is kept) and the Needs item it settled, when it was recorded, who decided, whether it took
 * effect as far as corrallm can tell (`unresolved`: corrallm was cut off answering, so it may not
 * have), and what it settled. `cut`: never, but a page's own mark is allowed on every entry.
 */
export const RecordEntry = z.strictObject({
  id: z.string().startsWith(RECORD_ENTRY),
  kind: z.literal('record'),
  message: z.uuid(),
  need: z.string().max(MAX_NEED_ID),
  at: z.number(),
  by: z.string().regex(PARTY_PATTERN).optional(),
  state: z.enum(['settled', 'unresolved']),
  record: RecordView,
  cut: z.literal(true).optional(),
});
export interface RecordEntryView {
  readonly id: string;
  readonly kind: 'record';
  readonly message: string;
  readonly need: string;
  readonly at: number;
  readonly by?: PartyId;
  readonly state: 'settled' | 'unresolved';
  readonly record: Readonly<RecordView>;
  readonly cut?: true;
}

/** A record the message store keeps, with the association the core wrote with it. */
export interface RecordRow {
  readonly message: Message;
  readonly about: RecordAbout;
}

/**
 * Whether a record shows in its agent's window: one with the core's association (none: your
 * messages alone), a record's kind; a run hold's decision, made in the write that kept it; an ask's
 * end, however its asker is sent it; and a native prompt's decision that took effect, or that a
 * crash cut off, unless its prompt's owner made it while this core runs (`owned`): then B13's owner
 * entry shows it (settled in place, or open again after its CLI refused it), and once B13's cap or a
 * /clear drops that entry nothing brings it back. Owner entries live only while the core runs, so
 * one kept from before (a restart, its canvas opened again) is shown here, once.
 */
export function shownRecord(
  message: Message,
  about: RecordAbout | undefined,
  owned = false,
): boolean {
  if (about === undefined || message.kind !== 'settled') return false;
  const { settled } = message;
  if (settled === undefined) return message.state === 'delivered';
  if ('ask' in settled) return true;
  return !owned && (message.state === 'delivered' || message.state === 'unresolved');
}

/** A record kept with its association, as its window's entry. */
export function recordEntryFor(message: Message, about: RecordAbout): RecordEntryView {
  const { settled } = message;
  const record: RecordView =
    settled === undefined
      ? {
          type: 'hold',
          ...(about.hold?.choice === undefined ? {} : { choice: about.hold.choice }),
          ...(about.hold?.words === true ? { words: true as const } : {}),
        }
      : 'ask' in settled
        ? {
            type: 'ask',
            asker: message.to,
            questions: settled.ask.questions,
            outcome: settled.outcome,
          }
        : {
            type: 'prompt',
            prompt: {
              kind: settled.prompt.kind,
              ...(settled.prompt.subject === undefined ? {} : { subject: settled.prompt.subject }),
            },
            outcome: settled.outcome,
            ...(settled.secret === true ? { secret: true as const } : {}),
          };
  return {
    id: recordEntryId(message.id),
    kind: 'record',
    message: message.id,
    need: about.need,
    at: message.at,
    ...(message.by === undefined ? {} : { by: message.by }),
    state: record.type === 'prompt' && message.state === 'unresolved' ? 'unresolved' : 'settled',
    record,
  };
}

/**
 * An agent's window as `reader` sees it (B19 C3), the one selector `session.transcript` and the
 * session topic read: you, each record the window holds, in its order; a token reaching the agent,
 * none (a decision addressed to you is never a token's to read).
 */
export function recordsFor(
  window: readonly RecordRow[],
  reader: PromptReader,
): readonly RecordEntryView[] {
  if (reader !== 'you') return [];
  return window.map(({ message, about }) => recordEntryFor(message, about));
}

/**
 * A record entry in the core's words: what was decided and by whom, never a value. Only a native
 * prompt's decision can be one corrallm was cut off answering, and says so (UNRESOLVED_ANSWER),
 * never that it was applied: a hold's was decided in the write that kept it, and an ask ended
 * whatever became of its asker's turn of it, so either is always settled. `name`: a party's name as
 * the reader's view shows it ("you" for you).
 */
export function recordWords(entry: RecordEntryView, name: (party: PartyId) => string): string {
  const who = name(entry.by ?? 'you');
  const { record } = entry;
  switch (record.type) {
    case 'hold': {
      const verb =
        record.choice === undefined
          ? record.words === true
            ? 'Changes asked for'
            : 'Answered'
          : (HELD[record.choice] ?? 'Answered');
      const words = record.choice !== undefined && record.words === true ? ', with words' : '';
      return `${verb} by ${who}${words}.`;
    }
    case 'prompt': {
      const verb = decided(record);
      return entry.state === 'unresolved'
        ? `${verb} by ${who}, but ${UNRESOLVED_ANSWER}`
        : `${verb} by ${who}.`;
    }
    case 'ask': {
      const asker = `${name(record.asker as PartyId)}’s question`;
      switch (record.outcome.type) {
        case 'expired':
          return `${asker} expired unanswered.`;
        case 'dismissed':
          return `${asker} was dismissed, unanswered.`;
        case 'withdrawn':
          return `${asker} was withdrawn, unanswered.`;
        // Never a record's today (an ask answered sends its asker the answer, not a record), but
        // an ask's settlement may say so, and a row another version kept may: worded truly too.
        case 'answers':
        case 'text':
          return `${asker} was answered.`;
      }
    }
  }
}

/**
 * What each of a run hold's fixed choices did (their keys: src/shared/model/run-words.ts), as a
 * verb: the core's own words, never a choice's label (a Switch's names an agent and a connection).
 * A key not here is answered in general words.
 */
const HELD: Readonly<Record<string, string>> = {
  approve: 'Approved',
  stop: 'Stopped here',
  more: 'Given one more round',
  goOn: 'Told to go on',
  retry: 'Retried',
  yes: 'Judged to hold',
  no: 'Judged not to hold',
  wait: 'Told to wait for the reset',
  resolve: 'Marked resolved',
  continue: 'Continued',
  skip: 'Skipped',
  switch: 'Switched',
};

/** What a native prompt's decision did, as a verb: never a label or a value. */
function decided(record: Extract<RecordView, { type: 'prompt' }>): string {
  const { outcome } = record;
  switch (outcome.type) {
    case 'choice':
      return CHOSE[outcome.hint];
    case 'answers':
      return record.secret === true ? 'Answered (secret)' : 'Answered';
    case 'form':
      return outcome.action === 'accept'
        ? 'Submitted'
        : outcome.action === 'decline'
          ? 'Declined'
          : 'Cancelled';
  }
}

/** What a choice's hint says was done. */
const CHOSE: Readonly<Record<ChoiceHint, string>> = {
  allow_once: 'Allowed once',
  allow_always: 'Always allowed',
  reject_once: 'Declined',
  reject_always: 'Always declined',
};
