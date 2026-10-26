import { legacyDirectories } from './workspaces/test-directories';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { MAX_ASKING_BYTES, MAX_SUGGESTION_BYTES, MAX_TOPIC_FRAME } from '../../shared/api/limits';
import { SURFACE } from '../../shared/api/surface';
import type { Party } from '../../shared/api/surface';
import { RuntimeTopic, snapshotFrameFits, topicKey } from '../../shared/api/topics';
import type {
  RuntimeChange,
  RuntimeSnapshotFrame,
  RuntimeTopicKey,
  TopicUpdate,
} from '../../shared/api/topics';
import type { Message } from '../../shared/model/messages';
import { askingView, runView } from '../../shared/model/views';
import type { EntryView, MessageView, RunView, SessionSummary } from '../../shared/model/views';
import type { SessionEvent, SessionMode } from '../../shared/session';
import type { Connector, SessionHost, SessionSpec } from '../sessions/connector';
import { FakeConnector } from '../sessions/fake';
import type { OpContext, ReceiptTopic } from './call';
import type { AgentCaller, Caller, OutsideCaller } from './caller';
import { Documents } from './canvas/documents';
import { commitDocument } from './canvas/test-documents';
import { createCore } from './core';
import type { Core } from './core';
import { WindowPorts } from './gui';
import { partsOf, readerOf, TOPIC_BUDGET } from './runtime-topics';
import { keepCanvases } from './store/test-store';
import { CALLERS, CANVAS, NO_DESKTOP, OTHER_CANVAS } from './test-registry';
import { openWindow } from './test-window';
import type { RuntimeSnapshot } from './topics';

/*
 * T3c for the runtime topics (B11 §5, §12, §16): every party's copy of a canvas's run, sessions,
 * sessions' transcripts and messages, rebuilt from its snapshot (whole, or a chunked transfer) and
 * each change after it, equals its read through the topic's projection, and agrees with the ops
 * that read it in pages; reach refuses what a party doesn't reach; long histories go as chunks,
 * each within a frame; revisions never skip, and a new core is a new epoch.
 */

const LEAD: AgentCaller = { kind: 'agent', canvas: CANVAS, agent: 'lead', session: 'lead-session' };
const WORKER: AgentCaller = {
  kind: 'agent',
  canvas: CANVAS,
  agent: 'worker',
  session: 'worker-session',
};
const WRITER = CALLERS['outside-write'] as OutsideCaller;
const READER = CALLERS['outside-read'] as OutsideCaller;
/** A token granted another canvas only. */
const ELSEWHERE: OutsideCaller = {
  kind: 'outside',
  token: 'elsewhere-token',
  name: 'elsewhere',
  access: 'read',
  canvases: [OTHER_CANVAS],
};
const PARTIES: Readonly<Record<Party, Caller>> = {
  you: CALLERS.you,
  lead: LEAD,
  worker: WORKER,
  'outside-read': READER,
  'outside-write': WRITER,
};
/** An agent whose id needs its key encoded, and isn't a UUID. */
const ODD = 'odd:%/"id';
const AGENTS = ['lead', 'helper', 'worker', 'peer', 'stranger', ODD];

let profile: string;
const cores: Core[] = [];

afterAll(async () => {
  await Promise.all(cores.map((core) => core.close().catch(() => undefined)));
});

/** A profile keeping a canvas of `agents` (all on Codex's App Server), its folder picked. */
async function keepWorld(
  agents: readonly { id: string; parent?: string }[] = AGENTS.map((id) =>
    id === 'helper' ? { id, parent: 'lead' } : { id },
  ),
  links: readonly (readonly [string, string])[] = [
    ['worker', 'peer'],
    ['lead', 'peer'],
  ],
): Promise<string> {
  const folder = await mkdtemp(path.join(tmpdir(), 'corrallm-runtime-topics-'));
  const project = path.join(folder, 'project');
  await mkdir(project);
  const file = path.join(folder, 'world.corral');
  await writeFile(
    file,
    JSON.stringify({
      format: 'corrallm',
      version: 2,
      id: CANVAS,
      nodes: agents.map(({ id, parent }, i) => ({
        id,
        kind: 'agent',
        label: `Agent ${String(i)}`,
        position: { x: 0, y: i * 100 },
        adapter: 'codex',
        connection: 'codex.app-server',
        ...(parent === undefined ? {} : { parent }),
      })),
      links: links.map((agents) => ({ agents })),
    }),
  );
  await keepCanvases(folder, { [CANVAS]: { file, project } });
  return folder;
}

async function start(
  folder: string,
  connector: Connector<SessionMode> = new FakeConnector({ adapter: 'codex' }),
  leads = (canvas: string, agent: string) => canvas === CANVAS && agent === 'lead',
): Promise<Core> {
  const core = await createCore(
    {
      profile: folder,
      app: { name: 'corrallm', version: '1.0.0' },
      check: true,
      distribution: 'local',
      directoryResolver: legacyDirectories,
      leads,
      sessions: {
        connectors: { 'codex.app-server': connector },
        environment: () => Promise.resolve({}),
      },
    },
    NO_DESKTOP,
  );
  cores.push(core);
  await core.engines.open(CANVAS);
  return core;
}

const key = (request: Record<string, string>): RuntimeTopicKey =>
  topicKey(RuntimeTopic.parse(request));
const RUN = key({ topic: 'run', canvas: CANVAS });
const SESSIONS = key({ topic: 'sessions', canvas: CANVAS });
const MESSAGES = key({ topic: 'messages', canvas: CANVAS });
const sessionOf = (agent: string) => key({ topic: 'session', canvas: CANVAS, agent });

type State = Record<string, unknown>;

/**
 * A copy of a runtime topic as a window keeps it: its snapshot (whole, or assembled from its
 * transfer's chunks once its end arrives, every index once and in order), then each change applied
 * in order at the next revision, as shared/api/topics.ts says each patches the state.
 */
class Copy {
  readonly topic: RuntimeTopicKey;
  readonly caller: Caller;
  readonly epoch: string;
  rev = -1;
  state: State | undefined;
  readonly changes: RuntimeChange[] = [];
  /** Every batch it was sent, as sent. */
  readonly batches: TopicUpdate[][] = [];
  #transfer:
    { id: string; summary: unknown; count: number; entries: [string, unknown][] } | undefined;
  #index = 0;

  constructor(
    topic: RuntimeTopicKey,
    caller: Caller,
    snapshot: RuntimeSnapshot | RuntimeSnapshotFrame,
  ) {
    this.topic = topic;
    this.caller = caller;
    this.epoch = snapshot.epoch;
    if ('kind' in snapshot) {
      expect(snapshot.kind).toBe('begin');
      if (snapshot.kind !== 'begin') return;
      expect(snapshot.topic).toBe(topic);
      this.#transfer = {
        id: snapshot.snapshot,
        summary: snapshot.summary,
        count: snapshot.count,
        entries: [],
      };
    } else {
      this.rev = snapshot.rev;
      this.state = snapshot.state as unknown as State;
    }
  }

  /** Whether its snapshot is installed. */
  get ready(): boolean {
    return this.state !== undefined;
  }

  apply(updates: readonly TopicUpdate[]): void {
    this.batches.push([...updates]);
    for (const update of updates) {
      if (update.topic !== this.topic) continue;
      expect(update.epoch).toBe(this.epoch);
      if ('kind' in update) {
        this.#frame(update);
        continue;
      }
      expect(this.#transfer, `${this.topic}: a change before its snapshot ended`).toBeUndefined();
      const change = update;
      if (change.rev <= this.rev) continue;
      expect(change.rev, `${this.topic} skipped a revision`).toBe(this.rev + 1);
      this.state = patch(this.topic, this.state ?? {}, change);
      this.rev = change.rev;
      this.changes.push(change);
    }
  }

  #frame(frame: RuntimeSnapshotFrame): void {
    if (frame.kind === 'begin') {
      expect(this.#transfer).toBeUndefined();
      this.#transfer = {
        id: frame.snapshot,
        summary: frame.summary,
        count: frame.count,
        entries: [],
      };
      this.#index = 0;
      return;
    }
    const transfer = this.#transfer;
    if (!transfer) throw new Error(`${this.topic}: a frame outside a transfer`);
    expect(frame.snapshot).toBe(transfer.id);
    if (frame.kind === 'chunk') {
      expect(frame.index).toBe(this.#index);
      expect(frame.index).toBeLessThan(transfer.count);
      this.#index += 1;
      for (const { key: id, value } of frame.entries) transfer.entries.push([id, value]);
      return;
    }
    expect(frame.kind).toBe('end');
    expect(this.#index).toBe(transfer.count);
    this.state = assembled(this.topic, transfer.summary, transfer.entries);
    this.rev = frame.rev;
    this.#transfer = undefined;
  }
}

/** A transfer's state, from its summary and entries in order. */
function assembled(topic: RuntimeTopicKey, summary: unknown, entries: [string, unknown][]): State {
  const record = Object.fromEntries(entries);
  const order = entries.map(([id]) => id);
  switch (topic.split(':')[0]) {
    case 'run':
      return {
        ...(summary as State),
        agents: Object.fromEntries(
          entries
            .filter(([key]) => key.startsWith('agent/'))
            .map(([key, value]) => [decodeURIComponent(key.slice(6)), value]),
        ),
        groups: Object.fromEntries(
          entries
            .filter(([key]) => key.startsWith('group/'))
            .map(([key, value]) => [decodeURIComponent(key.slice(6)), value]),
        ),
      };
    case 'sessions':
      return { agents: record };
    case 'session':
      return { summary, entries: record, order };
    default:
      return { items: record, order, next: (summary as { next: string }).next };
  }
}

/** `change` applied to `state`, as the wire contract says (an independent reading of it). */
function patch(topic: RuntimeTopicKey, state: State, change: RuntimeChange): State {
  const keyed = (
    record: Record<string, unknown>,
    set: Readonly<Record<string, unknown>>,
    remove: readonly string[] = [],
  ) => {
    const next: Record<string, unknown> = Object.fromEntries(
      Object.entries(record).filter(([id]) => !remove.includes(id)),
    );
    for (const [id, value] of Object.entries(set))
      Object.defineProperty(next, id, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    return next;
  };
  switch (topic.split(':')[0]) {
    case 'run': {
      const {
        top = {},
        agents,
        groups,
      } = change as unknown as {
        groups?: { set: State; remove?: string[] };
        top?: State;
        agents?: { set: State; remove?: string[] };
      };
      const next: State = { ...state };
      for (const [field, value] of Object.entries(top))
        if (value === null) Reflect.deleteProperty(next, field);
        else next[field] = value;
      if (agents) next.agents = keyed(state.agents as State, agents.set, agents.remove);
      if (groups) next.groups = keyed(state.groups as State, groups.set, groups.remove);
      return next;
    }
    case 'sessions': {
      const { agents } = change as unknown as { agents: { set: State; remove?: string[] } };
      return { agents: keyed(state.agents as State, agents.set, agents.remove) };
    }
    case 'session': {
      const { summary, entries: delta } = change as unknown as {
        summary?: unknown;
        entries: {
          upsert?: EntryView[];
          append?: { id: string; text: string }[];
          order?: string[];
        };
      };
      let entries = state.entries as Record<string, EntryView>;
      let order = state.order as string[];
      const added: string[] = [];
      for (const entry of delta.upsert ?? []) {
        if (!Object.hasOwn(entries, entry.id)) added.push(entry.id);
        entries = keyed(entries, { [entry.id]: entry }) as Record<string, EntryView>;
      }
      for (const { id, text } of delta.append ?? []) {
        const entry = Object.hasOwn(entries, id) ? entries[id] : undefined;
        if (!entry || (entry.kind !== 'text' && entry.kind !== 'thinking'))
          throw new Error(`${topic}: an append names no text entry ${id}`);
        entries = keyed(entries, { [id]: { ...entry, text: entry.text + text } }) as Record<
          string,
          EntryView
        >;
      }
      if (delta.order) {
        expect(new Set(delta.order).size).toBe(delta.order.length);
        for (const id of delta.order) expect(Object.hasOwn(entries, id), id).toBe(true);
        entries = Object.fromEntries(delta.order.map((id) => [id, entries[id]])) as Record<
          string,
          EntryView
        >;
        order = delta.order;
      } else order = [...order, ...added];
      return { summary: summary ?? state.summary, entries, order };
    }
    default: {
      const {
        set,
        remove = [],
        order,
        next,
      } = change as unknown as {
        set: Record<string, MessageView>;
        remove?: string[];
        order?: string[];
        next?: string;
      };
      const items = keyed(state.items as State, set, remove);
      const was = (state.order as string[]).filter((id) => !remove.includes(id));
      const added = Object.keys(set).filter((id) => !was.includes(id));
      return {
        items,
        order: order ?? [...was, ...added],
        next: next ?? state.next,
      };
    }
  }
}

/** The topics a party reads, by its audience: the run isn't a worker's (run.get is R). */
function topicsOf(party: Party): RuntimeTopicKey[] {
  const sessions: Record<Party, string[]> = {
    you: AGENTS,
    'outside-read': AGENTS,
    'outside-write': AGENTS,
    lead: ['lead', 'helper', 'peer'],
    worker: ['worker'],
  };
  return [
    ...(party === 'worker' ? [] : [RUN]),
    SESSIONS,
    MESSAGES,
    ...sessions[party].map(sessionOf),
  ];
}

/** Follows `topic` as `caller`, keeping a copy of it. */
async function follow(
  core: Core,
  topic: RuntimeTopicKey,
  caller: Caller,
): Promise<Copy & { stop: () => void }> {
  const box: { copy?: Copy; early: TopicUpdate[][] } = { early: [] };
  const { snapshot, stop } = await core.topics.follow(caller, topic, (updates) => {
    if (box.copy) box.copy.apply(updates);
    else box.early.push(updates);
  });
  const copy = new Copy(topic, caller, snapshot);
  for (const updates of box.early) copy.apply(updates);
  box.copy = copy;
  return Object.assign(copy, { stop });
}

/** Each copy, once installed, equals its read through the topic's projection, as its caller. */
async function expectCopiesRead(core: Core, copies: readonly Copy[]): Promise<void> {
  await vi.waitFor(
    async () => {
      for (const copy of copies) {
        const read = await core.topics.read(copy.topic, copy.caller);
        expect(read.ok, `${copy.topic}: ${JSON.stringify(read)}`).toBe(true);
        expect(copy.state, `${copy.topic} as ${JSON.stringify(copy.caller)}`).toEqual(
          read.ok ? read.value : undefined,
        );
      }
    },
    { timeout: 10_000, interval: 25 },
  );
}

/** Every page of a paged read, as `caller`. */
async function pages<T>(
  core: Core,
  read: (after: string | undefined) => Promise<{ items: T[]; next: string | null }>,
): Promise<{ items: T[]; next: string | null }> {
  const items: T[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await read(after);
    items.push(...page.items);
    if (page.items.length === 0 || page.next === null || page.next === after)
      return { items, next: page.next };
    after = page.next;
  }
}

/** What the ops that page each topic's read say, against `copy` (B11 §5: the same selectors). */
async function expectOpsAgree(core: Core, copy: Copy): Promise<void> {
  const state = copy.state ?? {};
  const kind = copy.topic.split(':')[0];
  if (kind === 'sessions') {
    const agents = state.agents as Record<string, SessionSummary>;
    const listed = await core.call('agents', { canvas: CANVAS }, copy.caller);
    if (!listed.ok) throw new Error(listed.error.sentence);
    expect(Object.keys(agents).sort()).toEqual(listed.value.agents.map(({ id }) => id).sort());
    for (const [agent, summary] of Object.entries(agents)) {
      const got = await core.call('session.get', { canvas: CANVAS, agent }, copy.caller);
      expect(got).toEqual({ ok: true, value: summary });
    }
  } else if (kind === 'session') {
    const { summary, entries, order } = state as {
      summary: SessionSummary;
      entries: Record<string, EntryView>;
      order: string[];
    };
    const got = await core.call(
      'session.get',
      { canvas: CANVAS, agent: summary.agent },
      copy.caller,
    );
    expect(got).toEqual({ ok: true, value: summary });
    const read = await pages(core, async (after) => {
      const page = await core.call(
        'session.transcript',
        {
          canvas: CANVAS,
          agent: summary.agent,
          limit: 200,
          ...(after === undefined ? {} : { after }),
        },
        copy.caller,
      );
      if (!page.ok) throw new Error(page.error.sentence);
      return { items: page.value.entries, next: page.value.next };
    });
    const whole = read.items.filter((entry) => !('cut' in entry));
    // A page cuts only what is too big for it; every other entry is the topic's, in its order.
    expect(whole).toEqual(
      order.map((id) => entries[id]).filter((_, i) => !('cut' in (read.items[i] ?? {}))),
    );
    expect(read.items.map(({ id }) => id)).toEqual(order);
  } else if (kind === 'messages') {
    const { items, order, next } = state as {
      items: Record<string, MessageView>;
      order: string[];
      next: string;
    };
    const read = await pages(core, async (after) => {
      const page = await core.call(
        'messages',
        { canvas: CANVAS, limit: 200, ...(after === undefined ? {} : { after }) },
        copy.caller,
      );
      if (!page.ok) throw new Error(page.error.sentence);
      return { items: page.value.items, next: page.value.next };
    });
    // A page's messages are the topic's, without where each came from.
    const strip = (message: MessageView | undefined): unknown =>
      Object.fromEntries(
        Object.entries(message ?? {}).filter(
          ([field]) => field !== 'origin' && field !== 'display',
        ),
      );
    expect(read.items).toEqual(order.map((id) => strip(items[id])));
    expect(read.next).toBe(next);
  }
}

describe('T3c: the runtime topics', { timeout: 30_000 }, () => {
  let core: Core;
  /** Each party's copy of each topic it reads. */
  const copies: (Copy & { stop: () => void })[] = [];
  const all = () => copies.filter((copy) => copy.ready);

  beforeAll(async () => {
    profile = await keepWorld();
    core = await start(profile);
    for (const [party, caller] of Object.entries(PARTIES) as [Party, Caller][])
      for (const topic of topicsOf(party)) copies.push(await follow(core, topic, caller));
  });
  afterAll(async () => {
    for (const copy of copies) copy.stop();
    await rm(profile, { recursive: true, force: true });
  });

  /** Waits until no agent's session works, and nothing waits to be delivered. */
  async function quiet(): Promise<void> {
    await vi.waitFor(
      () => {
        const open = core.engines.canvas(CANVAS);
        const sessions = open?.engine.sessions.snapshot() ?? {};
        expect(Object.values(sessions).every(({ status }) => status === 'idle')).toBe(true);
        expect(
          open?.messages.active().filter((message) => message.state !== 'delivered') ?? [],
        ).toEqual([]);
      },
      { timeout: 10_000, interval: 25 },
    );
  }

  it('reads each topic under its reading op: the registered run.get', () => {
    expect(readerOf('run')).toEqual({ name: 'run.get', surface: SURFACE['run.get'] });
    expect(readerOf('sessions').name).toBe('session.get');
    expect(readerOf('session').name).toBe('session.transcript');
    expect(readerOf('messages').name).toBe('messages');
  });

  it('has every party’s copy as its read before any change', async () => {
    expect(copies.every((copy) => copy.ready)).toBe(true);
    await expectCopiesRead(core, all());
    for (const copy of all()) await expectOpsAgree(core, copy);
  });

  it('keeps every copy its read as parties’ messages run turns and come back', async () => {
    for (const [from, to] of [
      [WRITER, 'worker'],
      [LEAD, 'helper'],
      [CALLERS.you, 'peer'],
      [WRITER, ODD],
    ] as const) {
      const sent = await core.call('message', { canvas: CANVAS, to, body: `Hello ${to}` }, from);
      expect(sent.ok, JSON.stringify(sent)).toBe(true);
    }
    await quiet();
    await expectCopiesRead(core, all());
    for (const copy of all()) await expectOpsAgree(core, copy);
    // A turn's text came as appends to its entry, never as a re-sent transcript.
    const yours = copies.find(
      ({ topic, caller }) => topic === sessionOf('worker') && caller === CALLERS.you,
    );
    expect(
      yours?.changes.some(
        (change) =>
          ((change as unknown as { entries?: { append?: unknown[] } }).entries?.append?.length ??
            0) > 0,
      ),
    ).toBe(true);
    // The worker's copy of the messages holds its own alone.
    const worker = copies.find(({ topic, caller }) => topic === MESSAGES && caller === WORKER);
    const items = Object.values((worker?.state as { items: Record<string, Message> }).items);
    expect(items.every(({ from, to }) => from === 'agent:worker' || to === 'agent:worker')).toBe(
      true,
    );
  });

  it('keeps every copy its read as each party holds and releases agents', async () => {
    for (const [op, args, caller] of [
      ['run.pause', { target: { agent: 'stranger' } }, CALLERS.you],
      ['run.pause', { target: { agent: 'helper' } }, LEAD],
      ['run.kill', { target: { agent: 'peer' } }, WRITER],
      ['run.unpause', { target: { agent: 'peer' } }, WRITER],
      ['run.pause', { target: { group: 'lead' } }, CALLERS.you],
    ] as const) {
      const done = await core.call(op, { canvas: CANVAS, ...args }, caller);
      expect(done.ok, `${op}: ${JSON.stringify(done)}`).toBe(true);
      await expectCopiesRead(core, all());
    }
    const lead = copies.find(({ topic, caller }) => topic === RUN && caller === LEAD);
    // A lead's run holds the agents it reaches, and the holds on them, alone.
    expect(Object.keys((lead?.state as unknown as RunView).agents).sort()).toEqual([
      'helper',
      'lead',
      'peer',
    ]);
    for (const copy of all()) await expectOpsAgree(core, copy);
  });

  it('keeps every copy its read as the document changes who reaches what, ending what no longer reaches', async () => {
    const link = await core.call(
      'canvas.link',
      { canvas: CANVAS, a: 'lead', b: 'stranger' },
      CALLERS.you,
    );
    expect(link.ok, JSON.stringify(link)).toBe(true);
    await expectCopiesRead(core, all());
    const leadSessions = copies.find(({ topic, caller }) => topic === SESSIONS && caller === LEAD);
    expect(Object.keys((leadSessions?.state as { agents: State }).agents)).toContain('stranger');
    // Now the lead reaches the stranger's session, and follows it.
    const stranger = await follow(core, sessionOf('stranger'), LEAD);
    await expectCopiesRead(core, [stranger]);
    const unlink = await core.call(
      'canvas.unlink',
      { canvas: CANVAS, a: 'lead', b: 'stranger' },
      CALLERS.you,
    );
    expect(unlink.ok, JSON.stringify(unlink)).toBe(true);
    await expectCopiesRead(core, all());
    expect(Object.keys((leadSessions?.state as { agents: State }).agents)).not.toContain(
      'stranger',
    );
    expect(await core.topics.read(sessionOf('stranger'), LEAD)).toMatchObject({
      ok: false,
      error: { code: 'not-found' },
    });
    // What it no longer reaches tells it nothing more.
    const heard = stranger.batches.length;
    core.engines.canvas(CANVAS)?.engine.sessions.notice('stranger', 'info', 'Noted');
    await expectCopiesRead(core, all());
    const yours = copies.find(
      ({ topic, caller }) => topic === sessionOf('stranger') && caller === CALLERS.you,
    );
    expect(Object.values((yours?.state as { entries: State }).entries)).toContainEqual(
      expect.objectContaining({ kind: 'notice', text: 'Noted' }),
    );
    expect(stranger.batches.length).toBe(heard);
    stranger.stop();
  });

  it('keeps every copy its read as an agent goes', async () => {
    const gone = await core.call('canvas.delete', { canvas: CANVAS, nodes: [ODD] }, CALLERS.you);
    expect(gone.ok, JSON.stringify(gone)).toBe(true);
    const yours = copies.find(({ topic, caller }) => topic === SESSIONS && caller === CALLERS.you);
    await vi.waitFor(() => {
      expect(Object.keys((yours?.state as { agents: State }).agents)).not.toContain(ODD);
    });
    const live = all().filter(({ topic }) => topic !== sessionOf(ODD));
    await expectCopiesRead(core, live);
    for (const copy of live) await expectOpsAgree(core, copy);
  });

  it('sends each copy every revision, in order of its canvas’s sequence', () => {
    for (const copy of copies) {
      const seqs = copy.changes.map(({ seq }) => seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
      expect(copy.changes.map(({ rev }) => rev)).toEqual(
        copy.changes.map((_, i) => (copy.changes[0]?.rev ?? 0) + i),
      );
    }
    // Every copy of a topic was told the same revisions, whatever it sees of it.
    const revs = (topic: RuntimeTopicKey) =>
      copies.filter((copy) => copy.topic === topic).map((copy) => copy.rev);
    for (const topic of [RUN, SESSIONS, MESSAGES]) expect(new Set(revs(topic)).size).toBe(1);
  });
});

describe('runtime topics: what isn’t reached is refused', () => {
  let core: Core;
  let folder: string;
  beforeAll(async () => {
    folder = await keepWorld();
    core = await start(folder);
  });
  afterAll(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it.each([
    [RUN, WORKER, 'forbidden'],
    [sessionOf('peer'), WORKER, 'not-found'],
    [sessionOf('stranger'), LEAD, 'not-found'],
    [MESSAGES, ELSEWHERE, 'not-found'],
    [SESSIONS, ELSEWHERE, 'not-found'],
    [sessionOf('nobody'), CALLERS.you, 'not-found'],
    [key({ topic: 'run', canvas: OTHER_CANVAS }), CALLERS.you, 'unavailable'],
  ] as const)('refuses %s to %j: %s', async (topic, caller, code) => {
    const heard: TopicUpdate[][] = [];
    await expect(
      core.topics.follow(caller, topic, (updates) => heard.push(updates)),
    ).rejects.toMatchObject({ code });
    expect(await core.topics.read(topic, caller)).toMatchObject({ ok: false, error: { code } });
    expect(heard).toEqual([]);
  });

  it('subscribes no token’s window, whatever topic it names', async () => {
    const ctx = { caller: WRITER, signal: new AbortController().signal } as unknown as OpContext;
    await expect(
      core.topics.subscribe(7, RuntimeTopic.parse({ topic: 'run', canvas: CANVAS }), ctx),
    ).rejects.toMatchObject({ code: 'human-only' });
  });
});

/** A connector whose sessions start with `history` (each a turn of a message, its reply and end). */
function withHistory(history: (agent: string) => SessionEvent[]): Connector<SessionMode> {
  const fake = new FakeConnector({ adapter: 'codex' });
  return {
    start: async (spec: SessionSpec<SessionMode>, host: SessionHost) => {
      const live = await fake.start(spec, host);
      const agent = fake.started.length - 1;
      host.emit({ type: 'history', events: history(String(agent)) });
      return live;
    },
  };
}

function turns(count: number, bytes: number, prefix: string): SessionEvent[] {
  return Array.from({ length: count }, (_, i): SessionEvent[] => {
    const id = `${prefix}-${String(i)}`;
    return [
      { type: 'user', id, text: `Turn ${String(i)}` },
      { type: 'text', id: `${id}/reply`, text: `${String(i)}: ${'x'.repeat(bytes)}` },
      {
        type: 'end',
        messages: [id],
        seconds: 1,
        result: { status: 'completed', reason: 'completed' },
      },
    ];
  }).flat();
}

describe('runtime topics: long histories', () => {
  let folder: string;
  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it('sends a session over a frame as indexed chunks within frames, a big entry alone, over a window’s port', async () => {
    folder = await keepWorld([{ id: 'worker' }], []);
    const big = 'y'.repeat(MAX_TOPIC_FRAME + 1000);
    const core = await start(
      folder,
      withHistory(() => [
        { type: 'user', id: 'first', text: 'Show me everything' },
        { type: 'text', id: 'first/reply', text: big },
        {
          type: 'end',
          messages: ['first'],
          seconds: 1,
          result: { status: 'completed', reason: 'completed' },
        },
        ...turns(1500, 1024, 'turn'),
      ]),
    );
    const open = core.engines.canvas(CANVAS);
    open?.engine.sessions.open('worker');
    await vi.waitFor(
      () => {
        expect(open?.engine.sessions.of('worker').entries.length).toBe(3 + 4500);
      },
      { timeout: 20_000 },
    );
    // Your window's port, as a window's would carry it.
    const served = new WindowPorts(core);
    const window = openWindow(served, 7);
    const box: { copy?: Copy; early: TopicUpdate[][] } = { early: [] };
    window.link.on('topic', (batch) => {
      if (box.copy) box.copy.apply(batch);
      else box.early.push(batch);
    });
    const topic = sessionOf('worker');
    const answer = await window.link.request('call', 'topics.subscribe', {
      topic: 'session',
      canvas: CANVAS,
      agent: 'worker',
      request: randomUUID(),
    });
    if (!answer.ok || !answer.value.ok) throw new Error(JSON.stringify(answer));
    const begin = answer.value.value as RuntimeSnapshotFrame;
    expect('kind' in begin && begin.kind).toBe('begin');
    const copy = new Copy(topic, CALLERS.you, begin);
    for (const batch of box.early) copy.apply(batch);
    box.copy = copy;
    await vi.waitFor(
      () => {
        expect(copy.ready).toBe(true);
      },
      { timeout: 20_000 },
    );
    await expectCopiesRead(core, [copy]);
    // Each batch the port carried fits a frame, but one holding a chunk of one big entry alone.
    for (const batch of copy.batches) {
      const bytes = Buffer.byteLength(JSON.stringify(batch));
      if (bytes <= MAX_TOPIC_FRAME) continue;
      expect(batch).toHaveLength(1);
      expect(batch[0]).toMatchObject({ kind: 'chunk', entries: [{ key: 'first/reply' }] });
    }
    expect(
      copy.batches.flat().filter((update) => 'kind' in update && update.kind === 'chunk').length,
    ).toBeGreaterThan(2);
    // A change after the transfer's end applies to it.
    const revised = copy.rev;
    open?.engine.sessions.notice('worker', 'info', 'After the snapshot');
    await expectCopiesRead(core, [copy]);
    expect(copy.rev).toBe(revised + 1);
    window.close();
  }, 60_000);

  it('says a change too big for a frame as changes that each fit, at consecutive revisions', async () => {
    folder = await keepWorld([{ id: 'worker' }], []);
    const core = await start(
      folder,
      withHistory(() => turns(1200, 1500, 'past')),
    );
    // Subscribed before the session's history arrives, as you and as a token.
    const yours = await follow(core, sessionOf('worker'), CALLERS.you);
    const theirs = await follow(core, sessionOf('worker'), WRITER);
    const open = core.engines.canvas(CANVAS);
    open?.engine.sessions.open('worker');
    await vi.waitFor(
      () => {
        expect(open?.engine.sessions.of('worker').entries.length).toBe(3600);
      },
      { timeout: 20_000 },
    );
    await expectCopiesRead(core, [yours, theirs]);
    for (const copy of [yours, theirs]) {
      expect(copy.changes.length).toBeGreaterThan(2);
      for (const change of copy.changes)
        expect(Buffer.byteLength(JSON.stringify(change))).toBeLessThanOrEqual(MAX_TOPIC_FRAME);
    }
    // A token's copy past a frame is a transfer too.
    const later = await follow(core, sessionOf('worker'), READER);
    await vi.waitFor(() => {
      expect(later.ready).toBe(true);
    });
    expect(later.changes).toEqual([]);
    expect(later.batches.flat().some((update) => 'kind' in update && update.kind === 'end')).toBe(
      true,
    );
    await expectCopiesRead(core, [later]);
  }, 60_000);

  it('rechecks authority immediately before flushing a queued private update', async () => {
    folder = await keepWorld();
    let lead = true;
    const core = await start(folder, undefined, () => lead);
    const copy = await follow(core, sessionOf('peer'), LEAD);
    vi.useFakeTimers();
    try {
      core.engines.canvas(CANVAS)?.engine.sessions.notice('peer', 'info', 'Private update');
      const barrier = await core.topics.follow(CALLERS.you, SESSIONS, () => undefined);
      barrier.stop();
      lead = false;
      await vi.advanceTimersByTimeAsync(16);
      expect(copy.batches).toEqual([]);
    } finally {
      vi.useRealTimers();
      copy.stop();
    }
  }, 30_000);

  it('does not revive a deleted agent’s transcript when a file restores the same id', async () => {
    folder = await keepWorld([{ id: 'worker' }], []);
    const subscribed = vi.spyOn(Documents.prototype, 'subscribe');
    const core = await start(folder);
    const documents = subscribed.mock.contexts[0] as Documents;
    const open = core.engines.canvas(CANVAS);
    if (!open) throw new Error('Canvas is not open');
    const original = open.document;
    open.engine.sessions.notice('worker', 'info', 'Old transcript');
    const old = await follow(core, sessionOf('worker'), CALLERS.you);
    const deleted = await core.call(
      'canvas.delete',
      { canvas: CANVAS, nodes: ['worker'] },
      CALLERS.you,
    );
    expect(deleted.ok).toBe(true);
    await commitDocument(documents, CANVAS, original);
    const restored = await follow(core, sessionOf('worker'), CALLERS.you);
    expect(restored.state).toHaveProperty('entries', {});
    await expectCopiesRead(core, [restored]);
    const heard = old.batches.length;
    open.engine.sessions.notice('worker', 'info', 'New transcript');
    await expectCopiesRead(core, [restored]);
    expect(old.batches.length).toBe(heard);
    old.stop();
  }, 30_000);

  it('sends a live oversized entry only as a single-entry chunk, never an oversized delta', async () => {
    folder = await keepWorld([{ id: 'worker' }], []);
    const core = await start(
      folder,
      withHistory(() => [
        { type: 'user', id: 'u', text: 'Hello' },
        { type: 'text', id: 't', text: 'z'.repeat(MAX_TOPIC_FRAME + 10) },
      ]),
    );
    // Yours, and a token's copy, which reads its own.
    const copies = [
      await follow(core, sessionOf('worker'), CALLERS.you),
      await follow(core, sessionOf('worker'), WRITER),
    ];
    core.engines.canvas(CANVAS)?.engine.sessions.open('worker');
    await vi.waitFor(() => {
      expect(core.engines.canvas(CANVAS)?.engine.sessions.of('worker').entries.length).toBe(2);
    });
    await expectCopiesRead(core, copies);
    for (const copy of copies) {
      const oversized = copy.batches
        .flat()
        .filter((update) => Buffer.byteLength(JSON.stringify(update)) > MAX_TOPIC_FRAME);
      expect(oversized.length).toBeGreaterThan(0);
      for (const update of oversized)
        expect(update).toMatchObject({ kind: 'chunk', entries: [{ key: 't' }] });
    }
  }, 30_000);

  it('sends an entry that leaves no room for the envelope alone in its chunk, as the mirror accepts it', async () => {
    folder = await keepWorld([{ id: 'worker' }], []);
    // Under a frame by itself, over one with a chunk's envelope: no frame within the cap holds it.
    const near = 'x'.repeat(MAX_TOPIC_FRAME - 200);
    const core = await start(
      folder,
      withHistory(() => [
        { type: 'user', id: 'u', text: 'Hello' },
        { type: 'text', id: 'near-frame', text: near },
      ]),
    );
    const open = core.engines.canvas(CANVAS);
    open?.engine.sessions.open('worker');
    await vi.waitFor(() => {
      expect(open?.engine.sessions.of('worker').entries).toHaveLength(2);
    });
    const copies = [
      await follow(core, sessionOf('worker'), CALLERS.you),
      await follow(core, sessionOf('worker'), WRITER),
    ];
    await vi.waitFor(() => {
      for (const copy of copies) expect(copy.ready).toBe(true);
    });
    await expectCopiesRead(core, copies);
    for (const copy of copies) {
      const frames = copy.batches.flat().filter((update) => 'kind' in update);
      for (const frame of frames) expect(snapshotFrameFits(frame)).toBe(true);
      const over = copy.batches.filter(
        (batch) => Buffer.byteLength(JSON.stringify(batch)) > TOPIC_BUDGET,
      );
      expect(over).toEqual([[expect.objectContaining({ kind: 'chunk' })]]);
      expect(over[0]?.[0]).toMatchObject({ entries: [{ key: 'near-frame' }] });
    }
    // Live, as such an entry is upserted: a transfer, its entry alone in its chunk.
    const heard = copies.map((copy) => copy.batches.length);
    open?.engine.sessions.notice('worker', 'info', near.slice(0, MAX_TOPIC_FRAME - 300));
    await expectCopiesRead(core, copies);
    copies.forEach((copy, i) => {
      for (const update of copy.batches.slice(heard[i]).flat()) {
        if ('kind' in update) expect(snapshotFrameFits(update)).toBe(true);
        else expect(Buffer.byteLength(JSON.stringify(update))).toBeLessThanOrEqual(TOPIC_BUDGET);
      }
    });
  }, 30_000);

  it('ends a subscription’s transfer before a replacement that follows it before it is sent', async () => {
    folder = await keepWorld([{ id: 'worker' }], []);
    const core = await start(
      folder,
      withHistory(() => turns(1200, 1500, 'past')),
    );
    const open = core.engines.canvas(CANVAS);
    open?.engine.sessions.open('worker');
    await vi.waitFor(
      () => {
        expect(open?.engine.sessions.of('worker').entries.length).toBe(3600);
      },
      { timeout: 20_000 },
    );
    // Subscribed: its transfer's begin answers it, its chunks and end wait for the next batch.
    const copies = [
      await follow(core, sessionOf('worker'), CALLERS.you),
      await follow(core, sessionOf('worker'), WRITER),
    ];
    for (const copy of copies) expect(copy.ready).toBe(false);
    // Before that batch: an entry no delta holds, said as a transfer that replaces the copy.
    open?.engine.sessions.notice('worker', 'info', 'n'.repeat(MAX_TOPIC_FRAME));
    await expectCopiesRead(core, copies);
    for (const copy of copies) {
      const frames = copy.batches.flat().filter((update) => 'kind' in update);
      // Both transfers whole and in turn: the subscription's ended, then the replacement.
      expect(frames.filter((frame) => frame.kind === 'end')).toHaveLength(2);
      expect(frames.filter((frame) => frame.kind === 'begin')).toHaveLength(1);
    }
  }, 60_000);

  it('caps long replies in every summary while retaining the whole transcript in chunks', async () => {
    folder = await keepWorld([{ id: 'worker' }], []);
    const core = await start(
      folder,
      withHistory(() => [
        { type: 'user', id: 'last', text: 'Say it all' },
        { type: 'text', id: 'last/reply', text: 'z'.repeat(MAX_TOPIC_FRAME + 10) },
        {
          type: 'end',
          messages: ['last'],
          seconds: 1,
          result: { status: 'completed', reason: 'completed' },
        },
      ]),
    );
    const open = core.engines.canvas(CANVAS);
    open?.engine.sessions.open('worker');
    await vi.waitFor(() => {
      expect(open?.engine.sessions.of('worker').entries.length).toBe(3);
    });
    const read = await core.call('session.get', { canvas: CANVAS, agent: 'worker' }, CALLERS.you);
    expect(read).toMatchObject({ ok: true, value: { reply: 'z'.repeat(4096), replyCut: true } });
    const transcript = await follow(core, sessionOf('worker'), CALLERS.you);
    await expectCopiesRead(core, [transcript]);
    expect(transcript.state).toHaveProperty(['summary', 'replyCut'], true);
    expect(transcript.state).toHaveProperty(
      ['entries', 'last/reply', 'text'],
      'z'.repeat(MAX_TOPIC_FRAME + 10),
    );
    const sessions = await follow(core, SESSIONS, CALLERS.you);
    await expectCopiesRead(core, [sessions]);
    expect(sessions.state).toHaveProperty(['agents', 'worker', 'replyCut'], true);
  }, 30_000);

  it('streams to many partial copies without scanning history or sending summaries again', async () => {
    folder = await keepWorld([{ id: 'worker' }], []);
    let host: SessionHost | undefined;
    const fake = new FakeConnector({ adapter: 'codex' });
    const core = await start(folder, {
      start: async (spec, sessionHost) => {
        host = sessionHost;
        const live = await fake.start(spec, sessionHost);
        sessionHost.emit({ type: 'history', events: turns(667, 160, 'past') });
        return live;
      },
    });
    const sessions = core.engines.canvas(CANVAS)?.engine.sessions;
    sessions?.open('worker');
    await vi.waitFor(() => {
      expect(sessions?.of('worker').entries).toHaveLength(2001);
    });
    const copies = await Promise.all(
      Array.from({ length: 12 }, () => follow(core, sessionOf('worker'), WRITER)),
    );
    const scan = vi.fn();
    const filter = Array.prototype.filter;
    const spy = vi.spyOn(Array.prototype, 'filter').mockImplementation(function (
      this: unknown[],
      predicate,
      thisArg?: unknown,
    ) {
      if (this.length === 2001 && (this[0] as EntryView | undefined)?.id === 'past-0') scan();
      return filter.call(this, predicate, thisArg) as unknown[];
    });
    const began = performance.now();
    try {
      host?.emit({ type: 'text', id: 'past-666/reply', text: ' more' });
      await vi.waitFor(() => {
        for (const copy of copies) expect(copy.changes.length).toBeGreaterThan(0);
      });
      expect(scan).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    for (const copy of copies) {
      expect(copy.changes.at(-1)).toMatchObject({
        entries: { append: [{ id: 'past-666/reply', text: ' more' }] },
      });
      expect(copy.changes.at(-1)).not.toHaveProperty('summary');
      copy.stop();
    }
    console.info(
      `12 partial copies × 2,001 entries: append published in ${(performance.now() - began).toFixed(1)} ms`,
    );
  }, 60_000);

  it('takes a turn after a long history from where its entries differ, subscribed or not', async () => {
    folder = await keepWorld([{ id: 'worker' }], []);
    let host: SessionHost | undefined;
    const fake = new FakeConnector({ adapter: 'codex' });
    const core = await start(folder, {
      start: async (spec, sessionHost) => {
        host = sessionHost;
        const live = await fake.start(spec, sessionHost);
        sessionHost.emit({ type: 'history', events: turns(667, 160, 'past') });
        return live;
      },
    });
    const sessions = core.engines.canvas(CANVAS)?.engine.sessions;
    sessions?.open('worker');
    await vi.waitFor(() => {
      expect(sessions?.of('worker').entries).toHaveLength(2001);
    });
    const topic = sessionOf('worker');
    const before = await follow(core, topic, CALLERS.you);
    before.stop();
    const scan = vi.fn();
    const { forEach, map, flatMap } = Array.prototype;
    const spies = (
      [
        ['forEach', forEach],
        ['map', map],
        ['flatMap', flatMap],
      ] as const
    ).map(([name, original]) =>
      vi.spyOn(Array.prototype, name).mockImplementation(function (
        this: unknown[],
        ...args: unknown[]
      ) {
        // The publisher's own reading of it (the engine's reducer reads it as a turn ends).
        if (
          this.length >= 2001 &&
          (this[0] as EntryView | undefined)?.id === 'past-0' &&
          /core\/(runtime-)?topics\.ts:/.test(new Error().stack ?? '')
        )
          scan(name);
        return (original as (...args: unknown[]) => unknown).apply(this, args);
      } as never),
    );
    try {
      // Nobody follows it now: its change is taken all the same, its revision moving.
      host?.emit({ type: 'user', id: 'next', text: 'Again' });
      host?.emit({ type: 'text', id: 'next/reply', text: 'Done' });
      host?.emit({
        type: 'end',
        messages: ['next'],
        seconds: 1,
        result: { status: 'completed', reason: 'completed' },
      });
      await vi.waitFor(() => {
        expect(sessions?.of('worker').entries.some(({ id }) => id === 'next/reply')).toBe(true);
      });
      // A write's receipts publish what the canvas has waiting first.
      await core.topics.receipts([RUN as ReceiptTopic], core.topics.mark());
      expect(scan).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    const copy = await follow(core, topic, CALLERS.you);
    expect(copy.rev).toBeGreaterThan(before.rev);
    await expectCopiesRead(core, [copy]);
    // Followed, the next turn comes as upserts of its own entries, the order only appended to.
    host?.emit({ type: 'user', id: 'last', text: 'Once more' });
    await vi.waitFor(() => {
      expect(copy.changes.at(-1)).toMatchObject({
        entries: { upsert: [expect.objectContaining({ id: 'last' })] },
      });
    });
    expect(copy.changes.at(-1)).not.toHaveProperty('entries.order');
    await expectCopiesRead(core, [copy]);
    copy.stop();
  }, 60_000);

  it('fits the largest summaries its fixtures make in a begin frame', () => {
    // Holds larger than a frame are keyed entries, never part of the begin summary.
    const parties = [
      'you',
      `agent:${'l'.repeat(200)}`,
      `outside:${'o'.repeat(32)}`,
      `outside:${'p'.repeat(32)}`,
    ] as const;
    const ids = (prefix: string, count: number) =>
      Array.from({ length: count }, (_, i) => `${prefix}-${'n'.repeat(48)}-${String(i)}`);
    const run = runView(
      {
        running: true,
        paused: true,
        individualPauses: ids('agent', 6000).flatMap((id) => parties.map((by) => ({ id, by }))),
        groupPauses: ids('group', 2000).flatMap((id) => parties.map((by) => ({ id, by }))),
        agents: {},
      },
      undefined,
      { saveError: 'e'.repeat(4096) },
    );
    const begin = (topic: RuntimeTopicKey, summary: unknown) =>
      Buffer.byteLength(
        JSON.stringify({
          topic,
          epoch: randomUUID(),
          snapshot: randomUUID(),
          kind: 'begin',
          summary,
          count: Number.MAX_SAFE_INTEGER,
        }),
      );
    expect(Buffer.byteLength(JSON.stringify(run))).toBeGreaterThan(MAX_TOPIC_FRAME);
    expect(partsOf(RUN, run).entries).toHaveLength(8000);
    expect(begin(RUN, partsOf(RUN, run).summary)).toBeLessThanOrEqual(TOPIC_BUDGET);
    // A session's summary: every command, model and task a CLI reports, and a long last reply.
    const summary = {
      agent: 'a'.repeat(256),
      connection: 'codex.app-server',
      status: 'working',
      paused: false,
      queued: 20,
      prompts: 5,
      unheard: 'u'.repeat(1024),
      tasks: Array.from({ length: 200 }, (_, i) => ({
        id: `task-${String(i)}`,
        description: 'd'.repeat(256),
        kind: 'command' as const,
        tool: 'Bash',
      })),
      commands: Array.from({ length: 500 }, (_, i) => ({
        name: `command-${String(i)}`,
        description: 'c'.repeat(200),
        argumentHint: '<file>',
      })),
      mode: 'auto',
      model: 'default',
      effort: 'high',
      models: Array.from({ length: 100 }, (_, i) => ({
        value: `model-${String(i)}`,
        label: 'Model',
        description: 'm'.repeat(200),
        efforts: [{ value: 'low', label: 'Low' }],
      })),
      running: { model: 'default', effort: 'high', mode: 'auto', role: 'r'.repeat(2000) },
      reply: 'r'.repeat(4096),
      replyCut: true,
      // Yours alone, and bounded: the longest suggestion, the most asks their budget keeps.
      suggestion: 's'.repeat(MAX_SUGGESTION_BYTES),
      asking: askingView(
        Array.from({ length: 20 }, (_, i) => ({
          kind: 'plan' as const,
          id: `plan-${String(i)}`,
          plan: '\u0001'.repeat(MAX_ASKING_BYTES),
        })),
      ),
    } as unknown as SessionSummary;
    const session = sessionOf('worker');
    expect(
      begin(session, partsOf(session, { summary, entries: {}, order: [] }).summary),
    ).toBeLessThanOrEqual(TOPIC_BUDGET);
  });

  it('serves twelve agents’ two-thousand-entry histories and streams appends alone', async () => {
    const agents = Array.from({ length: 12 }, (_, i) => ({ id: `agent-${String(i)}` }));
    folder = await keepWorld(agents, []);
    const core = await start(
      folder,
      withHistory((n) => turns(667, 160, `a${n}`)),
    );
    const open = core.engines.canvas(CANVAS);
    for (const { id } of agents) open?.engine.sessions.open(id);
    await vi.waitFor(
      () => {
        for (const { id } of agents) expect(open?.engine.sessions.of(id).entries.length).toBe(2001);
      },
      { timeout: 30_000 },
    );
    const began = performance.now();
    const sessions = await follow(core, SESSIONS, CALLERS.you);
    const each = await Promise.all(
      agents.map(({ id }) => follow(core, sessionOf(id), CALLERS.you)),
    );
    await vi.waitFor(
      () => {
        expect(each.every((copy) => copy.ready)).toBe(true);
      },
      { timeout: 30_000 },
    );
    const subscribed = performance.now() - began;
    await expectCopiesRead(core, [sessions, ...each]);
    // A turn's text streams to its own session's copy as appends; the summaries hear nothing of
    // its deltas, only of its status and end.
    const before = sessions.changes.length;
    const sent = await core.call(
      'message',
      { canvas: CANVAS, to: 'agent-3', body: 'One more' },
      WRITER,
    );
    if (!sent.ok) throw new Error(sent.error.sentence);
    await vi.waitFor(
      () => {
        expect(open?.messages.get(sent.value.id)?.state).toBe('replied');
      },
      { timeout: 10_000 },
    );
    await expectCopiesRead(core, [sessions, ...each]);
    const three = each[3];
    const appends = three?.changes.filter((change) => {
      const { entries, summary } = change as unknown as {
        entries: { append?: unknown[]; upsert?: unknown[]; order?: unknown };
        summary?: unknown;
      };
      return (
        entries.append !== undefined &&
        entries.upsert === undefined &&
        entries.order === undefined &&
        summary === undefined
      );
    });
    expect(appends?.length).toBeGreaterThan(0);
    const summaries = sessions.changes.slice(before).length;
    expect(summaries).toBeLessThan(three?.changes.length ?? 0);
    console.info(`12 × 2,001-entry histories: subscribed in ${subscribed.toFixed(0)} ms`);
  }, 120_000);
});

describe('runtime topics: revisions and epochs', () => {
  let folder: string;
  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it('returns publication receipts through a registered write, and none for its no-op', async () => {
    folder = await keepWorld();
    const core = await start(folder);
    const args = { canvas: CANVAS, target: { agent: 'worker' } };
    expect(await core.call('run.pause', args, CALLERS.you)).toMatchObject({
      ok: true,
      value: { revs: { [RUN]: 1, [`sessions:${CANVAS}`]: 1 } },
    });
    expect(await core.call('run.pause', args, CALLERS.you)).toEqual({
      ok: true,
      value: { revs: {} },
    });
  });

  it('moves a topic’s revision at each change whether or not anyone subscribes, and only at a change', async () => {
    folder = await keepWorld();
    const core = await start(folder);
    const mark = core.topics.mark();
    expect(await core.topics.receipts([RUN as ReceiptTopic], mark)).toEqual({});
    expect(
      (await core.call('run.pause', { canvas: CANVAS, target: { agent: 'worker' } }, CALLERS.you))
        .ok,
    ).toBe(true);
    const moved = await core.topics.receipts(
      [RUN as ReceiptTopic, `sessions:${CANVAS}`, MESSAGES as ReceiptTopic],
      mark,
    );
    expect(moved).toEqual({ [RUN]: 1, [`sessions:${CANVAS}`]: 1 });
    // A no-op moves nothing.
    const again = core.topics.mark();
    expect(
      (await core.call('run.pause', { canvas: CANVAS, target: { agent: 'worker' } }, CALLERS.you))
        .ok,
    ).toBe(true);
    expect(await core.topics.receipts([RUN as ReceiptTopic], again)).toEqual({});
    // A subscriber now starts at the revision the changes reached, with them in its snapshot.
    const run = await follow(core, RUN, CALLERS.you);
    expect(run.rev).toBe(1);
    expect(
      (run.state as unknown as { agents: Record<string, { paused?: boolean }> }).agents.worker
        ?.paused,
    ).toBe(true);
  });

  it('gives a receipt for what waits on a canvas as your revision, once its re-read is published', async () => {
    folder = await keepWorld();
    const core = await start(folder);
    const needs: `needs:${string}` = `needs:${CANVAS}`;
    const heard: unknown[] = [];
    const { snapshot, stop } = await core.topics.follow(CALLERS.you, `needs:${CANVAS}`, (changes) =>
      heard.push(...changes),
    );
    if ('kind' in snapshot) throw new Error('This fixture fits one frame.');
    expect(snapshot.rev).toBe(0);
    const mark = core.topics.mark();
    const proposed = await core.call(
      'canvas.delete',
      { canvas: CANVAS, nodes: ['stranger'] },
      WRITER,
    );
    expect(proposed).toMatchObject({ ok: true, value: { proposed: expect.any(String) as string } });
    expect(await core.topics.receipts([`needs:${CANVAS}`], mark)).toEqual({ [needs]: 1 });
    expect(await core.topics.receipts([`needs:${CANVAS}`], core.topics.mark())).toEqual({});
    await vi.waitFor(() => {
      expect(heard).toEqual([expect.objectContaining({ topic: needs, rev: 1 })]);
    });
    stop();
  });

  it('gives a restarted core a new epoch: a copy subscribes again, its revisions new', async () => {
    folder = await keepWorld();
    const first = await start(folder);
    const old = await follow(first, RUN, CALLERS.you);
    expect(
      (await first.call('run.pause', { canvas: CANVAS, target: { agent: 'worker' } }, CALLERS.you))
        .ok,
    ).toBe(true);
    await vi.waitFor(() => {
      expect(old.rev).toBe(1);
    });
    await first.close();
    const heard = old.batches.length;
    const second = await start(folder);
    expect(second.topics.epoch).not.toBe(first.topics.epoch);
    const fresh = await follow(second, RUN, CALLERS.you);
    expect(fresh.epoch).toBe(second.topics.epoch);
    // The run restored paused, as the journal kept it, at the new epoch's first revision.
    expect(
      (fresh.state as unknown as { agents: Record<string, { paused?: boolean }> }).agents.worker
        ?.paused,
    ).toBe(true);
    expect(fresh.rev).toBe(0);
    expect(
      (
        await second.call(
          'run.unpause',
          { canvas: CANVAS, target: { agent: 'worker' } },
          CALLERS.you,
        )
      ).ok,
    ).toBe(true);
    await vi.waitFor(() => {
      expect(fresh.rev).toBe(1);
    });
    await expectCopiesRead(second, [fresh]);
    expect(old.batches.length).toBe(heard);
  });
});
