import { z } from 'zod';

import { AgentId, CanvasId as CanvasIdSchema } from '../../shared/api/ids';
import { RunViewSchema, SessionSummarySchema } from '../../shared/api/ops/b11-data';
import { Cursor, Message } from '../../shared/api/ops/conversation';
import { TranscriptEntry } from '../../shared/api/ops/session';
import { MAX_TOPIC_FRAME } from '../../shared/api/limits';
import { R, SURFACE } from '../../shared/api/surface';
import type { OpName, Party, Reach, Surface } from '../../shared/api/surface';
import type {
  RunTopChange,
  RuntimeTopicKey,
  RuntimeTopicRequest,
  RuntimeTopicStates,
} from '../../shared/api/topics';
import { isRuntimeTopic, topicRequest } from '../../shared/api/topics';
import type { CanvasId } from '../../shared/canvas';
import type { SessionAction } from '../../shared/engine/transcript/reduce';
import type { PartyId } from '../../shared/model/messages';
import type { Entry, Session } from '../../shared/model/session';
import { MESSAGE_ORIGINS, projectData, runView } from '../../shared/model/views';
import type {
  EntryView,
  MessageView,
  RunView,
  SessionSummary,
  SessionView,
} from '../../shared/model/views';
import type { Projection, ProjectionContext } from './call';
import type { Caller } from './caller';
import { cursorOf } from './delivery/messages';
import type { Engines, OpenCanvas } from './engines';
import { openCanvas } from './ops/open';
import {
  messagesViewOf,
  messageViewOf,
  runSeen,
  sessionSummary,
  sessionViewOf,
  transcriptEntry,
} from './ops/views';
import { agentsReached } from './reach';

/*
 * The runtime topics' source (B11 §5, §16): what a canvas the core runs holds beside its document,
 * as the common publisher (topics.ts) publishes it. Four topics per canvas: its run (`run:<c>`),
 * its agents' session summaries (`sessions:<c>`), each agent's session, its summary and transcript
 * (`session:<c>:<agent>`), and its messages (`messages:<c>`). Each has one canonical state, what
 * you see, kept here as last published (its baseline), whether or not anyone subscribes: the
 * publisher gives each change of it a revision as it takes it. Changes are taken from what changed:
 * the run's and sessions' stores, a session's actions as they are reduced (a text or thinking
 * append is said as an append, never by comparing transcripts; any other action by comparing
 * entries by identity, which the reducer keeps for those it leaves), the message store's changed
 * messages, and the canvas's document. A summary is said again on any change but an append (its
 * `reply` then waits for the next, at the latest the turn's end). Whoever sees less than you (a
 * token's copy, which only T3c's followers keep: tokens get no topics, D5) reads its own copy again
 * through the topic's projection, below, as each change is published.
 *
 * Each topic is read through a projection (call.ts' `project`), under the surface of the op that
 * `reads` it: session.get's for `sessions:<c>`, session.transcript's for a session, `messages`' for
 * the messages, and run.get's for the run (RUN_GET until B11 X9 registers run.get). Its selectors
 * are the ops' own (ops/views.ts), which the ops page and the projections read whole, so that a
 * topic is never a second way to see anything.
 *
 * In the app the core runs no canvas yet (the window does, until B11's cutover), so these topics
 * have nothing to say there; under `corrallm serve`, and wherever the core opens a canvas, they do.
 */

export type RuntimeKind = RuntimeTopicRequest['topic'];
export type RuntimeState = RuntimeTopicStates[RuntimeTopicKey];

/**
 * What a runtime change says, besides its head (topic, epoch, revision, sequence, actor, time): the
 * wire's RuntimeChange (shared/api/topics.ts), its ids as plain strings here.
 */
interface Keyed<T> {
  readonly set: Readonly<Record<string, T>>;
  readonly remove?: readonly string[];
}
export interface RunBody {
  readonly top?: RunTopChange;
  readonly agents?: Keyed<RunView['agents'][AgentId]>;
}
export interface SessionsBody {
  readonly agents: Keyed<SessionSummary>;
}
export interface SessionBody {
  readonly summary?: SessionSummary;
  readonly entries: {
    readonly upsert?: readonly EntryView[];
    readonly append?: readonly { readonly id: string; readonly text: string }[];
    readonly order?: readonly string[];
  };
}
export interface MessagesBody {
  readonly set: Readonly<Record<string, MessageView>>;
  readonly remove?: readonly string[];
  readonly order?: readonly string[];
  readonly next?: string;
}
export type RuntimeBody = RunBody | SessionsBody | SessionBody | MessagesBody;

/**
 * run.get's surface as B11 §6 freezes it (R, read, none, reads run, varies), which the run's
 * projection reads under until B11 X9 registers run.get; then SURFACE's reader of 'run' is used.
 */
export const RUN_GET = {
  access: R,
  kind: 'read',
  scope: 'none',
  reads: 'run',
  varies: ['agents', 'individualPauses', 'groupPauses', 'saveError'],
} as const satisfies Surface;

/** The op each runtime topic is read under: SURFACE's reader of it, or run.get's until X9. */
export function readerOf(kind: RuntimeKind): { name: string; surface: Surface } {
  const found = (Object.entries(SURFACE) as [OpName, Surface][]).find(
    ([, surface]) => surface.reads === kind,
  );
  if (found) return { name: found[0], surface: found[1] };
  if (kind === 'run') return { name: 'run.get', surface: RUN_GET };
  throw new Error(`No op reads the ${kind} topic.`);
}

/** How far `party` reaches for an op of `surface`: you, everywhere. */
function reachOf(surface: Surface, party: Party): Reach | 'all' {
  const access = surface.access as Readonly<Partial<Record<Party, Reach>>>;
  return party === 'you' ? 'all' : (access[party] ?? 'own');
}

const CanvasArgs = z.strictObject({ canvas: CanvasIdSchema });
const SessionArgs = z.strictObject({ canvas: CanvasIdSchema, agent: AgentId });

/** Each runtime topic's state, as its projection reads it (the wire's, shared/api/topics.ts). */
export const RUNTIME_STATES = {
  run: RunViewSchema,
  sessions: z.strictObject({ agents: z.record(z.string(), SessionSummarySchema) }),
  session: z.strictObject({
    summary: SessionSummarySchema,
    entries: z.record(z.string(), TranscriptEntry),
    order: z.array(z.string()),
  }),
  messages: z.strictObject({
    items: z.record(
      z.string(),
      Message.extend({
        origin: z.enum(MESSAGE_ORIGINS),
        display: z
          .strictObject({
            after: z.string().optional(),
            text: z.string().optional(),
            images: z.int().min(0).optional(),
            requiresImages: z.literal(true).optional(),
          })
          .optional(),
      }),
    ),
    order: z.array(z.string()),
    next: Cursor,
  }),
} satisfies Readonly<Record<RuntimeKind, z.ZodType>>;

/** The kind of a runtime topic, from its key. */
export function kindOf(topic: RuntimeTopicKey): RuntimeKind {
  return topic.slice(0, topic.indexOf(':')) as RuntimeKind;
}

/** A runtime topic's request, as its projection takes it (its key decoded once). */
export function argsOf(topic: RuntimeTopicKey): { canvas: CanvasId; agent?: string } {
  const request = topicRequest(topic);
  return {
    canvas: request.canvas as string as CanvasId,
    ...('agent' in request ? { agent: request.agent } : {}),
  };
}

export interface RuntimeSourceDeps {
  engines: Pick<Engines, 'canvas' | 'opened' | 'watch'>;
  /** Which agents are leads now. */
  isLead: (canvas: CanvasId, agent: string) => boolean;
  /** Why a canvas's run checkpoint couldn't be kept, if it couldn't: its run's `saveError`. */
  problem: (canvas: CanvasId) => string | undefined;
}

/**
 * A session's baseline: as last published, its entries once each in order, and each by id with
 * where it is in the session's own entries.
 */
interface SessionBase {
  session: Session;
  entries: readonly Entry[];
  order: readonly string[];
  byId: Map<string, { entry: Entry; at: number; raw: number }>;
  summary: SessionSummary | undefined;
}

/** What a canvas's session store did since it was last taken from, for one agent. */
type EntryWork = { appends: { id: string; text: string }[] } | 'diff';

interface CanvasSource {
  readonly canvas: CanvasId;
  /** Its engine's stores, heard while the core runs it. */
  attached?: { open: OpenCanvas; stop: () => void };
  /** Each topic's canonical state as last published: kept while it closes, to say what changed. */
  run?: RunView;
  sessions?: Map<string, SessionSummary>;
  readonly session: Map<string, SessionBase>;
  messages?: {
    items: Map<string, MessageView>;
    seqs: Map<string, number>;
    order: string[];
    next: string;
  };
  /** What changed since it was last taken. */
  dirty: {
    run: boolean;
    summaries: Set<string> | 'all';
    entries: Map<string, EntryWork>;
    messages: Set<string>;
    /** Anything changed, its document included (who reaches what): what a token reads again. */
    touched: boolean;
  };
  /** The session action reduced last, until the store says it changed. */
  action?: { agent: string; action: SessionAction };
  /** Each agent's session as the store last said, for a change no action says. */
  seen: Map<string, Session>;
}

function fresh(): CanvasSource['dirty'] {
  return {
    run: false,
    summaries: new Set(),
    entries: new Map(),
    messages: new Set(),
    touched: false,
  };
}

/** The source of every canvas's runtime topics, over the canvases the core runs. */
export class RuntimeSource {
  readonly #deps: RuntimeSourceDeps;
  readonly #canvases = new Map<CanvasId, CanvasSource>();
  readonly #listeners = new Set<(canvas: CanvasId) => void>();
  #stop: (() => void) | undefined;
  /** Each runtime topic's projection, by kind: what a caller may see of it, through core.call. */
  readonly projections: Readonly<Record<RuntimeKind, Projection>>;

  constructor(deps: RuntimeSourceDeps) {
    this.#deps = deps;
    const lead = (canvas: string, { caller }: ProjectionContext) =>
      caller.kind === 'agent' && deps.isLead(canvas as CanvasId, caller.agent);
    const projection = <A>(
      kind: RuntimeKind,
      input: z.ZodType<A>,
      read: (args: A, ctx: ProjectionContext, surface: Surface) => unknown,
    ): Projection => {
      const { name, surface } = readerOf(kind);
      return {
        name,
        surface,
        input,
        output: RUNTIME_STATES[kind],
        read: (args: never, ctx) => read(args, ctx, surface),
      };
    };
    this.projections = {
      run: projection('run', CanvasArgs, ({ canvas }, ctx, surface) =>
        runSeen(
          openCanvas(deps.engines, canvas),
          ctx.caller,
          reachOf(surface, ctx.party),
          lead(canvas, ctx),
          ctx.caller.kind === 'human' ? deps.problem(canvas as string as CanvasId) : undefined,
        ),
      ),
      sessions: projection('sessions', CanvasArgs, ({ canvas }, ctx, surface) => {
        const open = openCanvas(deps.engines, canvas);
        const agents = agentsReached(
          open.document,
          ctx.caller,
          reachOf(surface, ctx.party),
          lead(canvas, ctx),
        );
        return {
          agents: Object.fromEntries(agents.map((agent) => [agent, sessionSummary(open, agent)])),
        };
      }),
      session: projection('session', SessionArgs, ({ canvas, agent }, ctx) =>
        sessionViewOf(openCanvas(deps.engines, canvas), agent, ctx.caller),
      ),
      messages: projection('messages', CanvasArgs, ({ canvas }, ctx) =>
        messagesViewOf(openCanvas(deps.engines, canvas), ctx.caller),
      ),
    };
  }

  /** Hears the canvases the core runs, from now on: those open already, then each as it opens. */
  start(): void {
    this.#stop ??= this.#deps.engines.watch({
      opened: (canvas) => {
        this.#attach(canvas);
      },
      closed: (canvas) => {
        this.#detach(canvas);
      },
    });
    for (const canvas of this.#deps.engines.opened()) this.#attach(canvas);
  }

  /** Hears which canvas has a change to take. */
  listen(listener: (canvas: CanvasId) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  close(): void {
    this.#stop?.();
    this.#stop = undefined;
    for (const canvas of [...this.#canvases.keys()]) this.#detach(canvas);
    this.#listeners.clear();
  }

  /** The canvas's document changed: its agents, how each runs, and who reaches what. */
  documentChanged(canvas: CanvasId): void {
    const source = this.#canvases.get(canvas);
    if (!source?.attached) return;
    source.dirty.summaries = 'all';
    this.#changed(source);
  }

  /** Whether its run's checkpoint could be kept changed: the run's `saveError`. */
  problemChanged(canvas: CanvasId): void {
    const source = this.#canvases.get(canvas);
    if (!source?.attached) return;
    source.dirty.run = true;
    this.#changed(source);
  }

  /** The canvas's topics with a change to take, in the order to take them. */
  pending(canvas: CanvasId): RuntimeTopicKey[] {
    const source = this.#canvases.get(canvas);
    if (!source?.attached) return [];
    const { dirty } = source;
    const agents = this.#agents(source);
    const summaries = dirty.summaries === 'all' ? agents : [...dirty.summaries];
    const sessions = new Set([...summaries, ...dirty.entries.keys()]);
    return [
      ...(dirty.run ? [`run:${canvas}` as const] : []),
      ...(summaries.length > 0 || dirty.summaries === 'all' ? [`sessions:${canvas}` as const] : []),
      ...[...sessions].map(
        (agent) => `session:${canvas}:${encodeURIComponent(agent)}` as RuntimeTopicKey,
      ),
      ...(dirty.messages.size > 0 ? [`messages:${canvas}` as const] : []),
    ];
  }

  /** Whether anything of the canvas changed since `taken`: what a token's copy is read again on. */
  touched(canvas: CanvasId): boolean {
    return this.#canvases.get(canvas)?.dirty.touched === true;
  }

  /** Marks what was taken of the canvas: until it changes again, nothing of it is. */
  taken(canvas: CanvasId): void {
    const source = this.#canvases.get(canvas);
    if (source) source.dirty = fresh();
  }

  /** Whether a topic has a change waiting to be taken. */
  isPending(topic: string): boolean {
    if (!isRuntimeTopic(topic)) return false;
    const { canvas } = argsOf(topic);
    const source = this.#canvases.get(canvas);
    if (!source?.attached) return false;
    const { dirty } = source;
    switch (kindOf(topic)) {
      case 'run':
        return dirty.run;
      case 'messages':
        return dirty.messages.size > 0;
      default:
        return dirty.summaries === 'all' || dirty.summaries.size > 0 || dirty.entries.size > 0;
    }
  }

  /**
   * The topic's canonical change since it was last taken, which its baseline then is, and who made
   * it by default (the CLI for its sessions', corrallm otherwise); none if nothing changed.
   */
  take(topic: RuntimeTopicKey): { body: RuntimeBody; by: PartyId | 'cli' } | undefined {
    const { canvas, agent } = argsOf(topic);
    const source = this.#canvases.get(canvas);
    const open = source?.attached?.open;
    if (!source || !open) return undefined;
    switch (kindOf(topic)) {
      case 'run': {
        const body = this.#takeRun(source, open);
        return body && { body, by: 'corrallm' };
      }
      case 'sessions': {
        const body = this.#takeSessions(source, open);
        return body && { body, by: 'cli' };
      }
      case 'session': {
        const body = agent === undefined ? undefined : this.#takeSession(source, open, agent);
        return body && { body, by: 'cli' };
      }
      case 'messages': {
        const body = this.#takeMessages(source, open);
        return body && { body, by: 'corrallm' };
      }
    }
  }

  /**
   * The topic's canonical state as last taken (what you see, at its revision now). Throws if the
   * core never ran its canvas, or it has no such agent.
   */
  state(topic: RuntimeTopicKey): RuntimeState {
    const { canvas, agent } = argsOf(topic);
    const source = this.#canvases.get(canvas);
    const unavailable = () => new Error('That canvas isn’t open in corrallm.');
    if (!source) throw unavailable();
    switch (kindOf(topic)) {
      case 'run':
        if (!source.run) throw unavailable();
        return source.run;
      case 'sessions':
        if (!source.sessions) throw unavailable();
        return { agents: Object.fromEntries(source.sessions) };
      case 'session': {
        const base = agent === undefined ? undefined : source.session.get(agent);
        if (!base?.summary) throw new Error(`There is no agent ${agent ?? ''}.`);
        return {
          summary: base.summary,
          entries: Object.fromEntries(
            base.entries.map((entry) => [entry.id, transcriptEntry(entry, true)]),
          ),
          order: base.order,
        };
      }
      case 'messages': {
        const messages = source.messages;
        if (!messages) throw unavailable();
        const state = {
          items: Object.fromEntries(messages.order.map((id) => [id, messages.items.get(id)])),
          order: messages.order,
          next: messages.next,
        };
        return state as unknown as RuntimeTopicStates[`messages:${CanvasId}`];
      }
    }
  }

  #agents(source: CanvasSource): string[] {
    const open = source.attached?.open;
    if (!open) return [];
    return open.document.nodes.flatMap((node) => (node.type === 'agent' ? [node.id] : []));
  }

  #changed(source: CanvasSource): void {
    source.dirty.touched = true;
    for (const listener of this.#listeners) listener(source.canvas);
  }

  /** The core runs the canvas now: its stores are heard, from its baselines (or new ones). */
  #attach(canvas: CanvasId): void {
    const open = this.#deps.engines.canvas(canvas);
    if (!open) return;
    let source = this.#canvases.get(canvas);
    const again = source !== undefined;
    source ??= { canvas, session: new Map(), dirty: fresh(), seen: new Map() };
    this.#canvases.set(canvas, source);
    source.attached?.stop();
    const it = source;
    const { engine, messages } = open;
    const stops = [
      engine.run.subscribe(() => {
        it.dirty.run = true;
        // An agent's summary says whether the run holds it.
        it.dirty.summaries = 'all';
        this.#changed(it);
      }),
      engine.sessions.observe((agent, action) => {
        it.action = { agent, action };
      }),
      engine.sessions.subscribe(() => {
        this.#sessionsChanged(it);
      }),
      messages.watch((id) => {
        it.dirty.messages.add(id);
        this.#changed(it);
      }),
    ];
    source.attached = {
      open,
      stop: () => {
        for (const stop of stops) stop();
      },
    };
    source.seen = new Map(Object.entries(engine.sessions.snapshot()));
    if (again) {
      // Reopened: what changed while it was closed is said from what was last published.
      source.dirty = { ...fresh(), run: true, summaries: 'all', touched: true };
      for (const agent of this.#agents(source)) source.dirty.entries.set(agent, 'diff');
      for (const message of messages.all()) source.dirty.messages.add(message.id);
      for (const id of source.messages?.order ?? []) source.dirty.messages.add(id);
      this.#changed(source);
      return;
    }
    // Its baselines, at revision 0: nothing of what it held as it opened is a change.
    source.run = this.#runView(open, undefined);
    source.sessions = new Map(
      this.#agents(source).map((agent) => [agent, sessionSummary(open, agent)]),
    );
    for (const agent of this.#agents(source))
      source.session.set(agent, {
        ...this.#entriesBase(engine.sessions.of(agent)),
        summary: source.sessions.get(agent),
      });
    source.messages = this.#messagesBase(open);
    source.dirty = fresh();
  }

  #detach(canvas: CanvasId): void {
    const source = this.#canvases.get(canvas);
    source?.attached?.stop();
    if (source) {
      delete source.attached;
      delete source.action;
      source.dirty = fresh();
    }
  }

  /** The session store changed: an action's change, or another (an agent forgotten). */
  #sessionsChanged(source: CanvasSource): void {
    const open = source.attached?.open;
    if (!open) return;
    const sessions = open.engine.sessions;
    const { action } = source;
    delete source.action;
    const mark = (agent: string, work: 'diff' | { id: string; text: string }) => {
      const had = source.dirty.entries.get(agent);
      if (work === 'diff' || had === 'diff') source.dirty.entries.set(agent, 'diff');
      else if (had) had.appends.push(work);
      else source.dirty.entries.set(agent, { appends: [work] });
      if (work === 'diff' && source.dirty.summaries !== 'all') source.dirty.summaries.add(agent);
    };
    if (action) {
      // A text or thinking append changes that entry alone, and no summary but its reply's.
      const { agent, action: done } = action;
      mark(agent, done.type === 'stream' ? { id: done.id, text: done.text } : 'diff');
      source.seen.set(agent, sessions.of(agent));
    } else {
      for (const [agent, session] of Object.entries(sessions.snapshot()))
        if (source.seen.get(agent) !== session) mark(agent, 'diff');
      for (const agent of source.seen.keys())
        if (!Object.hasOwn(sessions.snapshot(), agent)) mark(agent, 'diff');
      source.seen = new Map(Object.entries(sessions.snapshot()));
    }
    this.#changed(source);
  }

  #runView(open: OpenCanvas, previous: RunView | undefined): RunView {
    const saveError = this.#deps.problem(open.document.id);
    return runView(
      open.engine.run.snapshot(),
      previous,
      saveError === undefined ? {} : { saveError },
    );
  }

  #takeRun(source: CanvasSource, open: OpenCanvas): RunBody | undefined {
    const previous = source.run;
    const next = this.#runView(open, previous);
    source.run = next;
    return previous === undefined ? undefined : runDiff(previous, next);
  }

  #takeSessions(source: CanvasSource, open: OpenCanvas): SessionsBody | undefined {
    const previous = source.sessions ?? new Map<string, SessionSummary>();
    const agents = this.#agents(source);
    const { summaries } = source.dirty;
    const next = new Map<string, SessionSummary>();
    const set: [string, SessionSummary][] = [];
    for (const agent of agents) {
      const was = previous.get(agent);
      const now =
        was !== undefined && summaries !== 'all' && !summaries.has(agent)
          ? was
          : projectData(sessionSummary(open, agent), was);
      next.set(agent, now);
      if (now !== was) set.push([agent, now]);
    }
    const remove = [...previous.keys()].filter((agent) => !next.has(agent));
    source.sessions = next;
    if (set.length === 0 && remove.length === 0) return undefined;
    return {
      agents: { set: Object.fromEntries(set), ...(remove.length === 0 ? {} : { remove }) },
    };
  }

  #takeSession(source: CanvasSource, open: OpenCanvas, agent: string): SessionBody | undefined {
    if (!open.document.nodes.some((node) => node.type === 'agent' && node.id === agent))
      return undefined;
    const session = open.engine.sessions.of(agent);
    const summary = source.sessions?.get(agent);
    let base = source.session.get(agent);
    if (!base) {
      // A new agent: its session as it is now, at its topic's first revision.
      source.session.set(agent, { ...this.#entriesBase(session), summary });
      return undefined;
    }
    const work = source.dirty.entries.get(agent);
    const entries =
      work === undefined
        ? undefined
        : ((work === 'diff' ? undefined : appended(base, session, work.appends)) ??
          entriesDiff(base, session));
    // Its summary is the canvas's sessions' for it, as they were just taken.
    const summaryChanged = summary !== undefined && summary !== base.summary;
    base = entries?.base ?? base;
    base.summary = summary;
    source.session.set(agent, base);
    if (!entries?.change && !summaryChanged) return undefined;
    return {
      ...(summaryChanged ? { summary } : {}),
      entries: entries?.change ?? {},
    };
  }

  #entriesBase(session: Session): Omit<SessionBase, 'summary'> {
    const { entries, byId } = once(session);
    return { session, entries, order: entries.map(({ id }) => id), byId };
  }

  #messagesBase(open: OpenCanvas): NonNullable<CanvasSource['messages']> {
    const items = new Map<string, MessageView>();
    const seqs = new Map<string, number>();
    const order: string[] = [];
    for (const message of open.messages.all()) {
      items.set(message.id, messageViewOf(open.messages, message));
      seqs.set(message.id, open.messages.seqOf(message.id) ?? 0);
      order.push(message.id);
    }
    return { items, seqs, order, next: nextOf(open.document.id, order, seqs) };
  }

  #takeMessages(source: CanvasSource, open: OpenCanvas): MessagesBody | undefined {
    const base = source.messages ?? this.#messagesBase(open);
    const set: [string, MessageView][] = [];
    const remove: string[] = [];
    const added: string[] = [];
    for (const id of source.dirty.messages) {
      const message = open.messages.get(id);
      const was = base.items.get(id);
      if (message === undefined) {
        if (was === undefined) continue;
        base.items.delete(id);
        base.seqs.delete(id);
        remove.push(id);
        continue;
      }
      const now = projectData(messageViewOf(open.messages, message), was);
      if (now === was) continue;
      if (was === undefined) {
        added.push(id);
        base.seqs.set(id, open.messages.seqOf(id) ?? 0);
      }
      base.items.set(id, now);
      set.push([id, now]);
    }
    source.messages = base;
    if (set.length === 0 && remove.length === 0) return undefined;
    const seqOf = (id: string) => base.seqs.get(id) ?? 0;
    set.sort(([a], [b]) => seqOf(a) - seqOf(b));
    added.sort((a, b) => seqOf(a) - seqOf(b));
    // New messages go last, in their order, unless one was placed before one already said.
    const removed = new Set(remove);
    const kept = base.order.filter((id) => !removed.has(id));
    const last = kept.at(-1);
    const after = last === undefined || added.every((id) => seqOf(id) > seqOf(last));
    const order = after
      ? [...kept, ...added]
      : [...kept, ...added].sort((a, b) => seqOf(a) - seqOf(b));
    base.order = order;
    const next = nextOf(open.document.id, order, base.seqs);
    const moved = next !== base.next;
    base.next = next;
    return {
      set: Object.fromEntries(set),
      ...(remove.length === 0 ? {} : { remove }),
      ...(after ? {} : { order }),
      ...(moved ? { next } : {}),
    };
  }
}

/** The `messages` cursor after the last of `order`, as a read of every page ends. */
function nextOf(canvas: CanvasId, order: readonly string[], seqs: Map<string, number>): string {
  const last = order.at(-1);
  return cursorOf('messages', { [canvas]: last === undefined ? 0 : (seqs.get(last) ?? 0) });
}

/** A session's entries, each id once (its first), and each by id with where it is. */
function once(session: Session): {
  entries: Entry[];
  byId: Map<string, { entry: Entry; at: number; raw: number }>;
} {
  const byId = new Map<string, { entry: Entry; at: number; raw: number }>();
  const entries: Entry[] = [];
  session.entries.forEach((entry, raw) => {
    if (byId.has(entry.id)) return;
    byId.set(entry.id, { entry, at: entries.length, raw });
    entries.push(entry);
  });
  return { entries, byId };
}

/**
 * The session's entries after only text and thinking appends since `base`, said as appends,
 * without reading the rest of them: none if anything but such appends could have changed them
 * (then they are compared).
 */
function appended(
  base: SessionBase,
  session: Session,
  appends: readonly { id: string; text: string }[],
): { change: SessionBody['entries'] | undefined; base: SessionBase } | undefined {
  if (session.entries.length !== base.session.entries.length) return undefined;
  const texts = new Map<string, string>();
  for (const { id, text } of appends) {
    const at = base.byId.get(id);
    if (!at || (at.entry.kind !== 'text' && at.entry.kind !== 'thinking')) return undefined;
    texts.set(id, (texts.get(id) ?? '') + text);
  }
  const found: { id: string; now: Entry; at: { entry: Entry; at: number; raw: number } }[] = [];
  for (const [id, text] of texts) {
    const at = base.byId.get(id);
    const now = at && session.entries[at.raw];
    if (
      !at ||
      now?.id !== id ||
      now.kind !== at.entry.kind ||
      (now.kind !== 'text' && now.kind !== 'thinking') ||
      now.text.length !== (at.entry as { text: string }).text.length + text.length
    )
      return undefined;
    found.push({ id, now, at });
  }
  // The baseline is the source's own: what changed of it is replaced in place.
  const entries = base.entries as Entry[];
  for (const { id, now, at } of found) {
    entries[at.at] = now;
    base.byId.set(id, { entry: now, at: at.at, raw: at.raw });
  }
  const append = [...texts].flatMap(([id, text]) => (text === '' ? [] : [{ id, text }]));
  return {
    change: append.length === 0 ? undefined : { append },
    base: { ...base, session, entries },
  };
}

/**
 * What changed of a session's entries since `base`, comparing them by identity (the reducer keeps
 * every entry it leaves): those new or replaced, as upserts in their order, and the whole order
 * where anything but appending changed it.
 */
function entriesDiff(
  base: SessionBase,
  session: Session,
): { change: SessionBody['entries'] | undefined; base: SessionBase } {
  const { entries, byId } = once(session);
  const upsert = entries.flatMap((entry) =>
    base.byId.get(entry.id)?.entry === entry ? [] : [transcriptEntry(entry, true)],
  );
  const order = entries.map(({ id }) => id);
  const appendsOnly =
    order.length >= base.order.length && base.order.every((id, i) => order[i] === id);
  const next: SessionBase = { session, entries, order, byId, summary: base.summary };
  if (upsert.length === 0 && appendsOnly) return { change: undefined, base: next };
  return {
    change: { ...(upsert.length === 0 ? {} : { upsert }), ...(appendsOnly ? {} : { order }) },
    base: next,
  };
}

/** What changed of the run from `previous` to `next` (sharing what didn't): none if nothing. */
export function runDiff(previous: RunView, next: RunView): RunBody | undefined {
  const top: Record<string, unknown> = {};
  for (const key of [
    'running',
    'paused',
    'individualPauses',
    'groupPauses',
    'notices',
    'saveError',
  ] as const) {
    const was: unknown = previous[key];
    const now: unknown = next[key];
    if (was === now) continue;
    top[key] = now === undefined ? null : now;
  }
  const agents = keyedDiff(previous.agents, next.agents);
  if (Object.keys(top).length === 0 && !agents) return undefined;
  return {
    ...(Object.keys(top).length === 0 ? {} : { top }),
    ...(agents === undefined ? {} : { agents }),
  };
}

/** What changed of a keyed record (sharing what didn't): its set and removed keys, or none. */
function keyedDiff<T>(
  previous: Readonly<Record<string, T>>,
  next: Readonly<Record<string, T>>,
): { set: Readonly<Record<string, T>>; remove?: string[] } | undefined {
  const set = Object.entries(next).filter(
    ([key, value]) => !Object.hasOwn(previous, key) || previous[key] !== value,
  );
  const remove = Object.keys(previous).filter((key) => !Object.hasOwn(next, key));
  if (set.length === 0 && remove.length === 0) return undefined;
  return { set: Object.fromEntries(set), ...(remove.length === 0 ? {} : { remove }) };
}

/**
 * What changed of a copy that sees less than yours (a token's), from `previous` to `next`, its
 * projection read again (`next` sharing what didn't change of `previous`): none if nothing.
 */
export function viewDiff(
  topic: RuntimeTopicKey,
  previous: RuntimeState,
  next: RuntimeState,
): RuntimeBody | undefined {
  switch (kindOf(topic)) {
    case 'run':
      return runDiff(previous as RunView, next as RunView);
    case 'sessions': {
      const agents = keyedDiff(
        (previous as RuntimeTopicStates[`sessions:${CanvasId}`]).agents,
        (next as RuntimeTopicStates[`sessions:${CanvasId}`]).agents,
      );
      return agents && { agents };
    }
    case 'session': {
      const was = previous as SessionView;
      const now = next as SessionView;
      const upsert = now.order.flatMap((id) => {
        const entry = now.entries[id];
        return entry !== undefined && (!Object.hasOwn(was.entries, id) || was.entries[id] !== entry)
          ? [entry]
          : [];
      });
      const appendsOnly =
        now.order.length >= was.order.length && was.order.every((id, i) => now.order[i] === id);
      const summary = was.summary !== now.summary;
      if (upsert.length === 0 && appendsOnly && !summary) return undefined;
      return {
        ...(summary ? { summary: now.summary } : {}),
        entries: {
          ...(upsert.length === 0 ? {} : { upsert }),
          ...(appendsOnly ? {} : { order: now.order }),
        },
      };
    }
    case 'messages': {
      const was = previous as RuntimeTopicStates[`messages:${CanvasId}`];
      const now = next as RuntimeTopicStates[`messages:${CanvasId}`];
      const items = keyedDiff(was.items, now.items);
      const removed = new Set(items?.remove);
      const kept = was.order.filter((id) => !removed.has(id));
      const added = now.order.filter((id) => !Object.hasOwn(was.items, id));
      const derived = [...kept, ...added];
      const ordered =
        derived.length === now.order.length && derived.every((id, i) => now.order[i] === id);
      const moved = was.next !== now.next;
      if (!items && ordered && !moved) return undefined;
      // New items go last in the order they are set.
      const set = Object.fromEntries(
        now.order.flatMap((id) =>
          items && Object.hasOwn(items.set, id) ? [[id, items.set[id]]] : [],
        ),
      ) as MessagesBody['set'];
      return {
        set,
        ...(items?.remove === undefined ? {} : { remove: items.remove }),
        ...(ordered ? {} : { order: now.order }),
        ...(moved ? { next: now.next } : {}),
      };
    }
  }
}

/** A change that says nothing: what a copy is sent at a revision that changed nothing of it. */
export function emptyBody(topic: RuntimeTopicKey): RuntimeBody {
  switch (kindOf(topic)) {
    case 'run':
      return {};
    case 'sessions':
      return { agents: { set: {} } };
    case 'session':
      return { entries: {} };
    case 'messages':
      return { set: {} };
  }
}

/** How many bytes a value takes as JSON (UTF-8). */
export function bytesOf(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

/**
 * The most bytes a topic's frame or change takes as the core sends it, leaving room for the port's
 * envelope around it within MAX_TOPIC_FRAME (B11 §16.3).
 */
export const TOPIC_BUDGET = MAX_TOPIC_FRAME - 4096;

/** A state's bounded summary and its keyed entries in order, as a chunked snapshot sends them. */
export function partsOf(
  topic: RuntimeTopicKey,
  state: RuntimeState,
): { summary: unknown; entries: { key: string; value: unknown }[] } {
  switch (kindOf(topic)) {
    case 'run': {
      const { agents, ...summary } = state as RunView;
      return { summary, entries: Object.entries(agents).map(([key, value]) => ({ key, value })) };
    }
    case 'sessions':
      return {
        summary: {},
        entries: Object.entries((state as RuntimeTopicStates[`sessions:${CanvasId}`]).agents).map(
          ([key, value]) => ({ key, value }),
        ),
      };
    case 'session': {
      const { summary, entries, order } = state as SessionView;
      return { summary, entries: order.map((key) => ({ key, value: entries[key] })) };
    }
    case 'messages': {
      const { items, order, next } = state as RuntimeTopicStates[`messages:${CanvasId}`];
      return { summary: { next }, entries: order.map((key) => ({ key, value: items[key] })) };
    }
  }
}

/**
 * A change too big for one frame, as changes that each fit (one keyed value too big alone goes
 * alone): what it sets first, in order, then the last with what removes, reorders or moves the
 * cursor, so that a copy applying them in turn ends as the whole change would leave it. Appends
 * go first, as they name entries the copy holds already.
 */
export function divide(topic: RuntimeTopicKey, body: RuntimeBody, head: number): RuntimeBody[] {
  if (head + bytesOf(body) <= TOPIC_BUDGET) return [body];
  const room = TOPIC_BUDGET - head;
  const pack = <T>(items: readonly T[], overhead: number): T[][] => {
    const pieces: T[][] = [];
    let piece: T[] = [];
    let bytes = overhead;
    for (const item of items) {
      const size = bytesOf(item) + 1;
      if (piece.length > 0 && bytes + size > room) {
        pieces.push(piece);
        piece = [];
        bytes = overhead;
      }
      piece.push(item);
      bytes += size;
    }
    if (piece.length > 0) pieces.push(piece);
    return pieces;
  };
  const OVERHEAD = 512;
  switch (kindOf(topic)) {
    case 'run': {
      const { top, agents } = body as RunBody;
      const sets = pack(Object.entries(agents?.set ?? {}), OVERHEAD);
      const pieces: RunBody[] = sets.map((set) => ({ agents: { set: Object.fromEntries(set) } }));
      pieces.push({
        ...(top === undefined ? {} : { top }),
        ...(agents?.remove === undefined ? {} : { agents: { set: {}, remove: agents.remove } }),
      });
      return pieces;
    }
    case 'sessions': {
      const { agents } = body as SessionsBody;
      const sets = pack(Object.entries(agents.set), OVERHEAD);
      const pieces: SessionsBody[] = sets.map((set) => ({
        agents: { set: Object.fromEntries(set) },
      }));
      pieces.push({ agents: { set: {}, ...(agents.remove ? { remove: agents.remove } : {}) } });
      return pieces;
    }
    case 'session': {
      const { summary, entries } = body as SessionBody;
      const appends = pack(entries.append ?? [], OVERHEAD).map((append): SessionBody => ({
        entries: { append },
      }));
      const upserts = pack(entries.upsert ?? [], OVERHEAD).map((upsert): SessionBody => ({
        entries: { upsert },
      }));
      return [
        ...appends,
        ...upserts,
        {
          ...(summary === undefined ? {} : { summary }),
          entries: entries.order === undefined ? {} : { order: entries.order },
        },
      ];
    }
    case 'messages': {
      const { set, remove, order, next } = body as MessagesBody;
      const sets = pack(Object.entries(set), OVERHEAD).map((piece): MessagesBody => ({
        set: Object.fromEntries(piece),
      }));
      return [
        ...sets,
        {
          set: {},
          ...(remove === undefined ? {} : { remove }),
          ...(order === undefined ? {} : { order }),
          ...(next === undefined ? {} : { next }),
        },
      ];
    }
  }
}

/** Whether a caller sees a topic as you do (its changes are yours), or reads its own copy. */
export function seesWhole(caller: Caller): boolean {
  return caller.kind === 'human';
}
