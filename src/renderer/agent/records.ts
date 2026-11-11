import type { PartyId } from '../../shared/model/messages';
import type { RecordEntryView } from '../../shared/model/records';
import type { Entry } from '../../shared/model/session';

/*
 * What the window reads of the core's settled records (B19 X3): which entries are records, which
 * of them show, and how a view names the parties they mention. The lines themselves are Settled.tsx's.
 */

/** How many settled lines a Terminal agent's bar keeps in view: the newest. */
export const MAX_SETTLED = 3;

/** How a view names a party: "you" for you, an agent by its name. */
export type Names = (party: PartyId) => string;

/** The default: a party as it is written, "you" and all. */
export const PLAIN_NAMES: Names = (party) => party;

/** The record a session entry is, if it is one: the core adds them to an agent's entries. */
export function recordOf(entry: Entry): RecordEntryView | undefined {
  return (entry.kind as string) === 'record' ? (entry as unknown as RecordEntryView) : undefined;
}

/** The owner entries that have ended: a native decision settled in place. */
export function endedPrompt(entry: Entry): entry is Entry & { kind: 'prompt' } {
  return entry.kind === 'prompt' && entry.outcome !== undefined;
}

/**
 * The records among `entries` that show, in their order: none for a Needs item an owner entry
 * holds, however that entry ended (the owner entry is where it shows).
 */
export function shownRecords(entries: readonly Entry[]): RecordEntryView[] {
  const owned = new Set(entries.flatMap((entry) => (entry.kind === 'prompt' ? [entry.need] : [])));
  return entries.flatMap((entry) => {
    const record = recordOf(entry);
    return record !== undefined && !owned.has(record.need) ? [record] : [];
  });
}
