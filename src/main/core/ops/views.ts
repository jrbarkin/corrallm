import type { Reach } from '../../../shared/api/surface';
import type { Message } from '../../../shared/model/messages';
import { isOpen, turnReply } from '../../../shared/model/session';
import type { Entry } from '../../../shared/model/session';
import { messageView, runView, summaryReply } from '../../../shared/model/views';
import type {
  EntryView,
  MessageOrigin,
  MessageView,
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

/** Agent `agent`'s session as session.get gives it: not-found if there is no such agent. */
export function sessionSummary(open: OpenCanvas, agent: string) {
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
    ...summaryReply(lastTurn === undefined ? null : turnReply(session, lastTurn.id) || null),
  };
}

/**
 * An entry as a transcript gives it: a message's pasted images only counted; and an MCP server's
 * link (often a sign-in) left out for anyone but you (`yours`), as Needs leaves out its form: a
 * link form is yours alone (Core Server R3).
 */
export function transcriptEntry(entry: Entry, yours: boolean): EntryView {
  if (entry.kind !== 'user') {
    if (entry.kind !== 'elicitation' || yours || entry.url === undefined) return entry;
    const seen = { ...entry };
    delete seen.url;
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
  const summary = sessionSummary(open, agent);
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
 * Where a message came from, as the store keeps it today: a resend's copy, a run's attempt (it is
 * linked to a task), what you sent yourself, or another party's. (B11 C3's migration 4 keeps it as
 * the message is recorded instead.)
 */
export function originOf(store: MessageStore, message: Message): MessageOrigin {
  if (store.isResend(message)) return 'resend';
  if (message.task !== undefined) return 'run';
  if (message.from === 'you') return 'manual';
  return 'party';
}

/** A message as a canvas's messages topic gives it: with where it came from. */
export function messageViewOf(store: MessageStore, message: Message): MessageView {
  return messageView(message, originOf(store, message));
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
 * The run as `caller` sees it, as far as `reach` (`lead`: whether it is a lead now): yours whole,
 * with why its checkpoint couldn't be kept (`saveError`); a token's, the agents it reaches, and
 * the holds on them and on groups it reaches whole.
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
    return runView(run, undefined, saveError === undefined ? {} : { saveError });
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
