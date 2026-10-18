import type { ResultOf } from '../../../shared/api/registry';
import { turnReply } from '../../../shared/model/session';
import type { Entry } from '../../../shared/model/session';
import { OpFailure } from '../call';
import { agentOf, openCanvas } from './open';
import { promptsOf } from './conversation';
import type { Implementations, OpServices } from '.';

/** How many entries a page of a transcript holds when a call doesn't say. */
const PAGE = 50;

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
    'session.transcript': ({ canvas, agent, after, limit = PAGE }) => {
      const open = openCanvas(engines, canvas);
      agentOf(open, agent);
      const { entries } = open.engine.sessions.of(agent);
      const start = after === undefined ? 0 : entries.findIndex((entry) => entry.id === after) + 1;
      if (start === 0 && after !== undefined) {
        throw new OpFailure('not-found', 'That entry isn’t in its transcript (any more).');
      }
      const page = entries.slice(start, start + limit).map(shown);
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
