import { DEFAULT_PAGE } from '../../../shared/api/limits';
import type { ResultOf } from '../../../shared/api/registry';
import { turnReply } from '../../../shared/model/session';
import type { Entry } from '../../../shared/model/session';
import { OpFailure } from '../call';
import { agentOf, bytesOf, openCanvas, pageOf } from './open';
import { promptsOf } from './conversation';
import type { Implementations, OpServices } from '.';

type TranscriptEntry = ResultOf<'session.transcript'>['entries'][number];

/** Sessions (Core Server §4 G): an agent's session as it is, its transcript, and interrupting it. */
export function sessionOps({
  engines,
}: OpServices): Pick<Implementations, 'session.get' | 'session.transcript' | 'session.interrupt'> {
  return {
    'session.get': ({ canvas, agent }) => {
      const open = openCanvas(engines, canvas);
      const node = agentOf(open, agent);
      const { engine } = open;
      const session = engine.sessions.of(agent);
      const lastTurn = session.entries.findLast((entry) => entry.kind === 'user');
      return {
        agent,
        connection: engine.catalog.connectionOf(node.data),
        status: session.status,
        paused: engine.run.snapshot().agents[agent]?.paused === true,
        queued: session.queued.length,
        prompts: promptsOf(open, agent),
        ...(session.unheard === undefined ? {} : { unheard: session.unheard }),
        tasks: [...(session.tasks ?? [])],
        commands: [...(session.commands ?? [])],
        mode: session.mode,
        model: session.model,
        effort: session.effort ?? null,
        models: [...(session.models ?? [])],
        ...(session.modes === undefined ? {} : { modes: [...session.modes] }),
        ...(session.running === undefined ? {} : { running: session.running }),
        ...(session.usage === undefined ? {} : { usage: session.usage }),
        reply: lastTurn === undefined ? null : turnReply(session, lastTurn.id) || null,
      };
    },
    'session.transcript': ({ canvas, agent, after, limit = DEFAULT_PAGE }, { caller }) => {
      const open = openCanvas(engines, canvas);
      agentOf(open, agent);
      const { entries } = open.engine.sessions.of(agent);
      const start = after === undefined ? 0 : entries.findIndex((entry) => entry.id === after) + 1;
      if (start === 0 && after !== undefined) {
        throw new OpFailure('not-found', 'That entry isn’t in its transcript (any more).');
      }
      const yours = caller.kind === 'human';
      const page = pageOf(
        entries.slice(start, start + limit).map((entry) => shown(entry, yours)),
        fitted,
      );
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
 * An entry as a transcript gives it: a message's pasted images only counted; and an MCP server's
 * link (often a sign-in) left out for anyone but you (`yours`), as Needs leaves out its form: a
 * link form is yours alone (Core Server R3).
 */
function shown(entry: Entry, yours: boolean): TranscriptEntry {
  if (entry.kind !== 'user') {
    const seen: Entry = { ...entry };
    if (seen.kind === 'elicitation' && !yours) delete seen.url;
    return seen as TranscriptEntry;
  }
  const { images, ...rest } = entry;
  return images === undefined || images.length === 0 ? rest : { ...rest, images: images.length };
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
    ({ ...(capped(lines, chars, items) as object), id: entry.id, cut: true }) as TranscriptEntry;
  const texts = shortest(total, room, (n) => cut(Math.max(n, SHORTEST_TEXT), total));
  return bytesOf(texts) <= room ? texts : shortest(total, room, (n) => cut(SHORTEST_TEXT, n));
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
