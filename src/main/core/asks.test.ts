import { legacyDirectories } from './workspaces/test-directories';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_OPEN_ASKS, MAX_WAITING } from '../../shared/api/limits';
import { SURFACE } from '../../shared/api/surface';
import type { Message } from '../../shared/model/messages';
import type { NeedsItem } from '../../shared/model/needs';
import type { OpResult } from '../../shared/api/errors';
import { fakeConnector } from '../sessions/test-fake';
import type { FakeConnector } from '../sessions/fake';
import type { AgentCaller, Caller, OutsideCaller } from './caller';
import { scopeOf } from './call';
import { createCore } from './core';
import type { Core } from './core';
import { keepCanvases, readOnDisk } from './store/test-store';
import { CALLERS, CANVAS, NO_DESKTOP } from './test-registry';

/*
 * B21 C4 (Design §9.2 C5, C6): a party's messages to you and to its manager, and durable asks,
 * through core.call: admission, routing, framing, the `message/` and `ask/` Needs items, `reply`
 * for both, answer rows, the free-text fallback, expiry, withdrawal and the asker's notices.
 */

const YOU = CALLERS.you;
const OUTSIDE = CALLERS['outside-write'] as OutsideCaller;
const agentCaller = (agent: string): AgentCaller => ({
  kind: 'agent',
  canvas: CANVAS,
  agent,
  generation: 1,
  session: `${agent}-session`,
});
/** Planner asks Builder, linked to it; Stranger is linked to nobody. */
const PLANNER = agentCaller('planner');
const BUILDER = agentCaller('builder');

const QUESTION = {
  id: 'scope',
  header: 'Scope',
  text: 'How much of it?',
  options: [{ label: 'All' }, { label: 'Some', description: 'Only what changed' }],
  multiple: false,
  other: true,
};
const DAY = 86_400_000;

let profile: string;
let core: Core | undefined;
let appServer: FakeConnector;

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-asks-'));
  appServer = fakeConnector({ adapter: 'codex' });
});

afterEach(async () => {
  await core?.close();
  core = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  await rm(profile, { recursive: true, force: true });
});

/**
 * A profile keeping a canvas of Planner and Builder, linked, and Stranger, on Codex's App Server;
 * and Shell, on Codex's Terminal (whose shell prefix is "!"), linked to Builder.
 */
async function keepCanvas(): Promise<void> {
  const project = path.join(profile, 'project');
  await mkdir(project);
  const file = path.join(profile, 'canvas.corral');
  await writeFile(
    file,
    JSON.stringify({
      format: 'corrallm',
      version: 2,
      id: CANVAS,
      nodes: ['planner', 'builder', 'stranger']
        .map((id, i) => ({
          id,
          kind: 'agent',
          label: id.charAt(0).toUpperCase() + id.slice(1),
          position: { x: 0, y: i * 100 },
          adapter: 'codex',
          connection: 'codex.app-server',
        }))
        .concat({
          id: 'shell',
          kind: 'agent',
          label: 'Shell',
          position: { x: 0, y: 300 },
          adapter: 'codex',
          connection: 'codex.terminal',
        }),
      links: [{ agents: ['planner', 'builder'] }, { agents: ['shell', 'builder'] }],
    }),
  );
  await keepCanvases(profile, { [CANVAS]: { file, project } });
}

async function start(connector: FakeConnector = appServer): Promise<Core> {
  core = await createCore(
    {
      profile,
      app: { name: 'corrallm', version: '9.8.7' },
      check: true,
      distribution: 'local',
      directoryResolver: legacyDirectories,
      locale: 'en-GB',
      sessions: {
        // Its agent callers are made up: no session authority issued them.
        callers: () => true,
        connectors: {
          'codex.app-server': connector,
          'codex.terminal': fakeConnector({ adapter: 'codex' }),
        },
        environment: () => Promise.resolve({}),
      },
    },
    NO_DESKTOP,
  );
  await core.engines.open(CANVAS);
  return core;
}

async function restart(connector?: FakeConnector): Promise<Core> {
  await core?.close();
  core = undefined;
  return start(connector);
}

/** Calls `name` as `caller`: its result, whatever it is. */
function call(
  name: string,
  args: Record<string, unknown>,
  caller: Caller,
): Promise<OpResult<unknown>> {
  if (core === undefined) throw new Error('No core');
  return core.call(name as never, { canvas: CANVAS, ...args }, caller);
}

/** Calls `name` as `caller`, expecting it to work: its result. */
async function ok<T = Record<string, unknown>>(
  name: string,
  args: Record<string, unknown>,
  caller: Caller,
): Promise<T> {
  const result = await call(name, args, caller);
  if (!result.ok) throw new Error(`${name} failed: ${JSON.stringify(result)}`);
  return result.value as T;
}

/** What `caller` may read of the canvas's messages, oldest first. */
async function inbox(caller: Caller): Promise<Message[]> {
  const all: Message[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await ok<{ items: Message[]; next: string }>(
      'messages',
      after === undefined ? {} : { after },
      caller,
    );
    if (page.items.length === 0) return all;
    all.push(...page.items);
    after = page.next;
  }
}

/** A message as `caller` reads it now. */
async function find(id: string, caller: Caller = YOU): Promise<Message | undefined> {
  return (await inbox(caller)).find((message) => message.id === id);
}

async function needsOf(caller: Caller = YOU): Promise<NeedsItem[]> {
  return (await ok<{ items: NeedsItem[] }>('needs', {}, caller)).items;
}

/** Asks `to` the question, as `caller`: its id. */
async function ask(
  to: unknown,
  caller: Caller,
  extra: Record<string, unknown> = {},
): Promise<string> {
  return (await ok<{ id: string }>('ask', { to, questions: [QUESTION], ...extra }, caller)).id;
}

/** The text each turn of agent `index`'s sessions was sent. */
const sent = (connector: FakeConnector = appServer) =>
  connector.sessions.flatMap((session) => session.sent.map(({ text }) => text));

/** A gate a fake's turns wait at, between their events, until it opens. */
function gate(): { step: () => Promise<void>; open: () => void } {
  let opened = false;
  const waiting: (() => void)[] = [];
  return {
    step: () =>
      opened
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            waiting.push(resolve);
          }),
    open: () => {
      opened = true;
      for (const resolve of waiting.splice(0)) resolve();
    },
  };
}

describe('a party’s message to you', () => {
  it('is a record to you and a message Needs item yours alone, in its canvas’s scope', async () => {
    expect(scopeOf(SURFACE.message, { canvas: CANVAS, to: { party: 'you' } })).toEqual([
      'app',
      CANVAS,
    ]);
    await keepCanvas();
    await start();
    const { id } = await ok<{ id: string }>(
      'message',
      { to: { party: 'you' }, body: 'The plan is ready.' },
      PLANNER,
    );
    expect(await find(id)).toMatchObject({
      from: 'agent:planner',
      to: 'you',
      kind: 'text',
      state: 'delivered',
      body: 'The plan is ready.',
    });
    expect(await needsOf()).toEqual([
      {
        id: `message/${id}`,
        canvas: CANVAS,
        kind: 'message',
        for: 'you',
        by: ['you'],
        title: 'Message from Planner',
        detail: 'The plan is ready.',
        choices: [{ value: 'dismiss', label: 'Dismiss' }],
        text: { placeholder: 'Reply' },
        answerIn: 'api',
      },
    ]);
    // No token sees it, or answers it: not even its sender.
    expect(await needsOf(PLANNER)).toEqual([]);
    expect(
      await call('reply', { to: `message/${id}`, answer: { choice: 'dismiss' } }, PLANNER),
    ).toMatchObject({ ok: false, error: { code: 'not-found' } });
    // It changes no check and answers nothing: nothing was sent to any agent.
    expect(sent()).toEqual([]);
  });

  it('goes to an agent’s manager, which is you until a lead is granted questions', async () => {
    await keepCanvas();
    await start();
    const { id } = await ok<{ id: string }>(
      'message',
      { to: { party: 'manager' }, body: 'Blocked.' },
      BUILDER,
    );
    expect(await find(id)).toMatchObject({ to: 'you', state: 'delivered' });
    expect((await needsOf()).map(({ id, title }) => [id, title])).toEqual([
      [`message/${id}`, 'Message from Builder to its manager'],
    ]);
  });

  it('refuses a party target from you, and a manager to an outside orchestrator', async () => {
    await keepCanvas();
    await start();
    expect(await call('message', { to: { party: 'you' }, body: 'Hi' }, YOU)).toMatchObject({
      ok: false,
      error: { code: 'invalid' },
    });
    expect(await call('message', { to: { party: 'manager' }, body: 'Hi' }, OUTSIDE)).toMatchObject({
      ok: false,
      error: {
        code: 'invalid',
        sentence: "An outside orchestrator has no manager: name an agent, or { party: 'you' }.",
      },
    });
    // A string is always an agent's id, even "you".
    expect(await call('message', { to: 'you', body: 'Hi' }, OUTSIDE)).toMatchObject({
      ok: false,
      error: { code: 'not-found' },
    });
  });

  it('keeps at most MAX_WAITING open from one party', async () => {
    await keepCanvas();
    await start();
    for (let i = 0; i < MAX_WAITING; i++)
      await ok('message', { to: { party: 'you' }, body: `Note ${String(i)}` }, OUTSIDE);
    expect(await call('message', { to: { party: 'you' }, body: 'One more' }, OUTSIDE)).toEqual({
      ok: false,
      error: {
        code: 'refused',
        sentence: `The user already has ${String(MAX_WAITING)} of your messages open; send another once they dismiss or answer one.`,
      },
    });
    // Another party is not held by it, and a dismissal makes room.
    await ok('message', { to: { party: 'you' }, body: 'Mine' }, PLANNER);
    const [first] = await needsOf();
    await ok('reply', { to: first?.id, answer: { choice: 'dismiss' } }, YOU);
    await ok('message', { to: { party: 'you' }, body: 'One more' }, OUTSIDE);
  });

  it('is dismissed with no record to its sender, and settled once', async () => {
    await keepCanvas();
    await start();
    const { id } = await ok<{ id: string }>(
      'message',
      { to: { party: 'you' }, body: 'FYI' },
      OUTSIDE,
    );
    const before = (await inbox(OUTSIDE)).length;
    expect(
      await ok('reply', { to: `message/${id}`, answer: { choice: 'dismiss' } }, YOU),
    ).toMatchObject({ outcome: 'dismissed' });
    expect(await needsOf()).toEqual([]);
    expect(await find(id)).toMatchObject({ state: 'answered', by: 'you' });
    expect(await inbox(OUTSIDE)).toHaveLength(before);
    expect(
      await call('reply', { to: `message/${id}`, answer: { choice: 'dismiss' } }, YOU),
    ).toEqual({
      ok: false,
      error: {
        code: 'conflict',
        sentence: `message/${id} is settled already: the user dismissed it.`,
      },
    });
  });

  it('is replied to as yours: a turn for an agent, a record for an outside party', async () => {
    await keepCanvas();
    await start();
    const fromAgent = (
      await ok<{ id: string }>('message', { to: { party: 'you' }, body: 'Done?' }, PLANNER)
    ).id;
    const fromOutside = (
      await ok<{ id: string }>('message', { to: { party: 'you' }, body: 'Status?' }, OUTSIDE)
    ).id;
    const toAgent = await ok<{ id: string; outcome: string }>(
      'reply',
      { to: `message/${fromAgent}`, answer: { text: 'Yes, go on.' } },
      YOU,
    );
    expect(toAgent.outcome).toBe('answered');
    // Yours, unframed, as you typed it.
    await vi.waitFor(() => {
      expect(sent()).toEqual(['Yes, go on.']);
    });
    expect(await find(toAgent.id)).toMatchObject({
      from: 'you',
      to: 'agent:planner',
      replyTo: fromAgent,
    });
    const toOutside = await ok<{ id: string }>(
      'reply',
      { to: `message/${fromOutside}`, answer: { text: 'All green.' } },
      YOU,
    );
    expect(await find(toOutside.id, OUTSIDE)).toMatchObject({
      from: 'you',
      to: 'outside:orchestrator',
      body: 'All green.',
      replyTo: fromOutside,
      state: 'delivered',
    });
    expect(await needsOf()).toEqual([]);
  });
});

describe('an ask', () => {
  it('is admitted on disk before it returns, to you a prompt Needs item until its deadline', async () => {
    await keepCanvas();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const now = Date.now();
    await start();
    const id = await ask({ party: 'you' }, PLANNER, { deadlineSeconds: 600 });
    const row = readOnDisk(profile, (disk) =>
      disk.prepare('SELECT kind, state, ask FROM message WHERE id = ?').get(id),
    ) as { kind: string; state: string; ask: string };
    expect(row).toMatchObject({ kind: 'prompt', state: 'delivered' });
    expect(JSON.parse(row.ask)).toEqual({
      v: 1,
      type: 'question',
      questions: [QUESTION],
      deadline: now + 600_000,
    });
    expect(await needsOf()).toEqual([
      {
        id: `ask/${id}`,
        canvas: CANVAS,
        kind: 'prompt',
        for: 'you',
        by: ['you'],
        title: 'Planner asks: Scope',
        until: now + 600_000,
        choices: [
          { value: 'dismiss', label: 'Dismiss', humanOnly: 'Only you dismiss a question to you.' },
        ],
        questions: [QUESTION],
        answerIn: 'api',
      },
    ]);
    // Its asker reads it, the questions too; another agent doesn't.
    expect(await find(id, PLANNER)).toMatchObject({ kind: 'prompt', ask: { type: 'question' } });
    expect(await find(id, BUILDER)).toBeUndefined();
  });

  it('defaults its deadline to a day, and its manager is you, kept so', async () => {
    await keepCanvas();
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = Date.now();
    await start();
    const id = await ask({ party: 'manager' }, BUILDER);
    expect((await find(id))?.ask).toMatchObject({ deadline: now + DAY, via: 'manager' });
    expect((await needsOf()).map(({ id }) => id)).toEqual([`ask/${id}`]);
  });

  it('refuses one asked of no party, of yourself, or by you, and an outside orchestrator’s manager', async () => {
    await keepCanvas();
    await start();
    expect(await call('ask', { to: 'planner', questions: [QUESTION] }, PLANNER)).toMatchObject({
      ok: false,
      error: { code: 'refused' },
    });
    expect(await call('ask', { to: 'stranger', questions: [QUESTION] }, PLANNER)).toMatchObject({
      ok: false,
      error: { code: 'not-found' },
    });
    expect(
      await call('ask', { to: { party: 'manager' }, questions: [QUESTION] }, OUTSIDE),
    ).toMatchObject({ ok: false, error: { code: 'invalid' } });
    expect(await call('ask', { to: { party: 'you' }, questions: [QUESTION] }, YOU)).toMatchObject({
      ok: false,
      error: { code: 'forbidden' },
    });
    expect(
      await call('ask', { to: 'builder', questions: [{ ...QUESTION, secret: true }] }, PLANNER),
    ).toMatchObject({ ok: false, error: { code: 'invalid' } });
  });

  it('keeps one open per asker and recipient, and finds a repeated request again, across a restart', async () => {
    await keepCanvas();
    await start();
    const request = '7d4e5f60-7182-4930-8bad-2e3f4a5b6c01';
    const id = await ask({ party: 'you' }, OUTSIDE, { request });
    expect(await call('ask', { to: { party: 'you' }, questions: [QUESTION] }, OUTSIDE)).toEqual({
      ok: false,
      error: {
        code: 'conflict',
        sentence: `You already have question ${id} open to the user: wait for its answer or its deadline.`,
      },
    });
    // Its manager is you too: the same recipient.
    expect(await ask('builder', OUTSIDE)).not.toBe(id);
    await restart();
    expect(await ask({ party: 'you' }, OUTSIDE, { request })).toBe(id);
    // The same request for another ask is a conflict, never a second ask.
    expect(
      await call(
        'ask',
        { to: { party: 'you' }, questions: [{ ...QUESTION, text: 'Other?' }], request },
        OUTSIDE,
      ),
    ).toMatchObject({ ok: false, error: { code: 'conflict' } });
  });

  it('keeps at most MAX_OPEN_ASKS open on a canvas', async () => {
    await keepCanvas();
    await start();
    const party = (n: number): OutsideCaller => ({
      ...OUTSIDE,
      token: `t${String(n)}`,
      name: `o${String(n)}`,
    });
    for (let n = 0; n < MAX_OPEN_ASKS; n++) await ask({ party: 'you' }, party(n));
    expect(
      await call('ask', { to: { party: 'you' }, questions: [QUESTION] }, party(MAX_OPEN_ASKS)),
    ).toMatchObject({ ok: false, error: { code: 'refused' } });
  });

  it('is answered by you, first answer winning: its row answered value-free, its answer a record for an outside asker', async () => {
    await keepCanvas();
    await start();
    const id = await ask({ party: 'you' }, OUTSIDE);
    const answered = await ok<{ id: string; outcome: string }>(
      'reply',
      { to: `ask/${id}`, answer: { answers: { scope: { text: 'Only the parser' } } } },
      YOU,
    );
    expect(answered.outcome).toBe('answered');
    expect(await find(id)).toMatchObject({
      state: 'answered',
      by: 'you',
      settled: { v: 1, ask: { questions: 1 }, outcome: { type: 'answers', count: 1 } },
    });
    const answer = await find(answered.id, OUTSIDE);
    expect(answer).toMatchObject({
      from: 'you',
      to: 'outside:orchestrator',
      kind: 'text',
      replyTo: id,
      state: 'delivered',
      ask: { v: 1, type: 'answer', of: id, answers: { scope: { text: 'Only the parser' } } },
    });
    expect(answer?.body).toContain('Only the parser');
    // Its settlement says how many, never what.
    expect(JSON.stringify((await find(id))?.settled)).not.toContain('parser');
    expect(await needsOf()).toEqual([]);
    expect(
      await call(
        'reply',
        { to: `ask/${id}`, answer: { answers: { scope: { picked: ['All'] } } } },
        YOU,
      ),
    ).toEqual({
      ok: false,
      error: { code: 'conflict', sentence: `ask/${id} is answered already: the user answered it.` },
    });
  });

  it.each(['a'.repeat(16_330), '🙂'.repeat(4082)])(
    'keeps an ask open until its structured answer fits its rendered message: case %#',
    async (text) => {
      await keepCanvas();
      await start();
      const id = await ask({ party: 'you' }, OUTSIDE);
      expect(
        await call('reply', { to: `ask/${id}`, answer: { answers: { scope: { text } } } }, YOU),
      ).toMatchObject({ ok: false, error: { code: 'refused' } });
      expect((await find(id))?.settled).toBeUndefined();
      expect((await inbox(OUTSIDE)).filter((one) => one.replyTo === id)).toEqual([]);
      const shorter = `${text.slice(0, 8000)}END`;
      const answered = await ok<{ id: string }>(
        'reply',
        { to: `ask/${id}`, answer: { answers: { scope: { text: shorter } } } },
        YOU,
      );
      expect((await find(answered.id, OUTSIDE))?.body).toContain(shorter);
      await restart();
      expect((await find(answered.id, OUTSIDE))?.body).toContain(shorter);
    },
  );

  it('takes an answer to every question, and only labels it offers', async () => {
    await keepCanvas();
    await start();
    const id = await ask({ party: 'you' }, OUTSIDE);
    for (const answers of [{ other: { text: 'x' } }, { scope: { picked: ['None'] } }])
      expect(await call('reply', { to: `ask/${id}`, answer: { answers } }, YOU)).toMatchObject({
        ok: false,
        error: { code: 'invalid' },
      });
    expect(
      await call('reply', { to: `ask/${id}`, answer: { choice: 'allow' } }, YOU),
    ).toMatchObject({ ok: false, error: { code: 'invalid' } });
    expect(await find(id)).toMatchObject({ state: 'delivered' });
    expect(
      await ok(
        'reply',
        { to: `ask/${id}`, answer: { answers: { scope: { picked: ['All'] } } } },
        YOU,
      ),
    ).toMatchObject({ outcome: 'answered' });
  });

  it('is dismissed by you, its asker sent a settled record', async () => {
    await keepCanvas();
    await start();
    const id = await ask({ party: 'you' }, OUTSIDE);
    expect(
      await ok('reply', { to: `ask/${id}`, answer: { choice: 'dismiss' } }, YOU),
    ).toMatchObject({ outcome: 'dismissed' });
    const record = (await inbox(OUTSIDE)).find(
      (message) => message.kind === 'settled' && message.replyTo === id,
    );
    expect(record).toMatchObject({
      from: 'corrallm',
      state: 'delivered',
      settled: { v: 1, ask: { questions: 1 }, outcome: { type: 'dismissed' } },
    });
    expect(await find(id)).toMatchObject({ state: 'answered', by: 'you' });
  });

  it('can’t be taken back', async () => {
    await keepCanvas();
    await start();
    const id = await ask({ party: 'you' }, OUTSIDE);
    expect(await call('withdraw', { id }, OUTSIDE)).toMatchObject({
      ok: false,
      error: { code: 'refused' },
    });
  });

  it('reaches an agent as a framed turn, which answers it in words when it gives no structured answer', async () => {
    await keepCanvas();
    await start();
    const id = await ask('builder', PLANNER);
    await vi.waitFor(async () => {
      expect((await find(id))?.state).toBe('answered');
    });
    const [frame] = sent();
    expect(frame?.split('\n').slice(0, 5)).toEqual([
      `[corrallm] Question from agent "Planner" (an agent, not the user; question ${id}). Answer with the reply tool: reply { to: "ask/${id}", answer: { answers: { "<question id>": { picked: [...] } | { text } } } }, or in your reply text. Its questions, in the asker’s words:`,
      '1. Question id "scope", "Scope" (pick one of its options, or answer in your own words):',
      'How much of it?',
      '  - "All"',
      '  - "Some": Only what changed',
    ]);
    expect(await find(id)).toMatchObject({
      by: 'agent:builder',
      settled: { outcome: { type: 'text' } },
    });
    // Its answer goes to Planner as a turn, framed as Builder's, and makes no reply of its own.
    await vi.waitFor(() => {
      expect(sent()).toHaveLength(2);
    });
    const answer = (await inbox(PLANNER)).find((message) => message.replyTo === id);
    expect(answer).toMatchObject({
      from: 'agent:builder',
      to: 'agent:planner',
      ask: { type: 'answer', of: id },
    });
    expect(sent()[1]).toMatch(
      new RegExp(
        `^\\[corrallm\\] Answer from agent "Builder" \\(an agent, not the user; message ${answer?.id ?? ''}, answering your question ${id}\\):\\n`,
      ),
    );
    await vi.waitFor(async () => {
      expect((await find(answer?.id ?? '', PLANNER))?.state).toBe('replied');
    });
    // Neither the ask's turn nor its answer's made an ordinary reply.
    expect(
      (await inbox(YOU)).filter((message) => message.turn !== undefined && message.kind === 'text'),
    ).toEqual([]);
    expect(await needsOf()).toEqual([]);
  });

  it('is answered by its recipient during its turn, and that turn’s text is never a second answer', async () => {
    await keepCanvas();
    const held = gate();
    const builder = fakeConnector({ adapter: 'codex', step: held.step });
    await start(builder);
    const id = await ask('builder', OUTSIDE);
    await vi.waitFor(() => {
      expect(sent(builder)).toHaveLength(1);
    });
    // Its recipient sees it in Needs, and answers it; another agent can't.
    expect((await needsOf(BUILDER)).map(({ id }) => id)).toEqual([`ask/${id}`]);
    expect(
      await call(
        'reply',
        { to: `ask/${id}`, answer: { answers: { scope: { picked: ['All'] } } } },
        PLANNER,
      ),
    ).toMatchObject({ ok: false, error: { code: 'not-found' } });
    const answered = await ok<{ id: string }>(
      'reply',
      { to: `ask/${id}`, answer: { answers: { scope: { picked: ['All'] } } } },
      BUILDER,
    );
    held.open();
    await vi.waitFor(async () => {
      expect((await find(id))?.state).toBe('answered');
      expect(builder.sessions[0]?.sent).toHaveLength(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const toAsker = (await inbox(OUTSIDE)).filter((message) => message.replyTo === id);
    expect(toAsker.map(({ id }) => id)).toEqual([answered.id]);
    expect(toAsker[0]).toMatchObject({
      from: 'agent:builder',
      state: 'delivered',
      ask: { answers: { scope: { picked: ['All'] } } },
    });
  });

  it('stays open when its turn is cancelled, its asker told once', async () => {
    await keepCanvas();
    const held = gate();
    const builder = fakeConnector({ adapter: 'codex', step: held.step });
    await start(builder);
    const id = await ask('builder', OUTSIDE);
    await vi.waitFor(() => {
      expect(sent(builder)).toHaveLength(1);
    });
    await ok('session.interrupt', { agent: 'builder' }, YOU);
    held.open();
    await vi.waitFor(async () => {
      expect((await find(id))?.state).toBe('replied');
    });
    expect((await find(id))?.settled).toBeUndefined();
    const notices = (await inbox(OUTSIDE)).filter(
      (message) => message.kind === 'notice' && message.replyTo === id,
    );
    expect(notices.map(({ body }) => body)).toEqual([
      `Builder didn’t answer your question ${id}: its turn was cancelled. It stays open for Builder or the user to answer until its deadline.`,
    ]);
    // Still yours or its recipient's to answer.
    expect((await needsOf()).map(({ id }) => id)).toEqual([`ask/${id}`]);
    await ok(
      'reply',
      { to: `ask/${id}`, answer: { answers: { scope: { picked: ['Some'] } } } },
      YOU,
    );
    expect(await find(id)).toMatchObject({ state: 'answered', by: 'you' });
  });

  it('refuses a token’s own words that its agent asker’s connection would run as a shell command', async () => {
    await keepCanvas();
    const held = gate();
    const builder = fakeConnector({ adapter: 'codex', step: held.step });
    await start(builder);
    const id = await ask('builder', agentCaller('shell'));
    await vi.waitFor(() => {
      expect(sent(builder)).toHaveLength(1);
    });
    expect(
      await call(
        'reply',
        { to: `ask/${id}`, answer: { answers: { scope: { text: '!rm -rf .' } } } },
        BUILDER,
      ),
    ).toMatchObject({ ok: false, error: { code: 'refused' } });
    expect((await find(id))?.settled).toBeUndefined();
    await ok(
      'reply',
      { to: `ask/${id}`, answer: { answers: { scope: { text: 'All of it' } } } },
      BUILDER,
    );
    held.open();
  });

  it('frames your answer to an agent as the user’s, never as its own input', async () => {
    await keepCanvas();
    await start();
    const id = await ask({ party: 'you' }, PLANNER);
    const { id: answer } = await ok<{ id: string }>(
      'reply',
      { to: `ask/${id}`, answer: { answers: { scope: { picked: ['All'] } } } },
      YOU,
    );
    await vi.waitFor(() => {
      expect(sent()).toHaveLength(1);
    });
    expect(sent()[0]?.split('\n')[0]).toBe(
      `[corrallm] Answer from the user (the user’s answer, given in corrallm; message ${answer}, answering your question ${id}):`,
    );
  });

  it('expires at its deadline, its asker sent a record, and a late answer is a conflict', async () => {
    await keepCanvas();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    await start();
    const id = await ask({ party: 'you' }, OUTSIDE, { deadlineSeconds: 60 });
    await vi.advanceTimersByTimeAsync(60_001);
    await vi.waitFor(async () => {
      expect((await find(id))?.state).toBe('expired');
    });
    expect((await inbox(OUTSIDE)).find((message) => message.kind === 'settled')).toMatchObject({
      replyTo: id,
      body: `Your question ${id} to the user expired unanswered.`,
      settled: { outcome: { type: 'expired' } },
    });
    expect(await needsOf()).toEqual([]);
    expect(
      await call('reply', { to: `ask/${id}`, answer: { choice: 'dismiss' } }, YOU),
    ).toMatchObject({
      ok: false,
      error: { code: 'conflict', sentence: `ask/${id} expired unanswered.` },
    });
  });

  it.each([{ answers: { scope: { picked: ['All'] } } }, { choice: 'dismiss' }])(
    'honours the wall-clock deadline before its timer runs: %j',
    async (answer) => {
      await keepCanvas();
      await start();
      const id = await ask({ party: 'you' }, OUTSIDE, { deadlineSeconds: 60 });
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 60_000);
      expect(await call('reply', { to: `ask/${id}`, answer }, YOU)).toMatchObject({
        ok: false,
        error: { code: 'conflict', sentence: `ask/${id} expired unanswered.` },
      });
      expect(await find(id)).toMatchObject({ state: 'expired', by: 'corrallm' });
      expect((await inbox(OUTSIDE)).filter((message) => message.replyTo === id)).toMatchObject([
        { kind: 'settled', settled: { outcome: { type: 'expired' } } },
      ]);
    },
  );

  it('expires a turn’s answer at the wall-clock deadline before its timer runs', async () => {
    await keepCanvas();
    const held = gate();
    const builder = fakeConnector({ adapter: 'codex', step: held.step });
    await start(builder);
    const id = await ask('builder', OUTSIDE, { deadlineSeconds: 60 });
    await vi.waitFor(() => {
      expect(sent(builder)).toHaveLength(1);
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 60_000);
    held.open();
    await vi.waitFor(async () => {
      expect((await find(id))?.state).toBe('expired');
    });
    expect((await inbox(OUTSIDE)).filter((message) => message.replyTo === id)).toMatchObject([
      { kind: 'settled', settled: { outcome: { type: 'expired' } } },
    ]);
  });

  it('admits a new ask after the previous deadline before its timer runs', async () => {
    await keepCanvas();
    await start();
    const id = await ask({ party: 'you' }, OUTSIDE, { deadlineSeconds: 60 });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 60_000);
    const next = await ask({ party: 'you' }, OUTSIDE);
    expect(next).not.toBe(id);
    expect((await find(id))?.state).toBe('expired');
    expect((await needsOf()).map(({ id }) => id)).toEqual([`ask/${next}`]);
  });

  it('expires as its canvas opens when its deadline passed while corrallm was down', async () => {
    await keepCanvas();
    await start();
    const id = await ask({ party: 'you' }, OUTSIDE, { deadlineSeconds: 60 });
    await core?.close();
    core = undefined;
    const later = Date.now() + 61_000;
    vi.spyOn(Date, 'now').mockImplementation(() => later);
    await start();
    expect(await find(id)).toMatchObject({ state: 'expired' });
    expect((await inbox(OUTSIDE)).some((message) => message.kind === 'settled')).toBe(true);
  });

  it('is withdrawn when its recipient leaves (its asker told) or its asker leaves (nothing sent)', async () => {
    await keepCanvas();
    const held = gate();
    const builder = fakeConnector({ adapter: 'codex', step: held.step });
    await start(builder);
    // Builder is busy, so Planner's question to it waits.
    await ok('message', { to: 'builder', body: 'Hold on' }, YOU);
    const toBuilder = await ask('builder', OUTSIDE);
    const fromPlanner = await ask({ party: 'you' }, PLANNER);
    await ok('canvas.delete', { nodes: ['builder', 'planner'] }, YOU);
    await vi.waitFor(async () => {
      expect((await find(toBuilder))?.state).toBe('withdrawn');
      expect((await find(fromPlanner))?.state).toBe('withdrawn');
    });
    expect((await find(toBuilder))?.settled).toEqual({
      v: 1,
      ask: { questions: 1 },
      outcome: { type: 'withdrawn', why: 'recipient' },
    });
    expect((await find(fromPlanner))?.settled?.outcome).toEqual({
      type: 'withdrawn',
      why: 'asker',
    });
    expect((await inbox(OUTSIDE)).filter((one) => one.kind === 'settled')).toMatchObject([
      { replyTo: toBuilder, settled: { outcome: { why: 'recipient' } } },
    ]);
    expect(
      (await inbox(YOU)).filter((one) => one.kind === 'settled' && one.replyTo === fromPlanner),
    ).toEqual([]);
    held.open();
  });

  it('is withdrawn, nothing sent, as its canvas closes for good', async () => {
    await keepCanvas();
    await start();
    const id = await ask({ party: 'you' }, OUTSIDE);
    await ok('canvas.close', { discard: true }, YOU);
    await core?.close();
    core = undefined;
    const store = readOnDisk(profile, (disk) =>
      disk.prepare('SELECT state, settled FROM message WHERE id = ?').get(id),
    ) as { state: string; settled: string };
    expect(store.state).toBe('withdrawn');
    expect(JSON.parse(store.settled)).toEqual({
      v: 1,
      ask: { questions: 1 },
      outcome: { type: 'withdrawn', why: 'closed' },
    });
    expect(
      readOnDisk(profile, (disk) =>
        disk.prepare("SELECT count(*) AS n FROM message WHERE kind = 'settled'").get(),
      ),
    ).toEqual({ n: 0 });
  });
});
