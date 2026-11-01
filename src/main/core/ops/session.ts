import { DEFAULT_PAGE } from '../../../shared/api/limits';
import type { ResultOf } from '../../../shared/api/registry';
import { OpFailure } from '../call';
import { agentOf, bytesOf, openCanvas, pageOf } from './open';
import { sessionSummary, transcriptOf } from './views';
import type { Implementations, OpServices } from '.';

type TranscriptEntry = ResultOf<'session.transcript'>['entries'][number];

/** Sessions (Core Server §4 G): an agent's session as it is, its transcript, and interrupting it. */
export function sessionOps({
  engines,
}: OpServices): Pick<
  Implementations,
  'session.get' | 'session.transcript' | 'session.handoff' | 'session.interrupt'
> {
  return {
    'session.get': ({ canvas, agent }, { caller }) =>
      sessionSummary(openCanvas(engines, canvas), agent, caller.kind === 'human'),
    // B11a C10: the agent's latest handoff, as whoever reads its session may: read and returned
    // in its scope, with nothing awaited between its reach's check and its answer.
    'session.handoff': ({ canvas, agent }) => {
      const open = openCanvas(engines, canvas);
      agentOf(open, agent);
      return { handoff: open.handoffs.of(agent)?.handoff ?? null };
    },
    'session.transcript': ({ canvas, agent, after, limit = DEFAULT_PAGE }, { caller }) => {
      const open = openCanvas(engines, canvas);
      // The transcript as the caller sees it, whole (as its topic gives it), then paged.
      const { entries, shown } = transcriptOf(open, agent, caller);
      const start = after === undefined ? 0 : entries.findIndex((entry) => entry.id === after) + 1;
      if (start === 0 && after !== undefined) {
        throw new OpFailure('not-found', 'That entry isn’t in its transcript (any more).');
      }
      const page = pageOf(shown.slice(start, start + limit) as TranscriptEntry[], fitted);
      return { entries: page, next: page.at(-1)?.id ?? after ?? null };
    },
    'session.interrupt': ({ canvas, agent }) => {
      const open = openCanvas(engines, canvas);
      agentOf(open, agent);
      open.engine.sessions.stop(agent);
      return {};
    },
  };
}

/**
 * The shortest a text in an entry is cut: longer than any of the words an entry's fields take from
 * a list (a status, a level, an answer).
 */
const SHORTEST_TEXT = 64;

/**
 * An entry cut to fit `room` bytes of JSON, and marked so (the whole of it stays in the session):
 * a diff's last lines left out, each line kept whole; then, if it is still too big, whatever its
 * kind, every text in it but its id (a message, a reply, a plan, an output, a command) cut to the
 * longest length that fits, no shorter than SHORTEST_TEXT; then every list in it to the most items
 * that fit.
 */
function fitted(entry: TranscriptEntry, room: number): TranscriptEntry {
  const lines = withFewerLines(entry, room);
  if (bytesOf(lines) <= room) return lines;
  const total = bytesOf(lines);
  const cut = (chars: number, items: number) =>
    whole(entry, {
      ...(capped(lines, chars, items) as object),
      id: entry.id,
      cut: true,
    } as TranscriptEntry);
  const texts = shortest(total, room, (n) => cut(Math.max(n, SHORTEST_TEXT), total));
  return bytesOf(texts) <= room ? texts : shortest(total, room, (n) => cut(SHORTEST_TEXT, n));
}

/**
 * A cut entry with what names things whole again: a prompt the core's owner holds keeps its Needs
 * id (what `reply` names), and its prompt's id, kind and agent (B13 C9), whatever else was cut.
 */
function whole(entry: TranscriptEntry, cut: TranscriptEntry): TranscriptEntry {
  if (entry.kind !== 'prompt' || cut.kind !== 'prompt') return cut;
  const { id, kind, agent } = entry.prompt;
  return { ...cut, need: entry.need, prompt: { ...cut.prompt, id, kind, agent } };
}

/** A tool's or a permission's diff with its last lines left out to fit `room` bytes of JSON. */
function withFewerLines(entry: TranscriptEntry, room: number): TranscriptEntry {
  if (entry.kind !== 'tool' && entry.kind !== 'permission') return entry;
  const { detail } = entry;
  if (detail?.kind !== 'diff') return entry;
  return shortest(detail.lines.length, room, (n) => ({
    ...entry,
    detail: { ...detail, lines: detail.lines.slice(0, n) },
    cut: true,
  }));
}

/** `value` with every text in it cut to at most `chars` characters, and every list to `items`. */
function capped(value: unknown, chars: number, items: number): unknown {
  if (typeof value === 'string') return value.length > chars ? cutAt(value, chars) : value;
  if (Array.isArray(value)) return value.slice(0, items).map((one) => capped(one, chars, items));
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, one]) => [key, capped(one, chars, items)]),
  );
}

/** The longest of `make(0)` to `make(total)` that fits `room` bytes of JSON (else the shortest). */
function shortest<T>(total: number, room: number, make: (n: number) => T): T {
  let [fits, over] = [0, total + 1];
  while (over - fits > 1) {
    const n = Math.floor((fits + over) / 2);
    if (bytesOf(make(n)) <= room) fits = n;
    else over = n;
  }
  return make(fits);
}

/** The first `n` UTF-16 units of `text`, never half a character. */
function cutAt(text: string, n: number): string {
  const code = text.charCodeAt(n - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? n - 1 : n);
}
