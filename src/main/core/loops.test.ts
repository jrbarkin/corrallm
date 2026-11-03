import { legacyDirectories } from './workspaces/test-directories';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LOOP_TURNS } from '../../shared/api/limits';
import type { OpResult } from '../../shared/api/errors';
import type { Message } from '../../shared/model/messages';
import type { NeedsItem } from '../../shared/model/needs';
import { fakeConnector } from '../sessions/test-fake';
import type { FakeConnector } from '../sessions/fake';
import type { AgentCaller, Caller, OutsideCaller } from './caller';
import { createCore } from './core';
import type { Core } from './core';
import { keepCanvases, readOnDisk, refuseWrites } from './store/test-store';
import { CALLERS, CANVAS, NO_DESKTOP } from './test-registry';

/*
 * B21 C6 (Design §9.2 C9), the loop breaker, through core.call: ten delivered turns between two
 * agents without the user, then the eleventh is held before it reaches its session, as a Needs
 * item for you alone; what counts, what resets, what survives a restart, and Go on.
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
/** Planner and Builder are linked; Stranger is linked to nobody. */
const PLANNER = agentCaller('planner');
const BUILDER = agentCaller('builder');
const STRANGER = agentCaller('stranger');

const QUESTION = {
  id: 'scope',
  header: 'Scope',
  text: 'How much of it?',
  options: [{ label: 'All' }, { label: 'Some' }],
  multiple: false,
  other: true,
};
/** The item that holds Builder and Planner, the two ids ordered. */
const HOLD = 'loop/builder/planner';

let profile: string;
let core: Core | undefined;
let appServer: FakeConnector;
let sends = 0;

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-loops-'));
  appServer = fakeConnector({ adapter: 'codex' });
  sends = 0;
});

afterEach(async () => {
  await core?.close();
  core = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  await rm(profile, { recursive: true, force: true });
});

/** A canvas of Planner and Builder, linked, and Stranger, on Codex's App Server. */
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
      nodes: ['planner', 'builder', 'stranger'].map((id, i) => ({
        id,
        kind: 'agent',
        label: id.charAt(0).toUpperCase() + id.slice(1),
        position: { x: 0, y: i * 100 },
        adapter: 'codex',
        connection: 'codex.app-server',
      })),
      links: [{ agents: ['planner', 'builder'] }, { agents: ['stranger', 'builder'] }],
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
        callers: () => true,
        connectors: { 'codex.app-server': connector },
        environment: () => Promise.resolve({}),
      },
    },
    NO_DESKTOP,
  );
  await core.engines.open(CANVAS);
  return core;
}

async function restart(): Promise<Core> {
  await core?.close();
  core = undefined;
  return start();
}

function call(
  name: string,
  args: Record<string, unknown>,
  caller: Caller,
): Promise<OpResult<unknown>> {
  if (core === undefined) throw new Error('No core');
  return core.call(name as never, { canvas: CANVAS, ...args }, caller);
}

async function ok<T = Record<string, unknown>>(
  name: string,
  args: Record<string, unknown>,
  caller: Caller,
): Promise<T> {
  const result = await call(name, args, caller);
  if (!result.ok) throw new Error(`${name} failed: ${JSON.stringify(result)}`);
  return result.value as T;
}

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

async function find(id: string, caller: Caller = YOU): Promise<Message | undefined> {
  return (await inbox(caller)).find((message) => message.id === id);
}

async function needsOf(caller: Caller = YOU): Promise<NeedsItem[]> {
  return (await ok<{ items: NeedsItem[] }>('needs', {}, caller)).items;
}

/** Every text any agent's session was sent. */
const sent = () => appServer.sessions.flatMap((session) => session.sent.map(({ text }) => text));

/** The counts the database keeps, once what is in memory is on disk. */
const pairsOnDisk = () =>
  readOnDisk(profile, (disk) =>
    disk.prepare('SELECT a, b, turns FROM loop_pair ORDER BY a, b').all(),
  );

/**
 * `from` messages agent `to`, whose turn ends and whose reply, a turn back to `from`, ends too:
 * two turns between them. Resolves once both are over.
 */
async function exchange(from: AgentCaller, to: string): Promise<void> {
  sends += 1;
  const { id } = await ok<{ id: string }>(
    'message',
    { to, body: `Exchange ${String(sends)}` },
    from,
  );
  await vi.waitFor(async () => {
    expect((await find(id))?.state).toBe('replied');
    const reply = (await inbox(YOU)).find((one) => one.replyTo === id && one.kind === 'text');
    expect(reply?.state).toBe('replied');
  });
}

/** Passes LOOP_TURNS turns between Planner and Builder, alternating who speaks first. */
async function passTurns(): Promise<void> {
  for (let n = 0; n < LOOP_TURNS / 2; n++)
    await exchange(n % 2 === 0 ? PLANNER : BUILDER, n % 2 === 0 ? 'builder' : 'planner');
  await vi.waitFor(() => {
    expect(pairsOnDisk()).toEqual([{ a: 'builder', b: 'planner', turns: LOOP_TURNS }]);
  });
}

/** The eleventh turn, Planner's message to Builder: held. Its id. */
async function eleventh(): Promise<string> {
  const { id } = await ok<{ id: string }>(
    'message',
    { to: 'builder', body: 'One more thing' },
    PLANNER,
  );
  await vi.waitFor(async () => {
    expect((await needsOf()).map((item) => item.id)).toContain(HOLD);
  });
  return id;
}

/** Whether the message was delivered to its agent. */
const delivered = async (id: string) =>
  !['pending', 'unresolved'].includes((await find(id))?.state ?? 'pending');

describe('ten delivered turns between two agents', () => {
  it('then the eleventh is held before it reaches its session, as a Needs item for you alone', async () => {
    await keepCanvas();
    await start();
    await passTurns();
    expect(sent()).toHaveLength(LOOP_TURNS);
    const held = await eleventh();
    expect(await find(held)).toMatchObject({ state: 'pending', from: 'agent:planner' });
    expect(sent()).toHaveLength(LOOP_TURNS);
    expect((await needsOf()).filter(({ id }) => id.startsWith('loop/'))).toEqual([
      {
        id: HOLD,
        canvas: CANVAS,
        kind: 'hold',
        for: 'you',
        by: ['you'],
        title: 'Builder and Planner have passed 10 turns between them without the user',
        loop: { pair: ['builder', 'planner'], held: [held] },
        choices: [
          {
            value: 'goOn',
            label: 'Go on',
            humanOnly: 'Only you let agents that have gone back and forth go on.',
          },
        ],
        answerIn: 'api',
      },
    ]);
    // Its sender is told once, in a record that is no turn; the turn waits.
    const notices = (await inbox(PLANNER)).filter(
      (one) => one.kind === 'notice' && one.replyTo === held,
    );
    expect(notices.map(({ body }) => body)).toEqual([
      'Your message to Builder is held: 10 turns have passed between you and Builder without the user. It goes once the user lets you go on, or speaks to either of you.',
    ]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sent()).toHaveLength(LOOP_TURNS);
    expect(
      (await inbox(PLANNER)).filter((one) => one.kind === 'notice' && one.replyTo === held),
    ).toHaveLength(1);
  });

  it('holds the other direction too, and every message after it, but no other pair', async () => {
    await keepCanvas();
    await start();
    await passTurns();
    const first = await eleventh();
    const second = (
      await ok<{ id: string }>('message', { to: 'planner', body: 'And back' }, BUILDER)
    ).id;
    // Another pair is independent: Stranger and Builder go on.
    await exchange(STRANGER, 'builder');
    expect(await delivered(first)).toBe(false);
    expect(await delivered(second)).toBe(false);
    // The pair's one item stands for them all.
    expect((await needsOf()).filter(({ id }) => id.startsWith('loop/'))).toHaveLength(1);
    expect((await needsOf()).find(({ id }) => id === HOLD)).toMatchObject({
      loop: { pair: ['builder', 'planner'], held: [first, second] },
    });
    expect(pairsOnDisk()).toEqual([
      { a: 'builder', b: 'planner', turns: LOOP_TURNS },
      { a: 'builder', b: 'stranger', turns: 2 },
    ]);
  });

  it('tells the oldest held turn’s sender once across both directions and a restart', async () => {
    await keepCanvas();
    await start();
    await passTurns();
    const first = await eleventh();
    const second = (
      await ok<{ id: string }>('message', { to: 'planner', body: 'And back' }, BUILDER)
    ).id;
    const notices = async () =>
      (await inbox(YOU))
        .filter(
          (message) => message.kind === 'notice' && [first, second].includes(message.replyTo ?? ''),
        )
        .map(({ to, replyTo }) => ({ to, replyTo }));
    expect(await notices()).toEqual([{ to: 'agent:planner', replyTo: first }]);
    await restart();
    expect(await notices()).toEqual([{ to: 'agent:planner', replyTo: first }]);
    expect((await needsOf()).filter(({ id }) => id.startsWith('loop/'))).toHaveLength(1);
    expect(await delivered(first)).toBe(false);
    expect(await delivered(second)).toBe(false);
  });

  it('is counted from asks, their answers and the settlement of an ask between agents', async () => {
    await keepCanvas();
    await start();
    const id = (await ok<{ id: string }>('ask', { to: 'builder', questions: [QUESTION] }, PLANNER))
      .id;
    // The ask is a turn; Builder's reply text answers it, and that answer is a turn back.
    await vi.waitFor(async () => {
      expect((await find(id))?.state).toBe('answered');
    });
    await vi.waitFor(() => {
      expect(pairsOnDisk()).toEqual([{ a: 'builder', b: 'planner', turns: 2 }]);
    });
  });
});

describe('what is not a turn between two agents', () => {
  it('is nothing from you or from an outside orchestrator, however many', async () => {
    await keepCanvas();
    await start();
    const ids: string[] = [];
    for (let n = 0; n < LOOP_TURNS + 2; n++) {
      ids.push(
        (await ok<{ id: string }>('message', { to: 'builder', body: `Yours ${String(n)}` }, YOU))
          .id,
      );
      ids.push(
        (
          await ok<{ id: string }>(
            'message',
            { to: 'builder', body: `Theirs ${String(n)}` },
            OUTSIDE,
          )
        ).id,
      );
    }
    await vi.waitFor(async () => {
      for (const id of ids) expect((await find(id))?.state).toBe('replied');
    });
    expect((await needsOf()).filter(({ id }) => id.startsWith('loop/'))).toEqual([]);
    expect(pairsOnDisk()).toEqual([]);
  });

  it('is nothing from a repeated request, which finds the first and sends nothing again', async () => {
    await keepCanvas();
    await start();
    const request = '7d4e5f60-7182-4930-8bad-2e3f4a5b6c01';
    const first = await ok<{ id: string }>(
      'ask',
      { to: 'builder', questions: [QUESTION], request },
      PLANNER,
    );
    await vi.waitFor(() => {
      expect(pairsOnDisk()).toEqual([{ a: 'builder', b: 'planner', turns: 2 }]);
    });
    expect(
      await ok<{ id: string }>('ask', { to: 'builder', questions: [QUESTION], request }, PLANNER),
    ).toEqual(first);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(pairsOnDisk()).toEqual([{ a: 'builder', b: 'planner', turns: 2 }]);
  });
});

describe('Go on', () => {
  it('is yours alone: no token sees the hold, or lets the pair go on', async () => {
    await keepCanvas();
    await start();
    await passTurns();
    const held = await eleventh();
    for (const caller of [PLANNER, BUILDER, STRANGER, OUTSIDE]) {
      expect((await needsOf(caller)).map(({ id }) => id)).not.toContain(HOLD);
      expect(await call('reply', { to: HOLD, answer: { choice: 'goOn' } }, caller)).toMatchObject({
        ok: false,
        error: { code: 'not-found' },
      });
    }
    expect(await delivered(held)).toBe(false);
    expect(pairsOnDisk()).toEqual([{ a: 'builder', b: 'planner', turns: LOOP_TURNS }]);
  });

  it('takes nothing but Go on', async () => {
    await keepCanvas();
    await start();
    await passTurns();
    await eleventh();
    for (const answer of [
      { choice: 'dismiss' },
      { text: 'carry on' },
      { choice: 'goOn', text: 'x' },
    ])
      expect(await call('reply', { to: HOLD, answer }, YOU)).toMatchObject({
        ok: false,
        error: { code: 'invalid' },
      });
  });

  it('releases the held message and every one behind it, starts the pair again from zero, once', async () => {
    await keepCanvas();
    await start();
    await passTurns();
    const held = await eleventh();
    const behind = (
      await ok<{ id: string }>('message', { to: 'planner', body: 'And back' }, BUILDER)
    ).id;
    await ok('reply', { to: HOLD, answer: { choice: 'goOn' } }, YOU);
    await vi.waitFor(async () => {
      expect((await find(held))?.state).toBe('replied');
      expect((await find(behind))?.state).toBe('replied');
    });
    expect((await needsOf()).filter(({ id }) => id.startsWith('loop/'))).toEqual([]);
    // Two messages and their two replies since: four turns, not fourteen.
    await vi.waitFor(() => {
      expect(pairsOnDisk()).toEqual([{ a: 'builder', b: 'planner', turns: 4 }]);
    });
    expect(await call('reply', { to: HOLD, answer: { choice: 'goOn' } }, YOU)).toMatchObject({
      ok: false,
      error: { code: 'not-found' },
    });
  });

  it('holds again after ten more turns, and tells its sender again', async () => {
    await keepCanvas();
    await start();
    await passTurns();
    const held = await eleventh();
    await ok('reply', { to: HOLD, answer: { choice: 'goOn' } }, YOU);
    await vi.waitFor(async () => {
      expect((await find(held))?.state).toBe('replied');
    });
    // Two turns are in: four exchanges more make ten, the next is held and told.
    for (let n = 0; n < 4; n++) await exchange(PLANNER, 'builder');
    const again = await eleventh();
    expect(
      (await inbox(PLANNER)).filter((one) => one.kind === 'notice' && one.replyTo === again),
    ).toHaveLength(1);
  });
});

describe('what resets a pair', () => {
  /** Holds Planner's message to Builder; runs `input`; the message goes, and its pair is counting again. */
  async function resetBy(input: () => Promise<unknown>): Promise<void> {
    await keepCanvas();
    await start();
    await passTurns();
    const held = await eleventh();
    await input();
    await vi.waitFor(async () => {
      expect((await find(held))?.state).toBe('replied');
    });
    expect((await needsOf()).filter(({ id }) => id.startsWith('loop/'))).toEqual([]);
  }

  it('is your message to either of the pair', async () => {
    await resetBy(() => ok('message', { to: 'builder', body: 'Carry on' }, YOU));
  });

  it('is your message to the sender of the held turn too', async () => {
    await resetBy(() => ok('message', { to: 'planner', body: 'Carry on' }, YOU));
  });

  it('is your answer to an ask of either', async () => {
    await resetBy(async () => {
      const ask = await ok<{ id: string }>(
        'ask',
        { to: { party: 'you' }, questions: [QUESTION] },
        PLANNER,
      );
      await ok(
        'reply',
        { to: `ask/${ask.id}`, answer: { answers: { scope: { picked: ['All'] } } } },
        YOU,
      );
    });
  });

  it('is your dismissal of an ask of either', async () => {
    await resetBy(async () => {
      const ask = await ok<{ id: string }>(
        'ask',
        { to: { party: 'you' }, questions: [QUESTION] },
        BUILDER,
      );
      await ok('reply', { to: `ask/${ask.id}`, answer: { choice: 'dismiss' } }, YOU);
    });
  });

  it('is your dismissal of a message of either to you', async () => {
    await resetBy(async () => {
      const note = await ok<{ id: string }>(
        'message',
        { to: { party: 'you' }, body: 'FYI' },
        PLANNER,
      );
      await ok('reply', { to: `message/${note.id}`, answer: { choice: 'dismiss' } }, YOU);
    });
  });

  it('is your reply to a message of either to you', async () => {
    await resetBy(async () => {
      const note = await ok<{ id: string }>(
        'message',
        { to: { party: 'you' }, body: 'Done?' },
        BUILDER,
      );
      await ok('reply', { to: `message/${note.id}`, answer: { text: 'Yes' } }, YOU);
    });
  });

  it('is nothing an agent, an outside orchestrator or a token does', async () => {
    await keepCanvas();
    await start();
    await passTurns();
    const held = await eleventh();
    // An outside orchestrator speaks to both, and a stranger asks Builder.
    await ok('message', { to: 'builder', body: 'Hello from outside' }, OUTSIDE);
    await ok('message', { to: 'planner', body: 'Hello from outside' }, OUTSIDE);
    await ok('ask', { to: 'builder', questions: [QUESTION] }, STRANGER);
    await vi.waitFor(() => {
      expect(sent().length).toBeGreaterThan(LOOP_TURNS);
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await delivered(held)).toBe(false);
    expect((await needsOf()).map(({ id }) => id)).toContain(HOLD);
  });
});

describe('the counts and the hold across a restart and a failed write', () => {
  it('survive a restart: the pair is still held, the message still pending, its sender not told again', async () => {
    await keepCanvas();
    await start();
    await passTurns();
    const held = await eleventh();
    await restart();
    expect((await needsOf()).map(({ id }) => id)).toContain(HOLD);
    expect(await find(held)).toMatchObject({ state: 'pending' });
    expect(pairsOnDisk()).toEqual([{ a: 'builder', b: 'planner', turns: LOOP_TURNS }]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(
      (await inbox(PLANNER)).filter((one) => one.kind === 'notice' && one.replyTo === held),
    ).toHaveLength(1);
    await ok('reply', { to: HOLD, answer: { choice: 'goOn' } }, YOU);
    await vi.waitFor(async () => {
      expect((await find(held))?.state).toBe('replied');
    });
  });

  it('are written with the turn they count: a turn whose journal is refused is never sent, nor counted', async () => {
    await keepCanvas();
    await start();
    const release = refuseWrites(profile, 'loop_pair', 'The disk is full.');
    const { id } = await ok<{ id: string }>('message', { to: 'builder', body: 'Hello' }, PLANNER);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(sent()).toEqual([]);
    expect(await find(id)).toMatchObject({ state: 'pending' });
    release();
    // It is tried again, and counted once however many times it was tried: itself and its reply.
    await vi.waitFor(
      async () => {
        expect((await find(id))?.state).toBe('replied');
      },
      { timeout: 5000 },
    );
    await vi.waitFor(() => {
      expect(pairsOnDisk()).toEqual([{ a: 'builder', b: 'planner', turns: 2 }]);
    });
  });

  it('hold the end of an ask between the pair that expired while corrallm was down, and tell the agent whose turn waits behind it', async () => {
    await keepCanvas();
    await start();
    await passTurns();
    const { id: asked } = await ok<{ id: string }>(
      'ask',
      { to: 'builder', questions: [QUESTION], deadlineSeconds: 60 },
      PLANNER,
    );
    await vi.waitFor(async () => {
      expect((await needsOf()).map((item) => item.id)).toContain(HOLD);
    });
    // Its deadline passes while corrallm is down: it expires as the canvas opens again.
    const now = Date.now.bind(Date);
    vi.spyOn(Date, 'now').mockImplementation(() => now() + 61_000);
    await restart();
    const ended = (await inbox(PLANNER)).find(
      (one) => one.kind === 'settled' && one.replyTo === asked,
    );
    expect(ended).toMatchObject({ from: 'corrallm', to: 'agent:planner', state: 'pending' });
    expect((await needsOf()).map((item) => item.id)).toContain(HOLD);
    expect((await needsOf()).find(({ id }) => id === HOLD)).toMatchObject({
      loop: { pair: ['builder', 'planner'], held: [ended?.id] },
    });
    // Builder's turn behind it waits with its pair, and Builder is told so, once.
    const { id: behind } = await ok<{ id: string }>(
      'message',
      { to: 'planner', body: 'Still there?' },
      BUILDER,
    );
    await vi.waitFor(async () => {
      expect(
        (await inbox(BUILDER)).filter((one) => one.kind === 'notice' && one.replyTo === behind),
      ).toHaveLength(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sent()).toHaveLength(LOOP_TURNS);
    // Go on: the ask's end goes first, as a turn between the pair, then Builder's and its reply.
    await ok('reply', { to: HOLD, answer: { choice: 'goOn' } }, YOU);
    await vi.waitFor(async () => {
      expect((await find(ended?.id ?? ''))?.state).toBe('replied');
      expect((await find(behind))?.state).toBe('replied');
    });
    await vi.waitFor(() => {
      expect(pairsOnDisk()).toEqual([{ a: 'builder', b: 'planner', turns: 3 }]);
    });
  });

  it('hold a pair whose item id would be too long for the API, with no item, until you speak to either', async () => {
    const [one, two] = ['あ'.repeat(256), 'い'.repeat(256)] as const;
    const project = path.join(profile, 'project');
    await mkdir(project);
    const file = path.join(profile, 'canvas.corral');
    await writeFile(
      file,
      JSON.stringify({
        format: 'corrallm',
        version: 2,
        id: CANVAS,
        nodes: [one, two].map((id, i) => ({
          id,
          kind: 'agent',
          label: `Agent ${String(i + 1)}`,
          position: { x: 0, y: i * 100 },
          adapter: 'codex',
          connection: 'codex.app-server',
        })),
        links: [{ agents: [one, two] }],
      }),
    );
    await keepCanvases(profile, { [CANVAS]: { file, project } });
    await start();
    const first = agentCaller(one);
    const second = agentCaller(two);
    for (let n = 0; n < LOOP_TURNS / 2; n++)
      await exchange(n % 2 === 0 ? first : second, n % 2 === 0 ? two : one);
    const { id } = await ok<{ id: string }>('message', { to: two, body: 'Again' }, first);
    await vi.waitFor(async () => {
      expect(
        (await inbox(first)).filter((note) => note.kind === 'notice' && note.replyTo === id),
      ).toHaveLength(1);
    });
    expect(sent()).toHaveLength(LOOP_TURNS);
    expect((await needsOf()).filter((item) => item.id.startsWith('loop/'))).toEqual([]);
    expect(await find(id)).toMatchObject({ state: 'pending' });
    await ok('message', { to: one, body: 'Carry on' }, YOU);
    await vi.waitFor(async () => {
      expect((await find(id))?.state).toBe('replied');
    });
  });

  it('count nothing for a turn taken back as its journal is refused: it was never sent', async () => {
    await keepCanvas();
    await start();
    const open = core?.engines.canvas(CANVAS);
    if (open === undefined) throw new Error('The canvas is not open.');
    const release = refuseWrites(profile, 'loop_pair', 'The disk is full.');
    const { id } = await ok<{ id: string }>('message', { to: 'builder', body: 'Hello' }, PLANNER);
    // Its sender takes it back while its delivering record is still on its way to the disk.
    expect(open.messages.get(id)?.state).toBe('delivering');
    await open.delivery.withdraw(id, 'agent:planner').catch(() => undefined);
    release();
    await open.messages.durable();
    expect(open.messages.get(id)?.state).toBe('withdrawn');
    expect(sent()).toEqual([]);
    expect(open.loops.turns('planner', 'builder')).toBe(0);
    expect(pairsOnDisk()).toEqual([]);
  });

  it('journals an unsent withdrawal with no turn counted while session readiness waits', async () => {
    await keepCanvas();
    await start();
    const open = core?.engines.canvas(CANVAS);
    if (open === undefined) throw new Error('The canvas is not open.');
    let release: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = open.engine.sessions.ready.bind(open.engine.sessions);
    vi.spyOn(open.engine.sessions, 'ready').mockImplementation(async (agent) => {
      await ready;
      return original(agent);
    });
    try {
      const { id } = await ok<{ id: string }>(
        'message',
        { to: 'builder', body: 'A turn waiting for startup' },
        PLANNER,
      );
      expect(open.messages.get(id)?.state).toBe('delivering');
      await open.delivery.withdraw(id, 'agent:planner');
      expect(open.messages.get(id)?.state).toBe('withdrawn');
      expect(sent()).toEqual([]);
      expect(pairsOnDisk()).toEqual([]);
      expect(open.loops.turns('planner', 'builder')).toBe(0);
    } finally {
      release();
    }
  });

  it('go with an agent that leaves the canvas', async () => {
    await keepCanvas();
    await start();
    await exchange(PLANNER, 'builder');
    await vi.waitFor(() => {
      expect(pairsOnDisk()).toEqual([{ a: 'builder', b: 'planner', turns: 2 }]);
    });
    await ok('canvas.delete', { nodes: ['builder'] }, YOU);
    await vi.waitFor(() => {
      expect(pairsOnDisk()).toEqual([]);
    });
  });
});
