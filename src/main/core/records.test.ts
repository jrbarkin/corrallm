import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TopicUpdate } from '../../shared/api/topics';
import type { CanvasId } from '../../shared/canvas';
import type { NeedsItem } from '../../shared/model/needs';
import { recordWords, UNRESOLVED_ANSWER } from '../../shared/model/records';
import type { RecordEntryView } from '../../shared/model/records';
import type { EntryView } from '../../shared/model/views';
import type { SessionMode } from '../../shared/session';
import type { Connector } from '../sessions/connector';
import { fakeConnector } from '../sessions/test-fake';
import type { AgentCaller, Caller, OutsideCaller } from './caller';
import { createCore } from './core';
import type { Core } from './core';
import { expectRestorable, liveRunOf } from './engine/run/test-restore';
import { keepCanvases, readOnDisk, writeOnDisk } from './store/test-store';
import { CALLERS, NO_DESKTOP } from './test-registry';
import { legacyDirectories } from './workspaces/test-directories';

/*
 * B19 Design §9 C3 through core.call: what the core settles for an agent (a run hold's answer, a
 * native prompt's, an ask's end) is kept with the association the core resolved as it settled it,
 * and reaches the window as a typed display entry of that agent's, through one selector at the
 * transcript's read and its topic: yours alone, a token reaching the agent reading none of it,
 * nowhere, while you see each.
 */

const CANVAS = '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f' as CanvasId;
const YOU = CALLERS.you;
const ORCHESTRATOR: OutsideCaller = {
  kind: 'outside',
  token: 'write-token',
  name: 'orchestrator',
  access: 'write',
  merge: true,
  canvases: [CANVAS],
};
const agent = (id: string): AgentCaller => ({
  kind: 'agent',
  canvas: CANVAS,
  agent: id,
  generation: 1,
  session: `${id}-session`,
});
/** The Builder, as its own session's token. */
const BUILDER = agent('a');
/** A lead linked to the Builder and the Reviewer: it reaches both, their transcripts too. */
const LINKER = agent('l');
/** Linked to nobody. */
const STRANGER = agent('s');
/** Every token that reaches the Builder and the Reviewer (the Builder its own alone). */
const REACHED: Caller[] = [ORCHESTRATOR, BUILDER, LINKER];

/** What you answer the Builder's OK with, in words: never in a record, its association or entry. */
const WORDS = 'private-change-words';

/**
 * The Builder writes a spec, asks for your OK on it, then builds; the Reviewer runs in Manual (its
 * CLI asks before it runs a command); the Linker reaches both; the Stranger neither.
 */
function canvasText(): string {
  const node = (id: string, label: string, x: number, extra: object = {}) => ({
    id,
    kind: 'agent',
    label,
    position: { x, y: 0 },
    adapter: 'claude-code',
    connection: 'claude-code.sdk',
    ...extra,
  });
  return JSON.stringify({
    format: 'corrallm',
    version: 2,
    id: CANVAS,
    nodes: [
      node('a', 'Builder', 0, {
        queue: [
          { id: 'spec', message: 'Write the spec' },
          { id: 'ok', approve: 'the spec' },
          { id: 'build', message: 'Build it' },
        ],
      }),
      node('b', 'Reviewer', 300, { settings: { 'claude-code': { mode: 'manual' } } }),
      node('l', 'Linker', 600),
      node('s', 'Stranger', 900),
    ],
    links: [{ agents: ['l', 'a'] }, { agents: ['l', 'b'] }],
  });
}

let profile: string;
const cores: Core[] = [];

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-records-'));
  const project = path.join(profile, 'project');
  await mkdir(project);
  const file = path.join(profile, 'team.corral');
  await writeFile(file, canvasText());
  await keepCanvases(profile, { [CANVAS]: { file, project } });
});

afterEach(async () => {
  expectRestorable();
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const core of cores.splice(0)) await core.close().catch(() => undefined);
  await rm(profile, { recursive: true, force: true });
});

async function start(
  connector: Connector<SessionMode> = fakeConnector({ mode: 'acceptEdits' }),
): Promise<Core> {
  const core = await createCore(
    {
      profile,
      app: { name: 'corrallm', version: '9.8.7' },
      check: true,
      distribution: 'local',
      directoryResolver: legacyDirectories,
      leads: (_canvas, id) => id === 'l',
      sessions: {
        // Its agent callers are made up: no session authority issued them.
        callers: () => true,
        connectors: { 'claude-code.sdk': connector },
        environment: () => Promise.resolve({}),
      },
      watchFolder: () => ({ close: () => undefined }),
    },
    NO_DESKTOP,
  );
  cores.push(core);
  const engine = await core.engines.open(CANVAS);
  // Kept to check that it restores (expectRestorable), given its canvas's nodes again to keep.
  liveRunOf(engine.run, engine.catalog, () => Date.now());
  engine.run.update(opened(core).document.nodes);
  return core;
}

async function ok<T = unknown>(core: Core, op: string, args: object, caller: Caller = YOU) {
  const result = await core.call(op as never, { canvas: CANVAS, ...args }, caller);
  if (!result.ok) throw new Error(`${op}: ${result.error.code}: ${result.error.sentence}`);
  return result.value as T;
}

async function needsOf(core: Core, caller: Caller = YOU): Promise<NeedsItem[]> {
  return (await ok<{ items: NeedsItem[] }>(core, 'needs', {}, caller)).items;
}

/** The first item waiting that `which` picks, once one does. */
async function waitingFor(core: Core, which: (item: NeedsItem) => boolean): Promise<NeedsItem> {
  let found: NeedsItem | undefined;
  await vi.waitFor(
    async () => {
      found = (await needsOf(core)).find(which);
      expect(found).toBeDefined();
    },
    { timeout: 10_000, interval: 10 },
  );
  if (found === undefined) throw new Error('Nothing waits');
  return found;
}

const isHold = (id: string) => (item: NeedsItem) => item.kind === 'hold' && item.agent === id;
const isPrompt = (id: string) => (item: NeedsItem) => item.kind === 'prompt' && item.agent === id;

function opened(core: Core) {
  const open = core.engines.canvas(CANVAS);
  if (open === undefined) throw new Error('The canvas is not open.');
  return open;
}

/** The association kept on disk with message `id`, as the profile's database holds it. */
function aboutOnDisk(id: string): unknown {
  const row = readOnDisk(profile, (disk) =>
    disk.prepare('SELECT about FROM message WHERE id = ?').get(id),
  ) as { about: string | null } | undefined;
  return row?.about === null || row?.about === undefined ? undefined : JSON.parse(row.about);
}

describe('what the core settles for an agent is kept with its association', () => {
  it('a run hold’s answer: its agent, its Needs item and the choice by key, never the words given', async () => {
    const core = await start();
    opened(core).engine.run.start();
    const hold = await waitingFor(core, isHold('a'));
    // Ask for changes, in words: the Builder makes them, then asks again.
    const changes = await ok<{ id: string }>(core, 'reply', {
      to: hold.id,
      answer: { text: WORDS },
    });
    const again = await waitingFor(core, (item) => isHold('a')(item) && item.id !== hold.id);
    const approved = await ok<{ id: string }>(core, 'reply', {
      to: again.id,
      answer: { choice: 'approve' },
    });
    expect(opened(core).messages.records('a')).toMatchObject([
      {
        message: { id: changes.id, kind: 'settled', to: 'you', by: 'you' },
        about: { v: 1, agent: 'a', need: hold.id, hold: { words: true } },
      },
      {
        message: { id: approved.id },
        about: { v: 1, agent: 'a', need: again.id, hold: { choice: 'approve' } },
      },
    ]);
    await opened(core).messages.durable();
    expect(aboutOnDisk(approved.id)).toEqual({
      v: 1,
      agent: 'a',
      need: again.id,
      hold: { choice: 'approve' },
    });
    const kept = JSON.stringify([aboutOnDisk(changes.id), aboutOnDisk(approved.id)]);
    expect(kept).not.toContain(WORDS);
    expect(kept).not.toContain('Your OK');
    // No other agent's window shows it.
    expect(opened(core).messages.records('b')).toEqual([]);
  });

  it('a native prompt’s answer: its agent and Needs item, shown by B13’s owner entry alone while the core runs', async () => {
    const core = await start();
    await ok(core, 'message', { to: 'b', body: 'Run the tests' });
    const prompt = await waitingFor(core, isPrompt('b'));
    const answered = await ok<{ id: string }>(core, 'reply', {
      to: prompt.id,
      answer: { choice: 'allow' },
    });
    await opened(core).messages.durable();
    expect(aboutOnDisk(answered.id)).toEqual({ v: 1, agent: 'b', need: prompt.id });
    expect(opened(core).messages.records('b')).toEqual([]);
  });

  it('an ask’s end: its recipient agent and the ask’s Needs item', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    const core = await start();
    // Held, so its ask waits unanswered until its deadline.
    await ok(core, 'run.pause', { target: { agent: 'a' } });
    const { id } = await ok<{ id: string }>(
      core,
      'ask',
      {
        to: 'a',
        questions: [
          {
            id: 'scope',
            header: 'Scope',
            text: 'How much of it?',
            options: [{ label: 'All' }, { label: 'Some' }],
            multiple: false,
            other: false,
          },
        ],
        deadlineSeconds: 60,
      },
      ORCHESTRATOR,
    );
    await vi.advanceTimersByTimeAsync(60_001);
    await vi.waitFor(() => {
      expect(opened(core).messages.records('a')).toHaveLength(1);
    });
    const [ended] = opened(core).messages.records('a');
    expect(ended).toMatchObject({
      message: {
        kind: 'settled',
        from: 'corrallm',
        to: 'outside:orchestrator',
        replyTo: id,
        settled: { outcome: { type: 'expired' } },
      },
      about: { v: 1, agent: 'a', need: `ask/${id}` },
    });
  });
});

/** Every page of `agent`'s transcript as `caller` reads it. */
async function transcript(core: Core, id: string, caller: Caller = YOU): Promise<EntryView[]> {
  const entries: EntryView[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await ok<{ entries: EntryView[]; next: string | null }>(
      core,
      'session.transcript',
      { agent: id, limit: 3, ...(after === undefined ? {} : { after }) },
      caller,
    );
    entries.push(...page.entries);
    if (page.entries.length === 0 || page.next === null) return entries;
    after = page.next;
  }
}

/** `agent`'s session topic as `caller` reads it now: its entries in order. */
async function topicEntries(core: Core, id: string, caller: Caller = YOU): Promise<EntryView[]> {
  const read = await core.topics.read(`session:${CANVAS}:${id}`, caller);
  if (!read.ok) throw new Error(read.error.sentence);
  const { entries, order } = read.value as { entries: Record<string, EntryView>; order: string[] };
  return order.flatMap((one) => entries[one] ?? []);
}

/**
 * A copy of `agent`'s session topic as `caller` follows it, kept by its changes as the wire says
 * (upserts, appends, an order that replaces), and every change it was sent.
 */
/** A session topic's state, as a copy keeps it. */
interface State {
  entries: Record<string, EntryView>;
  order: string[];
}

async function follow(core: Core, id: string, caller: Caller = YOU) {
  const copy: { state?: State; sent: unknown[]; stop: () => void } = {
    sent: [],
    stop: () => undefined,
  };
  const apply = (updates: readonly TopicUpdate[]) => {
    for (const update of updates) {
      if ('kind' in update || copy.state === undefined) continue;
      copy.sent.push(update);
      const { entries: delta } = update as unknown as {
        entries: {
          upsert?: EntryView[];
          append?: { id: string; text: string }[];
          order?: string[];
        };
      };
      let entries = { ...copy.state.entries };
      const added: string[] = [];
      for (const entry of delta.upsert ?? []) {
        if (!Object.hasOwn(entries, entry.id)) added.push(entry.id);
        entries[entry.id] = entry;
      }
      for (const { id: one, text } of delta.append ?? []) {
        const entry = entries[one];
        if (entry?.kind === 'text' || entry?.kind === 'thinking')
          entries[one] = { ...entry, text: entry.text + text };
      }
      let order = [...copy.state.order, ...added];
      if (delta.order) {
        order = [...delta.order];
        const kept = entries;
        entries = Object.fromEntries(
          order.flatMap((one) => {
            const entry = kept[one];
            return entry === undefined ? [] : [[one, entry]];
          }),
        );
      }
      copy.state = { entries, order };
    }
  };
  const early: (readonly TopicUpdate[])[] = [];
  const { snapshot, stop } = await core.topics.follow(
    caller,
    `session:${CANVAS}:${id}`,
    (updates) => {
      if (copy.state === undefined) early.push(updates);
      else apply(updates);
    },
  );
  copy.state = (snapshot as unknown as { state: State }).state;
  for (const updates of early) apply(updates);
  copy.stop = stop;
  return {
    copy,
    entries: () => (copy.state?.order ?? []).flatMap((one) => copy.state?.entries[one] ?? []),
  };
}

const records = (entries: readonly EntryView[]) =>
  entries.filter((entry): entry is RecordEntryView => entry.kind === 'record');

/** The Builder's OK answered in words, then approved: each record's id. */
async function answeredHolds(
  core: Core,
): Promise<{ changes: string; approved: string; need: string }> {
  opened(core).engine.run.start();
  const hold = await waitingFor(core, isHold('a'));
  const changes = await ok<{ id: string }>(core, 'reply', { to: hold.id, answer: { text: WORDS } });
  const again = await waitingFor(core, (item) => isHold('a')(item) && item.id !== hold.id);
  const approved = await ok<{ id: string }>(core, 'reply', {
    to: again.id,
    answer: { choice: 'approve' },
  });
  await vi.waitFor(
    () => {
      expect(opened(core).engine.run.snapshot().agents.a?.status).toBe('done');
    },
    { timeout: 10_000, interval: 10 },
  );
  return { changes: changes.id, approved: approved.id, need: again.id };
}

const NAMES = (party: string) => (party === 'you' ? 'you' : party);

describe('the window shows each record its agent’s', () => {
  it('gives you the Builder’s hold answers, typed and value-free, ahead of its transcript in the store’s order, at the read and the topic alike', async () => {
    const core = await start();
    const followed = await follow(core, 'a');
    const { changes, approved, need } = await answeredHolds(core);
    const read = await transcript(core, 'a');
    expect(records(read)).toEqual([
      {
        id: `record/${changes}`,
        kind: 'record',
        message: changes,
        need: expect.stringMatching(/^hold\/a\/[0-9a-f]{8}\/ok$/) as string,
        at: expect.any(Number) as number,
        by: 'you',
        state: 'settled',
        record: { type: 'hold', words: true },
      },
      {
        id: `record/${approved}`,
        kind: 'record',
        message: approved,
        need,
        at: expect.any(Number) as number,
        by: 'you',
        state: 'settled',
        record: { type: 'hold', choice: 'approve' },
      },
    ]);
    // The window leads the transcript; the native entries follow, as the session holds them.
    expect(read.slice(0, 2).map(({ kind }) => kind)).toEqual(['record', 'record']);
    expect(read.slice(2).some(({ kind }) => kind === 'record')).toBe(false);
    expect(read.slice(2).map(({ id }) => id)).toEqual(
      opened(core)
        .engine.sessions.of('a')
        .entries.map(({ id }) => id),
    );
    // One selector: the topic's state and a copy kept by its changes are the read's.
    expect(await topicEntries(core, 'a')).toEqual(read);
    await vi.waitFor(() => {
      expect(followed.entries()).toEqual(read);
    });
    followed.copy.stop();
    // Never the words given, the hold's title or the record's own words.
    expect(JSON.stringify(read.slice(0, 2))).not.toMatch(/private-change-words|Your OK|answered “/);
    const [first, second] = records(read);
    if (first === undefined || second === undefined) throw new Error('No records');
    expect(recordWords(first, NAMES)).toBe('Answered in words by you.');
    expect(recordWords(second, NAMES)).toBe('Answered by you.');
  });

  it('gives a token that reaches the Builder none of it, at the read, the topic, the counts or an error, while you see each', async () => {
    const core = await start();
    const copies = await Promise.all(REACHED.map((caller) => follow(core, 'a', caller)));
    const { changes, approved } = await answeredHolds(core);
    const sentinels = [changes, approved];
    // The control: you see each, at every boundary.
    const yours = JSON.stringify([await transcript(core, 'a'), await topicEntries(core, 'a')]);
    for (const id of sentinels) expect(yours).toContain(id);
    const unknown = `record/${crypto.randomUUID()}`;
    for (const [index, caller] of REACHED.entries()) {
      const who = JSON.stringify(caller);
      const read = await transcript(core, 'a', caller);
      expect(records(read), who).toEqual([]);
      const boundaries = {
        read,
        topic: await topicEntries(core, 'a', caller),
        followed: copies[index]?.copy,
        summary: await ok(core, 'session.get', { agent: 'a' }, caller),
        agents: await ok(core, 'agents', {}, caller),
        needs: await ok(core, 'needs', {}, caller),
        messages: await ok(core, 'messages', {}, caller),
        ...(caller.kind === 'outside' ? { status: await ok(core, 'status', {}, caller) } : {}),
      };
      const text = JSON.stringify(boundaries);
      for (const id of sentinels) expect.soft(text, `${who}: ${id}`).not.toContain(id);
      expect.soft(text, who).not.toContain('"kind":"record"');
      // An error says nothing more of a record than of an id never given.
      for (const id of sentinels) {
        const named = await core.call(
          'session.transcript',
          { canvas: CANVAS, agent: 'a', after: `record/${id}` },
          caller,
        );
        const made = await core.call(
          'session.transcript',
          { canvas: CANVAS, agent: 'a', after: unknown },
          caller,
        );
        expect(named, who).toEqual(made);
        expect(named.ok, who).toBe(false);
      }
    }
    // You read on from a record as from any entry.
    const after = await ok<{ entries: EntryView[] }>(core, 'session.transcript', {
      agent: 'a',
      after: `record/${changes}`,
      limit: 1,
    });
    expect(after.entries.map(({ id }) => id)).toEqual([`record/${approved}`]);
    // Counts alike for every reader: no record is a prompt, or anything waiting.
    const count = async (caller: Caller) =>
      (await ok<{ prompts: number; queued: number }>(core, 'session.get', { agent: 'a' }, caller))
        .prompts;
    for (const caller of REACHED) expect(await count(caller)).toBe(await count(YOU));
    // A token that doesn't reach the Builder reads none of its transcript, as before.
    expect(
      (await core.call('session.transcript', { canvas: CANVAS, agent: 'a' }, STRANGER)).ok,
    ).toBe(false);
    for (const copy of copies) copy.copy.stop();
  });

  it('keeps each entry’s id and place across a reload, a /clear and a restart: never a second one, and never in the native transcript', async () => {
    const core = await start();
    const { changes, approved } = await answeredHolds(core);
    const ids = [`record/${changes}`, `record/${approved}`];
    const lead = async (one: Core) => (await transcript(one, 'a')).slice(0, 2).map(({ id }) => id);
    expect(await lead(core)).toEqual(ids);
    // A reload reads the same entries again, once each.
    const again = await topicEntries(core, 'a');
    expect(again.map(({ id }) => id).filter((id) => ids.includes(id))).toEqual(ids);
    expect(new Set(again.map(({ id }) => id)).size).toBe(again.length);
    // The projection is no entry of the session: no turn's reply, rewind or cap reads it.
    const session = opened(core).engine.sessions.of('a');
    expect(session.entries.some(({ kind }) => (kind as string) === 'record')).toBe(false);
    // A /clear (a new conversation) empties the native transcript, never the window.
    opened(core).engine.sessions.resumed('a');
    await vi.waitFor(async () => {
      expect((await transcript(core, 'a')).map(({ id }) => id).slice(0, 2)).toEqual(ids);
    });
    expect(
      opened(core)
        .engine.sessions.of('a')
        .entries.some(({ id }) => ids.includes(id)),
    ).toBe(false);
    await core.close();
    cores.splice(0);
    // Across a restart: the same entries, in the same order, at the head of the transcript.
    const restarted = await start();
    expect(await lead(restarted)).toEqual(ids);
    expect(records(await topicEntries(restarted, 'a')).map(({ id }) => id)).toEqual(ids);
  });

  it('shows the Reviewer’s native decision only once a crash cut it off: unresolved, never as applied', async () => {
    const core = await start();
    await ok(core, 'message', { to: 'b', body: 'Run the tests' });
    const prompt = await waitingFor(core, isPrompt('b'));
    const answered = await ok<{ id: string }>(core, 'reply', {
      to: prompt.id,
      answer: { choice: 'allow' },
    });
    // While the core runs, its owner entry shows it, settled in place, and no record entry does.
    await vi.waitFor(async () => {
      const read = await transcript(core, 'b');
      expect(read.find(({ kind }) => kind === 'prompt')).toMatchObject({ outcome: { by: 'you' } });
      expect(records(read)).toEqual([]);
    });
    await opened(core).messages.durable();
    await core.close();
    cores.splice(0);
    // As if corrallm stopped between the record and its landing.
    writeOnDisk(profile, `UPDATE message SET state = 'delivering' WHERE id = '${answered.id}'`);
    const restarted = await start();
    const [cut, ...rest] = records(await transcript(restarted, 'b'));
    expect(rest).toEqual([]);
    expect(cut).toMatchObject({
      id: `record/${answered.id}`,
      need: prompt.id,
      by: 'you',
      state: 'unresolved',
      record: { type: 'prompt', prompt: { kind: 'approval' }, outcome: { type: 'choice' } },
    });
    if (cut === undefined) throw new Error('No record');
    expect(recordWords(cut, NAMES)).toBe(`Allowed once by you, but ${UNRESOLVED_ANSWER}`);
    for (const caller of [ORCHESTRATOR, LINKER])
      expect(JSON.stringify(await transcript(restarted, 'b', caller))).not.toContain(answered.id);
  });

  it('shows how an ask ended in its recipient’s window, yours alone: its asker reads its own record elsewhere', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    const core = await start();
    await ok(core, 'run.pause', { target: { agent: 'a' } });
    const { id } = await ok<{ id: string }>(
      core,
      'ask',
      {
        to: 'a',
        questions: [
          {
            id: 'scope',
            header: 'Scope',
            text: 'How much of it?',
            options: [{ label: 'All' }, { label: 'Some' }],
            multiple: false,
            other: false,
          },
        ],
        deadlineSeconds: 60,
      },
      ORCHESTRATOR,
    );
    await vi.advanceTimersByTimeAsync(60_001);
    await vi.waitFor(async () => {
      expect(records(await transcript(core, 'a'))).toHaveLength(1);
    });
    const [ended] = records(await transcript(core, 'a'));
    expect(ended).toMatchObject({
      need: `ask/${id}`,
      state: 'settled',
      record: {
        type: 'ask',
        asker: 'outside:orchestrator',
        questions: 1,
        outcome: { type: 'expired' },
      },
    });
    if (ended === undefined) throw new Error('No record');
    expect(recordWords(ended, NAMES)).toBe('outside:orchestrator’s question expired unanswered.');
    expect(records(await transcript(core, 'a', ORCHESTRATOR))).toEqual([]);
  });

  it('reads an agent’s window only as its records change: another agent’s turn and its words read none', async () => {
    const core = await start();
    const followed = await follow(core, 'a');
    const reviewer = await follow(core, 'b');
    const read = vi.spyOn(opened(core).messages, 'records');
    await ok(core, 'message', { to: 'b', body: 'Run the tests' });
    const prompt = await waitingFor(core, isPrompt('b'));
    await ok(core, 'reply', { to: prompt.id, answer: { choice: 'allow' } });
    await vi.waitFor(() => {
      expect(opened(core).engine.sessions.of('b').status).toBe('idle');
    });
    expect(read.mock.calls.filter(([one]) => one === 'a')).toEqual([]);
    followed.copy.stop();
    reviewer.copy.stop();
  });
});
