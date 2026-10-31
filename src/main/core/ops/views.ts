import type { Reach } from '../../../shared/api/surface';
import { fallbackView } from '../../../shared/model/fallback';
import type { FallbackView } from '../../../shared/model/fallback';
import type { Message } from '../../../shared/model/messages';
import { isOpen, turnReply } from '../../../shared/model/session';
import { mcpRequestTitle } from '../../../shared/model/words';
import type { Entry } from '../../../shared/model/session';
import { messageView, presentationOf, runView, summaryReply } from '../../../shared/model/views';
import type {
  EntryView,
  MessageView,
  RunNotice,
  RunView,
  SessionView,
} from '../../../shared/model/views';
import type { Caller } from '../caller';
import { partyIdOf } from '../caller';
import { cursorOf } from '../delivery/messages';
import type { MessageStore } from '../delivery/messages';
import type { OpenCanvas } from '../engines';
import { agentsReached, reachesGroup } from '../reach';
import { agentOf } from './open';

/*
 * What a caller sees of what a canvas the core runs holds beside its document (B11 §5): an agent's
 * session summary (session.get's), its transcript's entries (session.transcript's: an MCP server's
 * link yours alone, a message's images only counted), the messages (`messages`': yours all, a
 * token's those it sent or got) and the run (run.get's: the agents reached). One selector each,
 * read whole by its topic's projection and paged by its operation, so that a topic is never a
 * second way to see anything, and a page boundary never a missing row.
 */

/** How many prompts of its own an agent waits on an answer to: its session's, and its terminal's. */
export function promptsOf({ engine }: OpenCanvas, id: string): number {
  const session = engine.sessions.of(id);
  return session.entries.filter(isOpen).length + (session.asking?.length ?? 0);
}

/**
 * Agent `agent`'s session as session.get gives it, `yours` (you, and the core's own canonical
 * topic) or anyone else's (summaryFor): not-found if there is no such agent.
 */
/**
 * Where an agent is in the fallback chain you set, and whether corrallm switches it now (B11a
 * C11): the session summary's, agents' and status's, alike for every caller who reaches it.
 */
export function fallbackOf(open: OpenCanvas, agent: string): FallbackView | null {
  return fallbackView(agentOf(open, agent).data.fallback, open.switching?.(agent) === true);
}

export function sessionSummary(open: OpenCanvas, agent: string, yours = true) {
  const node = agentOf(open, agent);
  const { engine } = open;
  const session = engine.sessions.of(agent);
  const lastTurn = session.entries.findLast((entry) => entry.kind === 'user');
  return {
    agent,
    connection: engine.catalog.connectionOf(node.data),
    fallback: fallbackOf(open, agent),
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
    ...summaryReply(lastTurn === undefined ? null : turnReply(session, lastTurn.id) || null),
    ...(yours ? presentationOf(session) : {}),
  };
}

/**
 * An entry as a transcript gives it: a message's pasted images only counted; and an MCP server's
 * request, for anyone but you (`yours`), only in the core's words: never its link (often a
 * sign-in), its form or its message, which may hold the link, as Needs leaves them out: a form is
 * yours alone (Core Server R3, B13 C11).
 */
export function transcriptEntry(entry: Entry, yours: boolean): EntryView {
  if (entry.kind !== 'user') {
    if (entry.kind !== 'elicitation' || yours) return entry;
    const seen = { ...entry, message: mcpRequestTitle(entry.server, entry.url !== undefined) };
    delete seen.url;
    delete seen.fields;
    return seen;
  }
  const { images, ...rest } = entry;
  return images === undefined || images.length === 0 ? rest : { ...rest, images: images.length };
}

/**
 * An agent's transcript as `caller` sees it: each entry once, in its order (the first of any id
 * kept twice), as transcriptEntry gives it.
 */
export function transcriptOf(
  open: OpenCanvas,
  agent: string,
  caller: Caller,
): { entries: readonly Entry[]; shown: readonly EntryView[] } {
  agentOf(open, agent);
  const yours = caller.kind === 'human';
  const seen = new Set<string>();
  const entries = open.engine.sessions.of(agent).entries.filter((entry) => {
    if (seen.has(entry.id)) return false;
    seen.add(entry.id);
    return true;
  });
  return { entries, shown: entries.map((entry) => transcriptEntry(entry, yours)) };
}

/** Agent `agent`'s session topic's state as `caller` sees it: its summary and whole transcript. */
export function sessionViewOf(open: OpenCanvas, agent: string, caller: Caller): SessionView {
  const summary = sessionSummary(open, agent, caller.kind === 'human');
  const { shown } = transcriptOf(open, agent, caller);
  return {
    summary,
    entries: Object.fromEntries(shown.map((entry) => [entry.id, entry])),
    order: shown.map(({ id }) => id),
  };
}

/** Every message `caller` sees on an open canvas, in the store's order: you, all of them. */
export function messagesSeen(open: OpenCanvas, caller: Caller): Message[] {
  const party = partyIdOf(caller);
  return open.messages
    .all()
    .filter((message) => caller.kind === 'human' || message.from === party || message.to === party);
}

/**
 * A message as a canvas's messages topic gives it: with how it came to be and what a view shows of
 * it beside its body, as the store keeps them beside it (B11 §3, migration 4), never inferred from
 * its sender or its task link (a correction you typed with a Retry is linked to the run's task, yet
 * yours). A run's send keeps its `task`, the attempt, which a queue's row is projected from.
 */
export function messageViewOf(store: MessageStore, message: Message): MessageView {
  const origin = store.originOf(message.id);
  if (origin === undefined) throw new Error('That message isn’t kept (any more).');
  return messageView(message, origin, store.displayOf(message.id));
}

/**
 * The messages topic's state as `caller` sees it: each message it sees, by id, their order, and
 * the `messages` cursor after the last of them (as a read of every page of `messages` ends).
 */
export function messagesViewOf(
  open: OpenCanvas,
  caller: Caller,
): {
  items: Readonly<Record<string, MessageView>>;
  order: readonly string[];
  next: string;
} {
  const seen = messagesSeen(open, caller);
  const last = seen.at(-1);
  return {
    items: Object.fromEntries(
      seen.map((message) => [message.id, messageViewOf(open.messages, message)]),
    ),
    order: seen.map(({ id }) => id),
    next: cursorOf('messages', {
      [open.document.id]: last === undefined ? 0 : (open.messages.seqOf(last.id) ?? 0),
    }),
  };
}

/**
 * What opening a canvas found to say (its run discarded, its file gone, the database restored), as
 * its run's notices: yours alone, as a window shows them (B11 X12), never a token's (a database's
 * notice names the profile's paths).
 */
export function openedNotices(open: Pick<OpenCanvas, 'warnings'>): RunNotice[] {
  return open.warnings.map((text, index) => ({
    id: `opened/${String(index)}`,
    level: 'warning',
    text,
  }));
}

/**
 * The run as `caller` sees it, as far as `reach` (`lead`: whether it is a lead now): yours whole,
 * with why its checkpoint couldn't be kept (`saveError`) and what opening it found to say; a
 * token's, the agents it reaches, and the holds on them and on groups it reaches whole.
 */
export function runSeen(
  open: OpenCanvas,
  caller: Caller,
  reach: Reach | 'all',
  lead: boolean,
  saveError?: string,
): RunView {
  const run = open.engine.run.snapshot();
  if (caller.kind === 'human')
    return runView(run, undefined, {
      notices: openedNotices(open),
      ...(saveError === undefined ? {} : { saveError }),
    });
  const agents = new Set(agentsReached(open.document, caller, reach, lead));
  return runView({
    running: run.running,
    ...(run.paused === undefined ? {} : { paused: run.paused }),
    ...(run.individualPauses === undefined
      ? {}
      : { individualPauses: run.individualPauses.filter(({ id }) => agents.has(id)) }),
    ...(run.groupPauses === undefined
      ? {}
      : {
          groupPauses: run.groupPauses.filter(({ id }) =>
            reachesGroup(open.document, caller, reach, id, lead),
          ),
        }),
    agents: Object.fromEntries(Object.entries(run.agents).filter(([id]) => agents.has(id))),
  });
}
