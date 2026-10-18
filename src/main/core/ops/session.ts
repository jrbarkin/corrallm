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
    'session.transcript': ({ canvas, agent, after, limit = DEFAULT_PAGE }) => {
      const open = openCanvas(engines, canvas);
      agentOf(open, agent);
      const { entries } = open.engine.sessions.of(agent);
      const start = after === undefined ? 0 : entries.findIndex((entry) => entry.id === after) + 1;
      if (start === 0 && after !== undefined) {
        throw new OpFailure('not-found', 'That entry isn’t in its transcript (any more).');
      }
      const page = pageOf(entries.slice(start, start + limit).map(shown), fitted);
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

/** An entry as a transcript gives it: a message's pasted images only counted. */
function shown(entry: Entry): TranscriptEntry {
  if (entry.kind !== 'user') return entry as TranscriptEntry;
  const { images, ...rest } = entry;
  return images === undefined || images.length === 0 ? rest : { ...rest, images: images.length };
}

/**
 * An entry cut to fit `room` bytes of JSON, and marked so: its text, its plan, its tool's output or
 * its diff's lines shortened (the whole of it stays in the session). Another kind is never long.
 */
function fitted(entry: TranscriptEntry, room: number): TranscriptEntry {
  switch (entry.kind) {
    case 'text':
    case 'thinking':
      return shortest(entry.text.length, room, (n) => ({
        ...entry,
        text: cutAt(entry.text, n),
        cut: true,
      }));
    case 'plan':
      return shortest(entry.plan.length, room, (n) => ({
        ...entry,
        plan: cutAt(entry.plan, n),
        cut: true,
      }));
    case 'tool':
    case 'permission': {
      const { detail } = entry;
      if (detail === undefined) return entry;
      return detail.kind === 'output'
        ? shortest(detail.text.length, room, (n) => ({
            ...entry,
            detail: { ...detail, text: cutAt(detail.text, n) },
            cut: true,
          }))
        : shortest(detail.lines.length, room, (n) => ({
            ...entry,
            detail: { ...detail, lines: detail.lines.slice(0, n) },
            cut: true,
          }));
    }
    default:
      return entry;
  }
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
