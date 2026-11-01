import type { Entry } from '../../../../shared/model/session';

/*
 * A resumed session's history (what its CLI kept), merged into the transcript the view shows. The
 * transcript may show some of it already: turns it played live, under the same ids, and turns a
 * Terminal session of the agent showed only in short (the message and the last reply, under ids of
 * its own). The rest goes where it happened: after the turn before it, or ahead of the transcript.
 */

/** A turn of history: its message (none for what came before the first), then what followed. */
interface PastTurn {
  user: Extract<Entry, { kind: 'user' }> | undefined;
  entries: Entry[];
}

/** The transcript with the history's turns it does not show put in. */
export function mergeHistory(shown: readonly Entry[], past: readonly Entry[]): Entry[] {
  const known = new Set(past.map((entry) => entry.id));
  const merged = [...shown];
  /** Where the next turn not shown goes: after this place (-1: ahead of everything). */
  let after = -1;
  for (const turn of turns(past)) {
    const places = turn.entries
      .map((entry) => merged.findIndex((other) => other.id === entry.id))
      .filter((place) => place !== -1);
    if (places.length > 0) {
      // The CLI may name its user message differently; a known reply still identifies the turn.
      // Keep the live entry's images and identity, but show the text the agent actually received.
      const user = turn.user;
      if (user) {
        const same = merged.findIndex((entry) => entry.id === user.id);
        const place =
          same !== -1
            ? same
            : merged.findLastIndex((entry, i) => i <= Math.min(...places) && entry.kind === 'user');
        const shown = merged[place];
        if (shown?.kind === 'user') {
          merged[place] = {
            ...shown,
            text: user.text,
            ...(user.promptReply ? { promptReply: true } : {}),
          };
        }
      }
      after = endOfTurn(merged, Math.max(...places));
      continue;
    }
    const brief = turn.user && briefTurn(merged, turn.user.text, after, known);
    if (brief !== undefined) {
      // Its message and replies give way to what the CLI kept; its notices and its end stay.
      const stop = nextMessage(merged, brief);
      const kept = merged
        .slice(brief, stop)
        .filter((entry) => entry.kind !== 'user' && !(entry.kind === 'text' && !entry.parent));
      const fill = turn.entries.filter((entry) => entry.kind !== 'end');
      merged.splice(brief, stop - brief, ...fill, ...kept);
      after = brief + fill.length + kept.length - 1;
      continue;
    }
    merged.splice(after + 1, 0, ...turn.entries);
    after += turn.entries.length;
  }
  return merged;
}

/** History, turn by turn: each starts with a message (but what came before the first). */
function turns(past: readonly Entry[]): PastTurn[] {
  const found: PastTurn[] = [];
  for (const entry of past) {
    const last = found.at(-1);
    if (entry.kind === 'user' || !last) {
      found.push({ user: entry.kind === 'user' ? entry : undefined, entries: [entry] });
    } else {
      last.entries.push(entry);
    }
  }
  return found;
}

/** The place of the next message after `from`, or the transcript's length. */
function nextMessage(entries: readonly Entry[], from: number): number {
  const next = entries.findIndex((entry, i) => i > from && entry.kind === 'user');
  return next === -1 ? entries.length : next;
}

/** Where the turn that `place` is in ends: its end, if it has one yet; otherwise `place`. */
function endOfTurn(entries: readonly Entry[], place: number): number {
  const stop = nextMessage(entries, place);
  const end = entries.findIndex((entry, i) => i >= place && i < stop && entry.kind === 'end');
  return end === -1 ? place : end;
}

/**
 * A turn the transcript shows in short, as a Terminal session tells it, of the message `text`:
 * after `after`, under an id the history does not know, ended, and with nothing but replies and
 * notices. Its place, if there is one.
 */
function briefTurn(
  entries: readonly Entry[],
  text: string,
  after: number,
  known: ReadonlySet<string>,
): number | undefined {
  for (let place = after + 1; place < entries.length; place++) {
    const entry = entries[place];
    if (entry?.kind !== 'user' || entry.text !== text || known.has(entry.id)) continue;
    const rest = entries.slice(place + 1, nextMessage(entries, place));
    const short = rest.every(
      (other) =>
        other.kind === 'end' || other.kind === 'notice' || (other.kind === 'text' && !other.parent),
    );
    if (short && rest.some((other) => other.kind === 'end')) return place;
  }
  return undefined;
}
