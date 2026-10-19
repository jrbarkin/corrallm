import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_MESSAGE_BYTES, MAX_PAGE_BYTES, MAX_WAITING } from '../../shared/api/limits';
import type { Message } from '../../shared/model/messages';
import { withoutChoices } from '../../shared/engine/needs';
import type { NeedsItem } from '../../shared/model/needs';
import type { CanvasId } from '../../shared/canvas';
import type { SessionEvent, SessionMode } from '../../shared/session';
import { callTool } from '../api/mcp';
import type { Connector, SessionHost } from '../sessions/connector';
import { FakeConnector } from '../sessions/fake';
import type { AgentCaller, Caller, OutsideCaller } from './caller';
import { createCore } from './core';
import type { Core } from './core';
import { CALLERS, CANVAS, NO_DESKTOP } from './test-registry';

/*
 * Messages in the core (Build Plan B6): what parties send agents, delivered when the agent is idle
 * and nothing holds it, framed, with the reply coming back to its sender, all through core.call.
 */

const OUTSIDE = CALLERS['outside-write'] as OutsideCaller;
const READER = CALLERS['outside-read'] as OutsideCaller;
/** Another outside orchestrator, writing to the same canvas. */
const OTHER: OutsideCaller = { ...OUTSIDE, token: 'other-token', name: 'other' };
const YOU = CALLERS.you;
/** Builder, calling as itself (a worker: it reaches Helper and Checker, which are linked to it). */
const BUILDER: AgentCaller = {
  kind: 'agent',
  canvas: CANVAS,
  agent: 'builder',
  session: 'builder-session',
};
/** Shell, calling as itself: linked to nobody. */
const SHELL: AgentCaller = {
  kind: 'agent',
  canvas: CANVAS,
  agent: 'shell',
  session: 'shell-session',
};

interface AgentSpec {
  id: string;
  label: string;
  connection: string;
  settings?: Record<string, unknown>;
  queue?: unknown[];
  /** The group it is in. */
  parent?: string;
}

/** Builder, on Codex's App Server. */
const BUILDER_AGENT: AgentSpec = {
  id: 'builder',
  label: 'Builder',
  connection: 'codex.app-server',
};
/**
 * Builder, Helper and Checker run on Codex's App Server (Checker in Read only, so it asks before
 * acting); Shell on Codex's Terminal.
 */
const AGENTS: AgentSpec[] = [
  BUILDER_AGENT,
  { id: 'helper', label: 'Helper', connection: 'codex.app-server' },
  {
    id: 'checker',
    label: 'Checker',
    connection: 'codex.app-server',
    settings: { codex: { mode: 'read-only' } },
  },
  { id: 'shell', label: 'Shell', connection: 'codex.terminal' },
];
const LINKS = [
  ['builder', 'helper'],
  ['builder', 'checker'],
];

let profile: string;
let project: string;
let core: Core | undefined;
let appServer: FakeConnector;
let terminal: FakeConnector;

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-delivery-'));
  project = path.join(profile, 'project');
  await mkdir(project);
  appServer = new FakeConnector({ adapter: 'codex' });
  terminal = new FakeConnector({ adapter: 'codex' });
});

afterEach(async () => {
  await core?.close();
  core = undefined;
  vi.restoreAllMocks();
  await rm(profile, { recursive: true, force: true });
});

const realNow = Date.now.bind(Date);
/** Runs the clock everything here reads (Date.now) `ms` ahead of the real one, from now on. */
function ahead(ms: number): void {
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + ms);
}

/**
 * A profile keeping a canvas of `agents` (and `groups` of them), as the app would once its folder
 * was picked.
 */
async function keepCanvas(
  agents = AGENTS,
  links = LINKS,
  groups: { id: string; label: string }[] = [],
): Promise<void> {
  const file = path.join(profile, 'canvas.corral');
  await writeFile(
    file,
    JSON.stringify({
      format: 'corrallm',
      version: 2,
      id: CANVAS,
      nodes: [
        ...groups.map(({ id, label }) => ({ id, kind: 'group', label, position: { x: 0, y: 0 } })),
        ...agents.map(({ id, label, connection, settings, queue, parent }, i) => ({
          id,
          kind: 'agent',
          label,
          position: { x: 0, y: i * 100 },
          adapter: 'codex',
          connection,
          ...(settings ? { settings } : {}),
          ...(queue ? { queue } : {}),
          ...(parent === undefined ? {} : { parent }),
        })),
      ],
      links: links.map((agents) => ({ agents })),
    }),
  );
  await writeFile(
    path.join(profile, 'canvases.json'),
    JSON.stringify({ version: 2, canvases: { [CANVAS]: { file, project, conversations: {} } } }),
  );
}

/** Starts the core over the profile, its App Server and Terminal agents on the given connectors. */
async function start(
  connectors: { appServer?: Connector<SessionMode>; terminal?: Connector<SessionMode> } = {},
): Promise<Core> {
  core = await createCore(
    {
      profile,
      app: { name: 'corrallm', version: '9.8.7' },
      check: true,
      distribution: 'local',
      locale: 'en-GB',
      sessions: {
        connectors: {
          'codex.app-server': connectors.appServer ?? appServer,
          'codex.terminal': connectors.terminal ?? terminal,
        },
        environment: () => Promise.resolve({}),
      },
    },
    NO_DESKTOP,
  );
  await core.engines.open(CANVAS);
  return core;
}

async function restart(connectors?: Parameters<typeof start>[0]): Promise<Core> {
  await core?.close();
  core = undefined;
  return start(connectors);
}

/** Calls `name` as `caller`, expecting it to work: its result. */
async function ok<T = Record<string, unknown>>(
  name: string,
  args: Record<string, unknown>,
  caller: Caller = OUTSIDE,
): Promise<T> {
  const result = await core?.call(name as never, { canvas: CANVAS, ...args }, caller);
  if (!result?.ok) throw new Error(`${name} failed: ${JSON.stringify(result)}`);
  return result.value;
}

/** What `caller` may read of the canvas's messages, oldest first. */
async function inbox(caller: Caller = OUTSIDE): Promise<Message[]> {
  const all: Message[] = [];
  let after: string | undefined;
  for (let pages = 0; pages < 100; pages++) {
    const page: { items: Message[]; next: string } = await ok(
      'messages',
      after === undefined ? {} : { after },
      caller,
    );
    if (page.items.length === 0) return all;
    all.push(...page.items);
    after = page.next;
  }
  throw new Error('The messages never end: a page doesn’t read on from its cursor.');
}

/** A message `caller` sent, as it is now. */
async function find(id: string, caller: Caller = OUTSIDE): Promise<Message | undefined> {
  return (await inbox(caller)).find((message) => message.id === id);
}

/** What `caller` sends `to`: its id. */
async function send(to: string, body: string, caller: Caller = OUTSIDE): Promise<string> {
  return (await ok<{ id: string }>('message', { to, body }, caller)).id;
}

/** The notices `caller` was sent. */
async function notices(caller: Caller = OUTSIDE): Promise<Message[]> {
  return (await inbox(caller)).filter((message) => message.kind === 'notice');
}

/** The text the agent's session was sent, each turn. */
function sent(connector: FakeConnector): string[] {
  return connector.sessions.flatMap((session) => session.sent.map(({ text }) => text));
}

/** A connector whose sessions won't start: it says why (`text`), as a login it can't run on does. */
const refusing = (text = 'This login can’t run here.'): Connector<SessionMode> => ({
  start: (_spec, host) => {
    host.emit({
      type: 'notice',
      id: crypto.randomUUID(),
      level: 'error',
      text,
      switchTo: 'codex.terminal',
    });
    return Promise.reject(new Error(text));
  },
});
const REFUSING = refusing();

const FRAME = (id: string) =>
  `[corrallm] Message from "orchestrator" (an orchestrator outside corrallm, not the user; message ${id}):\n`;

describe('delivery', () => {
  it('delivers a message to an idle agent with no run going, framed, and its reply comes back once', async () => {
    await keepCanvas();
    await start();
    const id = await send('builder', 'Say hello');
    await vi.waitFor(async () => {
      expect((await find(id))?.state).toBe('replied');
    });
    // Framed: the agent is told who it is from, and that it isn't the user.
    expect(sent(appServer)).toEqual([`${FRAME(id)}Say hello`]);
    const replies = (await inbox()).filter((message) => message.replyTo === id);
    expect(replies).toEqual([
      expect.objectContaining({
        from: 'agent:builder',
        to: 'outside:orchestrator',
        kind: 'text',
        body: `You said: ${FRAME(id)}Say hello`,
        turn: { status: 'completed', reason: 'completed' },
        state: 'delivered',
      }),
    ]);
    expect(await find(id)).toMatchObject({
      from: 'outside:orchestrator',
      to: 'agent:builder',
      delivery: { attempt: 1 },
    });
  });

  it('holds a paused agent’s messages until it is unpaused, but never yours', async () => {
    await keepCanvas();
    await start();
    await ok('run.pause', { target: { agent: 'builder' } }, YOU);
    const id = await send('builder', 'Say hello');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await find(id))?.state).toBe('pending');
    expect(appServer.started).toEqual([]);
    // What you send goes past the pause; the party's message still waits.
    const yours = await send('builder', 'From you', YOU);
    await vi.waitFor(async () => {
      expect((await find(yours, YOU))?.state).toBe('replied');
    });
    expect((await find(id))?.state).toBe('pending');

    await ok('run.unpause', { target: { agent: 'builder' } }, YOU);
    await vi.waitFor(async () => {
      expect((await find(id))?.state).toBe('replied');
    });
  });

  it('delivers parties’ messages to the idle agents of a run restored paused', async () => {
    await keepCanvas([
      { ...BUILDER_AGENT, queue: [{ id: 'hello', message: 'Say hello' }] },
      ...AGENTS.slice(1),
    ]);
    const engine = await (await start()).engines.open(CANVAS);
    engine.run.start();
    await vi.waitFor(() => {
      expect(engine.run.snapshot().agents.builder?.status).toBe('done');
    });
    const restored = await (await restart()).engines.open(CANVAS);
    expect(restored.run.snapshot()).toMatchObject({ running: false, paused: true });

    const id = await send('builder', 'And again');
    await vi.waitFor(async () => {
      expect((await find(id))?.state).toBe('replied');
    });
  });

  it('holds only the run’s own sends after a whole-run Stop', async () => {
    await keepCanvas([
      { ...BUILDER_AGENT, queue: [{ id: 'hello', message: 'From the queue' }] },
      ...AGENTS.slice(1),
    ]);
    const engine = await (await start()).engines.open(CANVAS);
    engine.run.start();
    engine.run.stop();
    const id = await send('builder', 'From a party');
    await vi.waitFor(async () => {
      expect((await find(id))?.state).toBe('replied');
    });
    expect(sent(appServer)).toEqual([`${FRAME(id)}From a party`]);
  });

  it('keeps a message an agent’s session refused first in line, and tells its sender once', async () => {
    await keepCanvas();
    let refuse = true;
    await start({
      appServer: {
        start: (spec, host) => (refuse ? REFUSING : appServer).start(spec, host),
      },
    });
    const first = await send('builder', 'First');
    await vi.waitFor(async () => {
      expect((await inbox()).filter((message) => message.kind === 'notice')).toHaveLength(1);
    });
    const second = await send('builder', 'Second');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const messages = await inbox();
    expect(messages.find(({ id }) => id === first)?.state).toBe('pending');
    expect(messages.find(({ id }) => id === second)?.state).toBe('pending');
    expect(messages.filter((message) => message.kind === 'notice')).toEqual([
      expect.objectContaining({
        from: 'corrallm',
        to: 'outside:orchestrator',
        replyTo: first,
        body: expect.stringMatching(
          /^Builder can’t start, so your message waits: This login/,
        ) as string,
      }),
    ]);

    // Once it can start, the first goes first.
    refuse = false;
    await restart({ appServer });
    await vi.waitFor(async () => {
      expect((await find(second))?.state).toBe('replied');
    });
    expect(sent(appServer)).toEqual([`${FRAME(first)}First`, `${FRAME(second)}Second`]);
  });

  it('tells each party whose message waits on a session that won’t start, once', async () => {
    await keepCanvas();
    await start({ appServer: REFUSING });
    const first = await send('helper', 'First');
    await vi.waitFor(async () => {
      expect(await notices()).toHaveLength(1);
    });
    const others = await send('helper', 'From another orchestrator', OTHER);
    const builders = await send('helper', 'From Builder', BUILDER);
    await send('helper', 'Again');
    await new Promise((resolve) => setTimeout(resolve, 50));
    for (const [caller, id] of [
      [OUTSIDE, first],
      [OTHER, others],
      [BUILDER, builders],
    ] as const) {
      expect(await notices(caller)).toEqual([
        expect.objectContaining({
          from: 'corrallm',
          replyTo: id,
          body: expect.stringMatching(
            /^Helper can’t start, so your message waits: This login/,
          ) as string,
        }),
      ]);
    }
  });

  it('says what lets a session that wouldn’t start go, in its sender’s notice and in Needs you', async () => {
    await keepCanvas();
    await start({ appServer: REFUSING });
    await send('builder', 'First');
    await vi.waitFor(async () => {
      expect(await notices()).toHaveLength(1);
    });
    const clears =
      'It tries to start again with the next message sent to it a minute or more after it refused, or once it is switched to another connection in the corrallm app.';
    expect((await notices())[0]?.body).toBe(
      `Builder can’t start, so your message waits: This login can’t run here. ${clears}`,
    );
    expect((await ok<{ items: NeedsItem[] }>('needs', {}, YOU)).items).toEqual([
      expect.objectContaining({
        id: 'start/builder',
        title: 'Builder can’t start: This login can’t run here.',
        detail: `Messages to it wait until it can. ${clears}`,
      }),
    ]);
  });

  it('tries a session that wouldn’t start again with the next message sent a minute or more on', async () => {
    await keepCanvas();
    let refuse = true;
    let starts = 0;
    await start({
      appServer: {
        start: (spec, host) => {
          starts += 1;
          return (refuse ? REFUSING : appServer).start(spec, host);
        },
      },
    });
    const first = await send('builder', 'First');
    await vi.waitFor(async () => {
      expect(await notices()).toHaveLength(1);
    });
    // Within the minute, a message waits with the rest, and tries nothing.
    const second = await send('builder', 'Second');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(starts).toBe(1);

    // A minute on, the next one tries again: refused, everything still waits, no one told twice.
    ahead(60_000);
    const third = await send('builder', 'Third');
    await vi.waitFor(() => {
      expect(starts).toBe(2);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const texts = async () => (await inbox()).filter((message) => message.kind === 'text');
    expect((await texts()).map(({ state }) => state)).toEqual(['pending', 'pending', 'pending']);
    expect(await notices()).toHaveLength(1);

    // Once what it refused over is fixed, the next one a minute on starts it, and all go in order.
    refuse = false;
    ahead(120_000);
    const fourth = await send('builder', 'Fourth');
    await vi.waitFor(async () => {
      expect((await find(fourth))?.state).toBe('replied');
    });
    expect(sent(appServer)).toEqual([
      `${FRAME(first)}First`,
      `${FRAME(second)}Second`,
      `${FRAME(third)}Third`,
      `${FRAME(fourth)}Fourth`,
    ]);
    expect(starts).toBe(3);
  });

  it('quotes a long name, and a long reason a session won’t start, cut short', async () => {
    await keepCanvas([{ ...BUILDER_AGENT, label: `Builder ${'x'.repeat(MAX_MESSAGE_BYTES)}` }], []);
    await start({
      appServer: refusing(`This login can’t run here: ${'because '.repeat(MAX_MESSAGE_BYTES / 8)}`),
    });
    await send('builder', 'First');
    await vi.waitFor(async () => {
      expect(await notices()).toHaveLength(1);
    });
    const [notice] = await notices();
    expect(notice?.body).toMatch(
      /^Builder x+… can’t start, so your message waits: This login can’t run here: (because )*because…/,
    );
    expect(new TextEncoder().encode(notice?.body).length).toBeLessThan(MAX_MESSAGE_BYTES / 8);
  });

  it('refuses a body over 16 KB, counted in bytes', async () => {
    await keepCanvas();
    await start();
    expect(
      await core?.call(
        'message',
        { canvas: CANVAS, to: 'builder', body: 'é'.repeat(MAX_MESSAGE_BYTES / 2 + 1) },
        OUTSIDE,
      ),
    ).toMatchObject({ ok: false, error: { code: 'invalid' } });
    // The most a message holds goes; its echoed reply, longer, comes back cut to it, and marked,
    // never in the middle of a character (each "é" is two bytes, and the cut falls inside one).
    for (const body of ['x'.repeat(MAX_MESSAGE_BYTES), 'é'.repeat(MAX_MESSAGE_BYTES / 2)]) {
      const id = await send('builder', body);
      await vi.waitFor(async () => {
        expect((await find(id))?.state).toBe('replied');
      });
      const reply = (await inbox()).find((message) => message.replyTo === id);
      expect(new TextEncoder().encode(reply?.body).length).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
      expect(reply?.body).toMatch(
        /(x|é)\n\n\[corrallm: cut here; the whole reply is in its transcript\]$/u,
      );
      expect(reply?.body).not.toContain('\uFFFD');
    }
  });

  it('refuses a party more messages waiting for one agent than it may have, never yours', async () => {
    await keepCanvas();
    await start();
    await ok('run.pause', { target: { agent: 'builder' } }, YOU);
    for (let i = 0; i < MAX_WAITING; i++) await send('builder', `Message ${String(i)}`);
    expect(
      await core?.call('message', { canvas: CANVAS, to: 'builder', body: 'One more' }, OUTSIDE),
    ).toEqual({
      ok: false,
      error: {
        code: 'refused',
        sentence: `Builder already has ${String(MAX_WAITING)} of your messages waiting; send another once one of them goes.`,
      },
    });
    // Another party's, another agent's and yours still go.
    await send('builder', 'From another', OTHER);
    await send('helper', 'To Helper');
    await send('builder', 'From you', YOU);
    // Once one goes, another may.
    const [first] = (await inbox()).filter(({ to }) => to === 'agent:builder');
    await ok('withdraw', { id: first?.id });
    await send('builder', 'One more');
  });

  it('withdraws a message before it is delivered, and interrupts its turn after', async () => {
    await keepCanvas();
    await start();
    await ok('run.pause', { target: { agent: 'builder' } }, YOU);
    const waiting = await send('builder', 'Never mind');
    await ok('withdraw', { id: waiting });
    expect(await find(waiting)).toMatchObject({ state: 'withdrawn', by: 'outside:orchestrator' });
    await ok('run.unpause', { target: { agent: 'builder' } }, YOU);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(appServer.started).toEqual([]);

    // A slow turn: withdrawn once delivered, it is interrupted.
    await restart({ appServer: new FakeConnector({ adapter: 'codex', pause: 200 }) });
    const going = await send('builder', 'Take your time');
    await vi.waitFor(async () => {
      expect((await find(going))?.state).toBe('delivered');
    });
    await ok('withdraw', { id: going });
    await vi.waitFor(async () => {
      expect((await find(going))?.state).toBe('withdrawn');
    });
    expect((await inbox()).filter((message) => message.replyTo === going)).toEqual([]);
    // Its turn ended interrupted, not run to its end.
    const builder = core?.engines.canvas(CANVAS)?.engine.sessions.of('builder');
    expect(builder?.entries.findLast((entry) => entry.kind === 'end')).toMatchObject({
      interrupted: true,
    });
    // A party names only its own messages.
    const builders = await send('helper', 'Hello', BUILDER);
    expect(await core?.call('withdraw', { canvas: CANVAS, id: builders }, OUTSIDE)).toMatchObject({
      ok: false,
      error: { code: 'not-found' },
    });
  });

  it('holds a party’s message while its agent runs in a mode that never asks, telling its sender and you', async () => {
    await keepCanvas();
    const engine = await (await start()).engines.open(CANVAS);
    const started = await send('builder', 'Start', YOU);
    await vi.waitFor(async () => {
      expect((await find(started, YOU))?.state).toBe('replied');
    });
    engine.sessions.setMode('builder', 'full-access');
    await vi.waitFor(() => {
      expect(engine.sessions.of('builder').mode).toBe('full-access');
    });
    const first = await send('builder', 'First');
    const second = await send('builder', 'Second');
    // Yours go: you are its user.
    const yours = await send('builder', 'From you', YOU);
    await vi.waitFor(async () => {
      expect((await find(yours, YOU))?.state).toBe('replied');
    });
    expect((await find(first))?.state).toBe('pending');
    const waits =
      'Builder runs in a mode that never asks before it acts, so your message waits until it runs in one that asks again: only you can switch it.';
    expect(await notices()).toEqual([expect.objectContaining({ replyTo: first, body: waits })]);
    expect((await ok<{ items: NeedsItem[] }>('needs', {}, YOU)).items).toEqual([
      expect.objectContaining({
        id: 'unasking/builder',
        kind: 'hold',
        title: 'Builder runs without asking, so messages from other parties wait',
        detail: 'They go once it runs in a mode that asks again, or its session ends.',
        choices: [],
      }),
    ]);

    // Back in a mode that asks, they go, in order; in one that never asks again, its sender is told
    // again.
    engine.sessions.setMode('builder', 'auto');
    await vi.waitFor(async () => {
      expect((await find(second))?.state).toBe('replied');
    });
    expect(sent(appServer).slice(-2)).toEqual([`${FRAME(first)}First`, `${FRAME(second)}Second`]);
    expect((await ok<{ items: NeedsItem[] }>('needs', {}, YOU)).items).toEqual([]);
    engine.sessions.setMode('builder', 'full-access');
    await vi.waitFor(() => {
      expect(engine.sessions.of('builder').mode).toBe('full-access');
    });
    const third = await send('builder', 'Third');
    await vi.waitFor(async () => {
      expect((await notices()).map(({ replyTo }) => replyTo)).toEqual([first, third]);
    });
  });

  it('delivers a party’s message to an agent whose session ended in a mode that never asks', async () => {
    await keepCanvas();
    let host: SessionHost | undefined;
    const engine = await (
      await start({
        appServer: {
          start: (spec, given) => {
            host = given;
            return appServer.start(spec, given);
          },
        },
      })
    ).engines.open(CANVAS);
    const started = await send('builder', 'Start', YOU);
    await vi.waitFor(async () => {
      expect((await find(started, YOU))?.state).toBe('replied');
    });
    engine.sessions.setMode('builder', 'full-access');
    await vi.waitFor(() => {
      expect(engine.sessions.of('builder').mode).toBe('full-access');
    });
    host?.emit({ type: 'closed' });
    // It starts again in its own mode, which asks.
    const id = await send('builder', 'After it ended');
    await vi.waitFor(async () => {
      expect((await find(id))?.state).toBe('replied');
    });
    expect(appServer.started).toHaveLength(2);
  });

  it('tells a sender its message failed when the session won’t take another party’s, and what waits behind it goes', async () => {
    // A session that takes only its user's messages, as one whose CLI would hold another party's.
    const picky: Connector<SessionMode> = {
      start: async (spec, host) => {
        const session = await appServer.start(spec, host);
        return {
          send: (message) =>
            message.from === undefined
              ? session.send(message)
              : Promise.reject(new Error('Not sent: it takes no message from another party now.')),
          answer: (id, answer) => session.answer(id, answer),
          interrupt: () => session.interrupt(),
          setMode: (mode) => session.setMode(mode),
          setModel: (model) => session.setModel(model),
          close: () => session.close(),
        };
      },
    };
    await keepCanvas();
    await start({ appServer: picky });
    const id = await send('builder', 'Hello');
    const yours = await send('builder', 'From you', YOU);
    await vi.waitFor(async () => {
      expect((await find(yours, YOU))?.state).toBe('replied');
    });
    expect(await find(id)).toMatchObject({ state: 'replied' });
    expect((await inbox()).filter((message) => message.replyTo === id)).toEqual([
      expect.objectContaining({
        from: 'agent:builder',
        turn: {
          status: 'failed',
          reason: 'error',
          message: 'Not sent: it takes no message from another party now.',
        },
      }),
    ]);
  });

  it('names who sent each message to its session, and nobody for yours', async () => {
    await keepCanvas();
    await start();
    const theirs = await send('helper', 'Check this', BUILDER);
    await vi.waitFor(async () => {
      const reply = (await inbox(BUILDER)).find((message) => message.replyTo === theirs);
      expect(reply?.state).toBe('replied');
    });
    const yours = await send('builder', 'From you', YOU);
    await vi.waitFor(async () => {
      expect((await find(yours, YOU))?.state).toBe('replied');
    });
    const senders = appServer.sessions.flatMap((session) =>
      session.sent.map(({ text, from }) => [text.split('\n')[0], from]),
    );
    expect(senders).toEqual([
      [
        expect.stringMatching(/^\[corrallm\] Message from agent "Builder"/),
        { party: 'agent:builder', name: 'Builder' },
      ],
      [
        expect.stringMatching(/^\[corrallm\] Reply from agent "Helper"/),
        { party: 'agent:helper', name: 'Helper' },
      ],
      ['From you', undefined],
    ]);
  });

  it('tells an agent how the turn its reply came from ended, when it didn’t complete', async () => {
    await keepCanvas();
    const resetsAt = Date.now() + 3_600_000;
    await start({
      appServer: {
        // A turn whose message asks it to fails on a usage limit.
        start: async (spec, host) => {
          const session = await appServer.start(spec, host);
          const send = session.send.bind(session);
          session.send = (message) => {
            if (!message.text.endsWith('Fail this')) return send(message);
            host.emit({ type: 'user', id: message.id, text: message.text });
            host.emit({
              type: 'end',
              messages: [message.id],
              seconds: 1,
              interrupted: false,
              failed: true,
              result: { status: 'failed', reason: 'usage-limit', resetsAt },
            });
            return Promise.resolve();
          };
          return session;
        },
      },
    });
    const id = await send('helper', 'Fail this', BUILDER);
    await vi.waitFor(async () => {
      const reply = (await inbox(BUILDER)).find((message) => message.replyTo === id);
      expect(reply?.state).toBe('replied');
    });
    const reply = (await inbox(BUILDER)).find((message) => message.replyTo === id);
    expect(reply).toMatchObject({
      body: '',
      turn: { status: 'failed', reason: 'usage-limit', resetsAt },
    });
    expect(sent(appServer).at(-1)).toMatch(
      new RegExp(
        `^\\[corrallm\\] Reply from agent "Helper" \\(an agent, not the user; message ${String(reply?.id)}, replying to your message ${id}; its turn failed: a usage limit, until [^)]*\\d:\\d\\d\\):\n$`,
      ),
    );
  });

  it('takes back only what its sender may, and says why it can’t', async () => {
    await keepCanvas();
    await start({ appServer: new FakeConnector({ adapter: 'codex', pause: 200 }) });
    await ok('run.pause', { target: { agent: 'builder' } }, YOU);
    const waiting = await send('builder', 'Wait for me');
    // Builder may name a message sent to it, but takes back only what it sent.
    expect(await core?.call('withdraw', { canvas: CANVAS, id: waiting }, BUILDER)).toEqual({
      ok: false,
      error: { code: 'refused', sentence: 'Only a message you sent can be taken back.' },
    });
    expect((await find(waiting))?.state).toBe('pending');
    await ok('run.unpause', { target: { agent: 'builder' } }, YOU);
    await vi.waitFor(async () => {
      expect((await find(waiting))?.state).toBe('delivered');
    });
    // Once it is in its turn, even you take back another party's message only by interrupting.
    expect(await core?.call('withdraw', { canvas: CANVAS, id: waiting }, YOU)).toEqual({
      ok: false,
      error: {
        code: 'refused',
        sentence:
          'Another party’s message can be taken back only while it waits; interrupt its turn instead.',
      },
    });
    await vi.waitFor(async () => {
      expect((await find(waiting))?.state).toBe('replied');
    });
    // Replied to, it stays so.
    expect(await core?.call('withdraw', { canvas: CANVAS, id: waiting }, OUTSIDE)).toEqual({
      ok: false,
      error: { code: 'conflict', sentence: 'That message is replied to already.' },
    });
    expect((await find(waiting))?.state).toBe('replied');
    // A record is never delivered: nothing to take back.
    const [notice] = await notices();
    expect(await core?.call('withdraw', { canvas: CANVAS, id: notice?.id }, YOU)).toEqual({
      ok: false,
      error: {
        code: 'conflict',
        sentence:
          'That message is a record; records are never delivered, so there is nothing to take back.',
      },
    });
  });

  it('delivers an agent its reply as a turn, which makes no reply of its own', async () => {
    await keepCanvas();
    await start();
    const id = await send('helper', 'Check this', BUILDER);
    await vi.waitFor(async () => {
      const reply = (await inbox(BUILDER)).find((message) => message.replyTo === id);
      expect(reply?.state).toBe('replied');
    });
    const reply = (await inbox(BUILDER)).find((message) => message.replyTo === id);
    expect(reply).toMatchObject({ from: 'agent:helper', to: 'agent:builder' });
    // Builder was told it, framed as a reply.
    expect(sent(appServer).at(-1)).toMatch(
      new RegExp(
        `^\\[corrallm\\] Reply from agent "Helper" \\(an agent, not the user; message ${String(reply?.id)}, replying to your message ${id}\\):\n`,
      ),
    );
    // Builder's turn made nothing.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await inbox(BUILDER)).filter((message) => message.kind === 'text')).toHaveLength(2);
  });

  it('tells a sender once when its message’s turn waits for you, and lists the prompt for each party', async () => {
    await keepCanvas();
    await start();
    const id = await send('checker', 'Run the tests');
    await vi.waitFor(async () => {
      expect((await inbox()).filter((message) => message.kind === 'notice')).toHaveLength(1);
    });
    expect((await inbox()).find((message) => message.kind === 'notice')).toMatchObject({
      from: 'corrallm',
      replyTo: id,
      body: 'Checker is waiting for you: Approve Bash: echo hello?',
    });
    // You see the prompt with its choices; a token sees it, without them.
    const yours = (await ok<{ items: NeedsItem[] }>('needs', {}, YOU)).items;
    expect(yours).toEqual([
      expect.objectContaining({
        kind: 'prompt',
        agent: 'checker',
        for: 'you',
        by: ['you'],
        title: 'Approve Bash: echo hello?',
        answerIn: 'api',
      }),
    ]);
    expect(yours[0]?.choices.map(({ value }) => value)).toEqual(['once', 'always', 'deny']);
    for (const caller of [OUTSIDE, READER]) {
      const theirs = (await ok<{ items: NeedsItem[] }>('needs', {}, caller)).items;
      expect(theirs).toEqual(yours.map(withoutChoices));
    }
    // Builder, linked to it, sees it too; Shell, linked to nobody, sees nothing.
    expect((await ok<{ items: NeedsItem[] }>('needs', {}, BUILDER)).items).toHaveLength(1);
    expect((await ok<{ items: NeedsItem[] }>('needs', {}, SHELL)).items).toEqual([]);

    // Interrupting the turn withdraws the prompt, and the reply says how it ended.
    await ok('session.interrupt', { agent: 'checker' });
    await vi.waitFor(async () => {
      expect((await find(id))?.state).toBe('replied');
    });
    expect(
      (await inbox()).find((message) => message.replyTo === id && message.kind === 'text'),
    ).toMatchObject({ turn: { status: 'cancelled', reason: 'interrupted' } });
    expect((await ok<{ items: NeedsItem[] }>('needs', {}, YOU)).items).toEqual([]);
    expect((await inbox()).filter((message) => message.kind === 'notice')).toHaveLength(1);
  });
});

describe('an agent that isn’t idle', () => {
  it('keeps a party’s message waiting while a turn of yours goes on, and delivers it after', async () => {
    await keepCanvas();
    const slow = new FakeConnector({ adapter: 'codex', pause: 150 });
    await start({ appServer: slow });
    const yours = await send('builder', 'A long job', YOU);
    await vi.waitFor(async () => {
      expect((await find(yours, YOU))?.state).toBe('delivered');
    });
    const theirs = await send('builder', 'Then this');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await find(yours, YOU))?.state).toBe('delivered');
    expect((await find(theirs))?.state).toBe('pending');
    await vi.waitFor(
      async () => {
        expect((await find(theirs))?.state).toBe('replied');
      },
      { timeout: 3000 },
    );
    expect(sent(slow)).toEqual(['A long job', `${FRAME(theirs)}Then this`]);
  });

  /** A Terminal whose CLI asks `asks` in its terminal, whenever a test says (`ask`). */
  function asksInTerminal() {
    let host: Parameters<Connector<SessionMode>['start']>[1] | undefined;
    const connector: Connector<SessionMode> = {
      start: async (spec, given) => {
        host = given;
        return terminal.start(spec, given);
      },
    };
    return {
      connector,
      ask: (asks: { kind: 'other'; id: string; text: string }[]) => {
        host?.emit({ type: 'asking', asks });
      },
    };
  }

  it('keeps a party’s message waiting while a Terminal’s CLI asks something in its terminal', async () => {
    await keepCanvas();
    const shell = asksInTerminal();
    await start({ terminal: shell.connector });
    // Its session runs.
    const yours = await send('shell', 'Hello', YOU);
    await vi.waitFor(async () => {
      expect((await find(yours, YOU))?.state).toBe('replied');
    });
    shell.ask([{ kind: 'other', id: 'login', text: 'Log in to continue' }]);
    const theirs = await send('shell', 'Then this');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await find(theirs))?.state).toBe('pending');
    // It went on: the message goes.
    shell.ask([]);
    await vi.waitFor(async () => {
      expect((await find(theirs))?.state).toBe('replied');
    });
  });

  it('tells no one a turn waits for you over what a Terminal asks while it still works', async () => {
    await keepCanvas();
    const shell = asksInTerminal();
    await start({
      terminal: {
        // Its turn works on, and its CLI lists what it asks (no status report says it waits).
        start: async (spec, host) => {
          const session = await shell.connector.start(spec, host);
          session.send = (message) => {
            host.emit({ type: 'user', id: message.id, text: message.text });
            host.emit({ type: 'status', status: 'working' });
            shell.ask([{ kind: 'other', id: 'login', text: 'Log in to continue' }]);
            return Promise.resolve();
          };
          return session;
        },
      },
    });
    const id = await send('shell', 'Go on');
    await vi.waitFor(async () => {
      expect((await find(id))?.state).toBe('delivered');
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await notices()).toEqual([]);
  });
});

describe('a turn waiting for you', () => {
  /** A canvas whose Builder and Checker each hold an OK on their queue, the run asking for both. */
  async function heldAtOks() {
    const ok = [{ id: 'ok', approve: 'the plan' }];
    await keepCanvas(
      AGENTS.map((agent) =>
        agent.id === 'builder' || agent.id === 'checker' ? { ...agent, queue: ok } : agent,
      ),
    );
    const engine = await (await start()).engines.open(CANVAS);
    engine.run.start();
    expect(engine.run.snapshot().agents).toMatchObject({
      builder: { status: 'asking', current: 'ok' },
      checker: { status: 'asking', current: 'ok' },
    });
  }

  it('tells no one a turn waits for you over a hold of the run’s on its agent', async () => {
    await heldAtOks();
    const id = await send('builder', 'Say hello');
    await vi.waitFor(async () => {
      expect((await find(id))?.state).toBe('replied');
    });
    expect(await notices()).toEqual([]);
  });

  /** A connector whose every turn waits on what `prompt` asks, for the message it was sent. */
  const asking = (prompt: (message: string) => SessionEvent): Connector<SessionMode> => ({
    start: (_spec, host) => {
      host.emit({ type: 'started', model: 'default', mode: 'auto', models: [] });
      const idle = () => Promise.resolve();
      return Promise.resolve({
        send: (message) => {
          host.emit({ type: 'user', id: message.id, text: message.text });
          host.emit({ type: 'status', status: 'working' });
          host.emit(prompt(message.id));
          host.emit({ type: 'status', status: 'waiting' });
          return idle();
        },
        answer: idle,
        interrupt: idle,
        setMode: idle,
        setModel: idle,
        close: idle,
      });
    },
  });

  it.each<[string, (message: string) => SessionEvent]>([
    [
      'a very long one-line command',
      (message) => ({
        type: 'permission',
        id: `${message}/permission`,
        tool: 'Bash',
        summary: `echo ${'a'.repeat(MAX_MESSAGE_BYTES)}`,
        always: null,
      }),
    ],
    [
      'a very long question',
      (message) => ({
        type: 'question',
        id: `${message}/question`,
        questions: [
          {
            header: 'Which',
            text: `Which of these ${'very '.repeat(MAX_MESSAGE_BYTES / 4)}long names?`,
            options: [{ label: 'This one', description: '' }],
            multiple: false,
          },
        ],
      }),
    ],
  ])('quotes %s in a waiting notice cut short, within a message’s size', async (_, prompt) => {
    await keepCanvas();
    await start({ appServer: asking(prompt) });
    const id = await send('builder', 'Go on');
    await vi.waitFor(async () => {
      expect(await notices()).toHaveLength(1);
    });
    const [notice] = await notices();
    expect(notice).toMatchObject({
      replyTo: id,
      body: expect.stringMatching(
        /^Builder is waiting for you: (Approve Bash: echo a+|Which of these (very )*very)…$/,
      ) as string,
    });
    expect(new TextEncoder().encode(notice?.body).length).toBeLessThan(MAX_MESSAGE_BYTES / 16);
  });

  it('names what the turn itself waits on, never a hold of the run’s', async () => {
    await heldAtOks();
    const id = await send('checker', 'Run the tests');
    await vi.waitFor(async () => {
      expect(await notices()).toHaveLength(1);
    });
    expect(await notices()).toEqual([
      expect.objectContaining({
        replyTo: id,
        body: 'Checker is waiting for you: Approve Bash: echo hello?',
      }),
    ]);
  });
});

describe('the shell prefix', () => {
  it('refuses a token’s body a Terminal agent would run as a shell command, naming the prefix', async () => {
    await keepCanvas();
    await start();
    for (const body of ['!ls', '  !ls']) {
      expect(await core?.call('message', { canvas: CANVAS, to: 'shell', body }, OUTSIDE)).toEqual({
        ok: false,
        error: {
          code: 'refused',
          sentence:
            'It starts with "!", which Codex · Terminal runs as a shell command without asking: only you may send that.',
        },
      });
    }
    expect(await inbox()).toEqual([]);
  });

  it('sends yours as you typed it, and frames a token’s for an App Server agent', async () => {
    await keepCanvas();
    await start();
    const yours = await send('shell', '!ls', YOU);
    await vi.waitFor(async () => {
      expect((await find(yours, YOU))?.state).toBe('replied');
    });
    expect(sent(terminal)).toEqual(['!ls']);
    const theirs = await send('builder', '!ls');
    await vi.waitFor(async () => {
      expect((await find(theirs))?.state).toBe('replied');
    });
    expect(sent(appServer)).toEqual([`${FRAME(theirs)}!ls`]);
  });
});

describe('usage', () => {
  /** A Codex usage reading over its rule's share, resetting at `resetsAt`. */
  async function overRule(action: string, resetsAt: number | null): Promise<void> {
    await writeFile(
      path.join(profile, 'usage.json'),
      JSON.stringify({
        version: 2,
        readings: [
          { backend: 'codex', windows: { fiveHour: { usedPercent: 80, resetsAt } }, at: 1 },
        ],
        rules: { codex: { window: 'fiveHour', percent: 50, action } },
      }),
    );
  }

  it.each(['ask', 'waitForReset'])(
    'holds a party’s message by the recipient’s rule (%s) until the window resets, telling its sender once',
    async (action) => {
      const resetsAt = Date.now() + 400;
      await overRule(action, resetsAt);
      await keepCanvas();
      await start();
      const id = await send('builder', 'Say hello');
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect((await find(id))?.state).toBe('pending');
      expect((await inbox()).filter((message) => message.kind === 'notice')).toEqual([
        expect.objectContaining({
          replyTo: id,
          body: expect.stringMatching(
            /^Codex has used 80% of its 5-hour window \(over 50%\), so your message to Builder waits until it resets at \d{1,2}:\d\d\.$/,
          ) as string,
        }),
      ]);
      await vi.waitFor(
        async () => {
          expect((await find(id))?.state).toBe('replied');
        },
        { timeout: 3000 },
      );
      expect((await inbox()).filter((message) => message.kind === 'notice')).toHaveLength(1);
    },
  );

  it.each(['ask', 'waitForReset'])(
    'delivers a party’s message over a rule (%s) whose window’s reset isn’t known, warning its agent',
    async (action) => {
      // Headless, nothing would read its usage again while the message waited: it never resets.
      await overRule(action, null);
      await keepCanvas();
      const engine = await (await start()).engines.open(CANVAS);
      const id = await send('builder', 'Say hello');
      await vi.waitFor(async () => {
        expect((await find(id))?.state).toBe('replied');
      });
      expect(await notices()).toEqual([]);
      await vi.waitFor(() => {
        expect(
          engine.sessions
            .of('builder')
            .entries.filter((entry) => entry.kind === 'notice' && entry.level === 'warning'),
        ).toEqual([
          expect.objectContaining({
            text: expect.stringMatching(/^Codex has used 80% of its 5-hour window/) as string,
          }),
        ]);
      });
    },
  );

  it('delivers parties’ messages over a rule that warns, warning their agent once', async () => {
    await overRule('warn', Date.now() + 60_000);
    await keepCanvas();
    const engine = await (await start()).engines.open(CANVAS);
    for (const body of ['First', 'Second']) {
      const id = await send('builder', body);
      await vi.waitFor(async () => {
        expect((await find(id))?.state).toBe('replied');
      });
    }
    expect(await notices()).toEqual([]);
    await vi.waitFor(() => {
      expect(
        engine.sessions
          .of('builder')
          .entries.filter((entry) => entry.kind === 'notice' && entry.level === 'warning'),
      ).toEqual([
        expect.objectContaining({
          text: expect.stringMatching(/^Codex has used 80% of its 5-hour window/) as string,
        }),
      ]);
    });
  });

  it('never holds what you send', async () => {
    await overRule('waitForReset', Date.now() + 60_000);
    await keepCanvas();
    await start();
    const id = await send('builder', 'Go ahead', YOU);
    await vi.waitFor(async () => {
      expect((await find(id, YOU))?.state).toBe('replied');
    });
  });

  /** A run whose Builder is held by its usage rule (`action`) before its queue's message. */
  async function heldOnUsage(action: string, resetsAt: number) {
    await overRule(action, resetsAt);
    await keepCanvas([
      { ...BUILDER_AGENT, queue: [{ id: 'hello', message: 'From the queue' }] },
      ...AGENTS.slice(1),
    ]);
    const engine = await (await start()).engines.open(CANVAS);
    engine.run.start();
    expect(engine.run.snapshot().agents.builder).toMatchObject({
      current: 'hello',
      status: action === 'ask' ? 'asking' : 'waiting',
      usage: { backend: 'codex', window: 'fiveHour', resetsAt },
    });
    return engine;
  }

  const WAITS =
    /^Codex has used 80% of its 5-hour window \(over 50%\), so your message to Builder waits until it resets at \d{1,2}:\d\d\.$/;

  it('tells each party whose message waits on a usage window, once', async () => {
    await overRule('waitForReset', Date.now() + 60_000);
    await keepCanvas();
    await start();
    const first = await send('builder', 'First');
    const others = await send('builder', 'From another orchestrator', OTHER);
    await send('builder', 'Again');
    const builders = await send('helper', 'From Builder', BUILDER);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(appServer.started).toEqual([]);
    for (const [caller, id] of [
      [OUTSIDE, first],
      [OTHER, others],
    ] as const) {
      expect(await notices(caller)).toEqual([
        expect.objectContaining({ replyTo: id, body: expect.stringMatching(WAITS) as string }),
      ]);
    }
    expect(await notices(BUILDER)).toEqual([
      expect.objectContaining({
        replyTo: builders,
        body: expect.stringMatching(/so your message to Helper waits until it resets at/) as string,
      }),
    ]);
  });

  it.each(['ask', 'waitForReset'])(
    'holds a party’s message while the run holds its agent on usage (%s) until the window resets, but never yours',
    async (action) => {
      const resetsAt = Date.now() + 1500;
      const engine = await heldOnUsage(action, resetsAt);
      const id = await send('builder', 'Say hello');
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect((await find(id))?.state).toBe('pending');
      expect(await notices()).toEqual([
        expect.objectContaining({ replyTo: id, body: expect.stringMatching(WAITS) as string }),
      ]);
      // What you send goes past the hold.
      const yours = await send('builder', 'From you', YOU);
      await vi.waitFor(async () => {
        expect((await find(yours, YOU))?.state).toBe('replied');
      });
      expect((await find(id))?.state).toBe('pending');
      expect(sent(appServer)).toEqual(['From you']);

      await vi.waitFor(
        async () => {
          expect((await find(id))?.state).toBe('replied');
        },
        { timeout: 3500 },
      );
      expect(Date.now()).toBeGreaterThanOrEqual(resetsAt);
      // The run's hold went with its window, so the party's turn waited for no one.
      expect(engine.run.snapshot().agents.builder?.usage).toBeUndefined();
      expect(await notices()).toHaveLength(1);
    },
  );

  it.each([
    ['ask', 'decide'],
    ['waitForReset', 'goOn'],
  ] as const)(
    'delivers a party’s message once you tell the run to go on at its usage hold (%s)',
    async (action, how) => {
      const engine = await heldOnUsage(action, Date.now() + 60_000);
      const id = await send('builder', 'Say hello');
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect((await find(id))?.state).toBe('pending');
      if (how === 'decide') engine.run.decide('builder', 'hello', { choice: 'goOn' });
      else engine.run.goOn('builder', 'hello');
      await vi.waitFor(async () => {
        expect((await find(id))?.state).toBe('replied');
      });
      expect(sent(appServer)).toEqual(['From the queue', `${FRAME(id)}Say hello`]);
      expect(await notices()).toEqual([
        expect.objectContaining({ replyTo: id, body: expect.stringMatching(WAITS) as string }),
      ]);
    },
  );

  it('holds a party’s message no longer than the window of a usage hold a stopped run left', async () => {
    const resetsAt = Date.now() + 1500;
    const engine = await heldOnUsage('waitForReset', resetsAt);
    engine.run.stop();
    expect(engine.run.snapshot().agents.builder?.usage).toMatchObject({ resetsAt });
    const id = await send('builder', 'Say hello');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await find(id))?.state).toBe('pending');
    await vi.waitFor(
      async () => {
        expect((await find(id))?.state).toBe('replied');
      },
      { timeout: 3500 },
    );
    // The stopped run sent nothing of its own.
    expect(sent(appServer)).toEqual([`${FRAME(id)}Say hello`]);
    expect(await notices()).toEqual([
      expect.objectContaining({ replyTo: id, body: expect.stringMatching(WAITS) as string }),
    ]);
  });
});

describe('a restart', () => {
  it('leaves a message cut off mid-turn unresolved, tells its sender, and never sends it again', async () => {
    await keepCanvas();
    await start({ appServer: new FakeConnector({ adapter: 'codex', pause: 5000 }) });
    const id = await send('builder', 'A long job');
    await vi.waitFor(async () => {
      expect((await find(id))?.state).toBe('delivered');
    });
    const restarted = new FakeConnector({ adapter: 'codex' });
    await restart({ appServer: restarted });
    expect(await find(id)).toMatchObject({ state: 'unresolved' });
    expect((await inbox()).filter((message) => message.kind === 'notice')).toEqual([
      expect.objectContaining({
        replyTo: id,
        turn: { status: 'cancelled', reason: 'connection-closed' },
      }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(restarted.started).toEqual([]);
  });

  it('tells whoever waited in a log set aside as broken, and a cursor from before reads on', async () => {
    await keepCanvas();
    await start();
    await ok('run.pause', { target: { agent: 'builder' } }, YOU);
    const waited = await send('builder', 'First');
    const hello = await send('helper', 'Hello');
    await vi.waitFor(async () => {
      expect((await find(hello))?.state).toBe('replied');
    });
    // Its records all come after the broken line: it still waits, for certain.
    const later = await send('builder', 'Second');
    const { next } = await ok<{ next: string }>('status', {});
    await core?.close();
    core = undefined;
    const log = path.join(profile, 'runs', CANVAS, 'messages.jsonl');
    const lines = (await readFile(log, 'utf8')).trimEnd().split('\n');
    await writeFile(log, `${String(lines[0])}\nnot json\n${lines.slice(1).join('\n')}\n`);

    await start();
    expect(await find(waited)).toMatchObject({ state: 'unresolved' });
    // Its sender is told, after the cursor status gave before: a cursor reads on from it.
    const after = await ok<{ items: Message[] }>('messages', { after: next });
    expect(after.items).toEqual([
      expect.objectContaining({
        kind: 'notice',
        replyTo: waited,
        body: 'Your message to Builder couldn’t be read back when corrallm opened the canvas, so it won’t be sent.',
        turn: expect.objectContaining({ status: 'failed', reason: 'error' }) as unknown,
      }),
    ]);
    expect(sent(appServer).filter((text) => text.endsWith('First'))).toEqual([]);
    expect((await find(later))?.state).toBe('pending');
    await ok('run.unpause', { target: { agent: 'builder' } }, YOU);
    await vi.waitFor(async () => {
      expect((await find(later))?.state).toBe('replied');
    });
    expect(sent(appServer).filter((text) => text.endsWith('First'))).toEqual([]);
  });

  it('tells a sender what its message waits on once, across a restart too', async () => {
    await keepCanvas();
    await start();
    await ok('run.pause', { target: { agent: 'builder' } }, YOU);
    const id = await send('builder', 'Still paused?');
    await vi.waitFor(async () => {
      expect(await notices()).toHaveLength(1);
    });
    await restart();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await find(id))?.state).toBe('pending');
    expect(await notices()).toHaveLength(1);
  });

  it('tells a sender anew when a session that started after a restart won’t start again', async () => {
    await keepCanvas();
    await start({ appServer: REFUSING });
    const first = await send('builder', 'First');
    await vi.waitFor(async () => {
      expect(await notices()).toHaveLength(1);
    });
    let refuse = false;
    const engine = await (
      await restart({
        appServer: { start: (spec, host) => (refuse ? REFUSING : appServer).start(spec, host) },
      })
    ).engines.open(CANVAS);
    await vi.waitFor(async () => {
      expect((await find(first))?.state).toBe('replied');
    });
    // Its session ends, and won't start again: its sender's next message waits, and it is told.
    refuse = true;
    await engine.sessions.restart('builder');
    const second = await send('builder', 'Second');
    await vi.waitFor(async () => {
      expect(await notices()).toHaveLength(2);
    });
    expect((await notices()).map(({ replyTo }) => replyTo)).toEqual([first, second]);
  });

  it('withdraws what waited for an agent no longer on the canvas, telling each sender', async () => {
    await keepCanvas();
    await start();
    await ok('run.pause', { target: { agent: 'helper' } }, YOU);
    const theirs = await send('helper', 'Still there?');
    const builders = await send('helper', 'And from me', BUILDER);
    await core?.close();
    core = undefined;
    // Deleted in the app meanwhile.
    await rm(path.join(profile, 'runs', CANVAS, 'record.json'), { force: true });
    await keepCanvas(
      AGENTS.filter(({ id }) => id !== 'helper'),
      [['builder', 'checker']],
    );
    await start();
    await vi.waitFor(async () => {
      expect(await find(theirs)).toMatchObject({ state: 'withdrawn', by: 'corrallm' });
    });
    for (const [caller, id] of [
      [OUTSIDE, theirs],
      [BUILDER, builders],
    ] as const) {
      // Told it waited on a pause, then that it was withdrawn.
      expect((await notices(caller)).filter(({ replyTo }) => replyTo === id)).toEqual([
        expect.objectContaining({
          body: expect.stringMatching(/^Helper is paused by you/) as string,
        }),
        expect.objectContaining({
          body: 'Your message was withdrawn: the agent it was for, helper, is no longer on the canvas.',
          turn: { status: 'cancelled', reason: 'taken-back' },
        }),
      ]);
    }
  });

  it('leaves a message journaled as delivering unresolved after a crash, and sends what was pending', async () => {
    await keepCanvas();
    const log = path.join(profile, 'runs', CANVAS, 'messages.jsonl');
    await mkdir(path.dirname(log), { recursive: true });
    const message = (seq: number, id: string, state: string) =>
      JSON.stringify({
        seq,
        message: {
          id,
          canvas: CANVAS,
          from: 'outside:orchestrator',
          to: 'agent:builder',
          kind: 'text',
          body: `Message ${String(seq)}`,
          state,
          at: 1,
          ...(state === 'pending'
            ? {}
            : { delivery: { at: 1, as: crypto.randomUUID(), attempt: 1 } }),
        },
      });
    const cut = crypto.randomUUID();
    const waiting = crypto.randomUUID();
    await writeFile(log, `${message(1, cut, 'delivering')}\n${message(2, waiting, 'pending')}\n`);
    await start();
    expect(await find(cut)).toMatchObject({ state: 'unresolved' });
    await vi.waitFor(async () => {
      expect((await find(waiting))?.state).toBe('replied');
    });
    expect(sent(appServer)).toEqual([`${FRAME(waiting)}Message 2`]);
  });
});

describe('pauses', () => {
  /** Builder and Helper in the group Team. */
  const TEAM = AGENTS.map((agent) =>
    agent.id === 'builder' || agent.id === 'helper' ? { ...agent, parent: 'team' } : agent,
  );

  it('says what still holds an agent a token unpauses, and a party’s message to it still waits', async () => {
    await keepCanvas();
    await start();
    await ok('run.pause', { target: { agent: 'builder' } }, YOU);
    await ok('run.pause', { target: { agent: 'builder' } });
    expect(await ok('run.unpause', { target: { agent: 'builder' } })).toEqual({
      held: [{ by: 'you', on: 'builder' }],
    });
    const id = await send('builder', 'Still paused?');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await find(id))?.state).toBe('pending');
    // Yours released too, it runs again.
    expect(await ok('run.unpause', { target: { agent: 'builder' } }, YOU)).toEqual({ held: [] });
    await vi.waitFor(async () => {
      expect((await find(id))?.state).toBe('replied');
    });
  });

  it('refuses to unpause an agent only another party’s pauses hold, naming who set them', async () => {
    await keepCanvas(TEAM, LINKS, [{ id: 'team', label: 'Team' }]);
    await start();
    await ok('run.pause', { target: { group: 'team' } }, YOU);
    await ok('run.pause', { target: { agent: 'builder' } }, OTHER);
    expect(
      await core?.call('run.unpause', { canvas: CANVAS, target: { agent: 'builder' } }, OUTSIDE),
    ).toEqual({
      ok: false,
      error: {
        code: 'refused',
        sentence:
          'Builder stays paused by "other" and by you on its group "Team": only the party that set a pause, or you, can release it.',
      },
    });
    // You release only Builder's own pauses; its group's still holds it.
    expect(await ok('run.unpause', { target: { agent: 'builder' } }, YOU)).toEqual({
      held: [{ by: 'you', on: 'team' }],
    });
  });

  it('tells a token whose own pause on a group holds an agent to release that group', async () => {
    await keepCanvas(TEAM, LINKS, [{ id: 'team', label: 'Team' }]);
    await start();
    await ok('run.pause', { target: { group: 'team' } });
    const unpause = () =>
      core?.call('run.unpause', { canvas: CANVAS, target: { agent: 'builder' } }, OUTSIDE);
    expect(await unpause()).toEqual({
      ok: false,
      error: {
        code: 'refused',
        sentence:
          'Builder is held by your pause on its group "Team": release it with run.unpause on that group.',
      },
    });
    await ok('run.pause', { target: { agent: 'builder' } }, OTHER);
    expect(await unpause()).toEqual({
      ok: false,
      error: {
        code: 'refused',
        sentence:
          'Builder is held by your pause on its group "Team": release it with run.unpause on that group. It is also paused by "other": only the party that set a pause, or you, can release it.',
      },
    });
    expect(await ok('run.unpause', { target: { group: 'team' } })).toEqual({ held: [] });
  });

  it('tells a party once that its message waits on a pause, naming who set it', async () => {
    await keepCanvas(TEAM, LINKS, [{ id: 'team', label: 'Team' }]);
    await start();
    await ok('run.pause', { target: { group: 'team' } }, YOU);
    const first = await send('builder', 'First');
    await send('builder', 'Second');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await notices()).toEqual([
      expect.objectContaining({
        replyTo: first,
        body: 'Builder is paused by you on its group "Team", so your message waits until it is released: only the party that set a pause, or you, can release it.',
      }),
    ]);
  });

  it('tells a party anew when the agent it messages is paused again', async () => {
    await keepCanvas();
    await start();
    await ok('run.pause', { target: { agent: 'builder' } }, YOU);
    const first = await send('builder', 'First');
    await vi.waitFor(async () => {
      expect(await notices()).toHaveLength(1);
    });
    await ok('run.unpause', { target: { agent: 'builder' } }, YOU);
    await vi.waitFor(async () => {
      expect((await find(first))?.state).toBe('replied');
    });
    await ok('run.pause', { target: { agent: 'builder' } }, YOU);
    const second = await send('builder', 'Second');
    await vi.waitFor(async () => {
      expect(await notices()).toHaveLength(2);
    });
    expect((await notices()).map(({ replyTo }) => replyTo)).toEqual([first, second]);
  });

  it('forgets only what was told of the agent released, whatever its id holds', async () => {
    await keepCanvas([BUILDER_AGENT, { ...BUILDER_AGENT, id: 'builder:two', label: 'Two' }], []);
    await start();
    for (const agent of ['builder', 'builder:two']) {
      await ok('run.pause', { target: { agent } }, YOU);
      await send(agent, `To ${agent}`);
    }
    await vi.waitFor(async () => {
      expect(await notices()).toHaveLength(2);
    });
    await ok('run.unpause', { target: { agent: 'builder' } }, YOU);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await notices()).toHaveLength(2);
  });

  it('refuses a token releasing another token’s pause', async () => {
    await keepCanvas();
    await start();
    await ok('run.pause', { target: { agent: 'builder' } }, OTHER);
    expect(
      await core?.call('run.unpause', { canvas: CANVAS, target: { agent: 'builder' } }, OUTSIDE),
    ).toMatchObject({ ok: false, error: { code: 'refused' } });
    expect(await ok('run.unpause', { target: { agent: 'builder' } }, OTHER)).toEqual({ held: [] });
  });

  it('lets a token release a kill it made', async () => {
    await keepCanvas();
    await start();
    await ok('run.kill', { target: { agent: 'builder' } });
    expect(await ok('run.unpause', { target: { agent: 'builder' } })).toEqual({ held: [] });
    const id = await send('builder', 'Back again');
    await vi.waitFor(async () => {
      expect((await find(id))?.state).toBe('replied');
    });
  });

  it('holds every member’s messages while their group is paused', async () => {
    await keepCanvas(TEAM, LINKS, [{ id: 'team', label: 'Team' }]);
    await start();
    await ok('run.pause', { target: { group: 'team' } });
    const ids = [await send('builder', 'One'), await send('helper', 'Two')];
    await new Promise((resolve) => setTimeout(resolve, 50));
    for (const id of ids) expect((await find(id))?.state).toBe('pending');
    expect(appServer.started).toEqual([]);
  });

  it('lets a token release only the pauses its own party set', async () => {
    await keepCanvas();
    await start();
    await ok('run.pause', { target: { agent: 'builder' } }, YOU);
    expect(
      await core?.call('run.unpause', { canvas: CANVAS, target: { agent: 'builder' } }, OUTSIDE),
    ).toMatchObject({ ok: false, error: { code: 'refused' } });
    // Its own pause it may release; yours stays.
    await ok('run.pause', { target: { agent: 'helper' } });
    await ok('run.unpause', { target: { agent: 'helper' } });
    const id = await send('builder', 'Still paused?');
    const helper = await send('helper', 'Free?');
    await vi.waitFor(async () => {
      expect((await find(helper))?.state).toBe('replied');
    });
    expect((await find(id))?.state).toBe('pending');
  });
});

describe('a kill', () => {
  /** Builder and Helper in the group Team. */
  const TEAM = AGENTS.map((agent) =>
    agent.id === 'builder' || agent.id === 'helper' ? { ...agent, parent: 'team' } : agent,
  );

  it('takes back what waits for every member of a group it kills', async () => {
    await keepCanvas(TEAM, LINKS, [{ id: 'team', label: 'Team' }]);
    await start();
    await ok('run.pause', { target: { group: 'team' } }, YOU);
    const ids = [await send('builder', 'One'), await send('helper', 'Two')];
    await ok('run.kill', { target: { group: 'team' } }, YOU);
    for (const id of ids) expect(await find(id)).toMatchObject({ state: 'withdrawn', by: 'you' });
  });

  it('takes back what a killed agent sent that still waits', async () => {
    await keepCanvas();
    await start();
    await ok('run.pause', { target: { agent: 'checker' } }, YOU);
    const id = await send('checker', 'Check this', BUILDER);
    await ok('run.kill', { target: { agent: 'builder' } }, YOU);
    expect(await find(id, BUILDER)).toMatchObject({ state: 'withdrawn', by: 'you' });
  });

  it('takes back what waits for a killed agent and interrupts its turn, telling each sender', async () => {
    await keepCanvas();
    await start({ appServer: new FakeConnector({ adapter: 'codex', pause: 200 }) });
    const going = await send('builder', 'A long job');
    await vi.waitFor(async () => {
      expect((await find(going))?.state).toBe('delivered');
    });
    const waiting = await send('builder', 'Then this');
    await ok('run.kill', { target: { agent: 'builder' } }, YOU);
    await vi.waitFor(async () => {
      expect((await find(going))?.state).toBe('withdrawn');
    });
    expect(await find(waiting)).toMatchObject({ state: 'withdrawn', by: 'you' });
    const messages = await inbox();
    expect(messages.filter((message) => message.kind === 'notice').map(({ body }) => body)).toEqual(
      [
        'Your message to Builder was withdrawn by you.',
        'Your message to Builder was withdrawn by you.',
      ],
    );
    expect(
      messages.filter((message) => message.replyTo === going && message.kind === 'text'),
    ).toEqual([]);
    // Killed, it is held: what comes next waits.
    const after = await send('builder', 'Anyone there?');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await find(after))?.state).toBe('pending');
  });
});

describe('reads', () => {
  it('pages an agent’s transcript', async () => {
    await keepCanvas();
    await start();
    const id = await send('builder', 'Say hello');
    await vi.waitFor(async () => {
      expect((await find(id))?.state).toBe('replied');
    });
    const first = await ok<{ entries: { id: string; kind: string }[]; next: string | null }>(
      'session.transcript',
      { agent: 'builder', limit: 2 },
    );
    expect(first.entries.map(({ kind }) => kind)).toEqual(['user', 'thinking']);
    const rest = await ok<{ entries: { id: string; kind: string }[]; next: string | null }>(
      'session.transcript',
      { agent: 'builder', after: first.next, limit: 50 },
    );
    expect(rest.entries[0]?.kind).toBe('text');
    expect(rest.entries.at(-1)?.kind).toBe('end');
    const none = await ok<{ entries: unknown[]; next: string | null }>('session.transcript', {
      agent: 'builder',
      after: rest.next,
    });
    expect(none).toEqual({ entries: [], next: rest.next });
  });

  it('ends a page of a transcript early rather than pass its byte budget, cutting an entry too big alone', async () => {
    // A turn that runs the tests (a long output) and writes a big file (a long diff).
    const long: Connector<SessionMode> = {
      start: (_spec, host) => {
        host.emit({ type: 'started', model: 'default', mode: 'auto', models: [] });
        const idle = () => Promise.resolve();
        return Promise.resolve({
          send: (message) => {
            host.emit({ type: 'user', id: message.id, text: message.text });
            host.emit({ type: 'status', status: 'working' });
            host.emit({
              type: 'tool',
              id: 'tests',
              tool: 'Bash',
              summary: 'pnpm test',
              status: 'done',
              // 40,000 characters, but more bytes as JSON.
              detail: { kind: 'output', text: '✓✓✓✓✓✓✓"\n'.repeat(4444) },
            });
            host.emit({
              type: 'tool',
              id: 'write',
              tool: 'Write',
              summary: 'big.ts',
              status: 'done',
              detail: {
                kind: 'diff',
                added: 2000,
                removed: 0,
                lines: Array.from({ length: 2000 }, (_, i) => ({
                  kind: 'add' as const,
                  text: `export const line${String(i)} = "${'x'.repeat(60)}";`,
                })),
              },
            });
            host.emit({ type: 'text', id: 'reply', text: 'Done.' });
            host.emit({
              type: 'end',
              messages: [message.id],
              seconds: 1,
              interrupted: false,
              failed: false,
            });
            return idle();
          },
          answer: idle,
          interrupt: idle,
          setMode: idle,
          setModel: idle,
          close: idle,
        });
      },
    };
    await keepCanvas();
    await start({ appServer: long });
    const id = await send('builder', 'Run the tests and write big.ts');
    await vi.waitFor(async () => {
      expect((await find(id))?.state).toBe('replied');
    });
    interface Page {
      entries: { id: string; kind: string; cut?: true }[];
      next: string | null;
    }
    const bytes = (page: Page) => Buffer.byteLength(JSON.stringify(page.entries));
    const read: Page['entries'] = [];
    let after: string | null = null;
    for (let pages = 0; pages < 10; pages++) {
      const page: Page = await ok<Page>('session.transcript', {
        agent: 'builder',
        ...(after === null ? {} : { after }),
      });
      if (page.entries.length === 0) break;
      expect(bytes(page)).toBeLessThanOrEqual(MAX_PAGE_BYTES);
      read.push(...page.entries);
      after = page.next;
    }
    // Every entry is read, each once; those too big alone are cut, and say so.
    expect(read.map(({ kind }) => kind)).toEqual(['user', 'tool', 'tool', 'text', 'end']);
    expect(read.filter((entry) => entry.cut === true).map(({ id }) => id)).toEqual([
      'tests',
      'write',
    ]);
    // A page asked for more ends before an entry that doesn't fit after another.
    const first = await ok<Page>('session.transcript', { agent: 'builder', limit: 2 });
    expect(first).toEqual({ entries: [read[0]], next: read[0]?.id });
  });

  it('cuts an entry of any kind too big for a page alone to fit one', async () => {
    // A turn with a prompt typed in its terminal holding a pasted log, a long notice, a command
    // given whole (a heredoc), and a long to-do list.
    const big: Connector<SessionMode> = {
      start: (_spec, host) => {
        host.emit({ type: 'started', model: 'default', mode: 'auto', models: [] });
        const idle = () => Promise.resolve();
        return Promise.resolve({
          send: (message) => {
            host.emit({ type: 'user', id: message.id, text: message.text });
            host.emit({ type: 'status', status: 'working' });
            host.emit({ type: 'user', id: 'typed', text: 'a pasted log line\n'.repeat(9000) });
            host.emit({
              type: 'notice',
              id: 'hook',
              level: 'error',
              text: `PreToolUse hook error: ${'"failed"\n'.repeat(12_000)}`,
            });
            host.emit({
              type: 'tool',
              id: 'heredoc',
              tool: 'Bash',
              summary: `cat > notes.txt <<'EOF'\n${'é'.repeat(70_000)}\nEOF`,
              status: 'done',
            });
            host.emit({
              type: 'todos',
              id: 'todos',
              items: Array.from({ length: 5000 }, (_, i) => ({
                text: `Check file ${String(i)}`,
                status: 'pending' as const,
              })),
            });
            host.emit({
              type: 'end',
              messages: [message.id],
              seconds: 1,
              interrupted: false,
              failed: false,
            });
            return idle();
          },
          answer: idle,
          interrupt: idle,
          setMode: idle,
          setModel: idle,
          close: idle,
        });
      },
    };
    await keepCanvas();
    await start({ appServer: big });
    const id = await send('builder', 'Go');
    await vi.waitFor(async () => {
      expect((await find(id))?.state).toBe('replied');
    });
    interface Page {
      entries: { id: string; kind: string; cut?: true }[];
      next: string | null;
    }
    const read: Page['entries'] = [];
    let after: string | null = null;
    for (let pages = 0; pages < 10; pages++) {
      const page: Page = await ok<Page>('session.transcript', {
        agent: 'builder',
        limit: 1,
        ...(after === null ? {} : { after }),
      });
      if (page.entries.length === 0) break;
      expect(Buffer.byteLength(JSON.stringify(page.entries))).toBeLessThanOrEqual(MAX_PAGE_BYTES);
      read.push(...page.entries);
      after = page.next;
    }
    expect(read.map(({ kind }) => kind)).toEqual([
      'user',
      'user',
      'notice',
      'tool',
      'todos',
      'end',
    ]);
    expect(read.filter((entry) => entry.cut === true).map(({ id }) => id)).toEqual([
      'typed',
      'hook',
      'heredoc',
      'todos',
    ]);
    // A text is cut no shorter than its page needs: the prompt fills it.
    expect(Buffer.byteLength(JSON.stringify(read[1]))).toBeGreaterThan(MAX_PAGE_BYTES - 64);
  });

  it('ends a page of messages early rather than pass its byte budget', async () => {
    await keepCanvas();
    await start();
    await ok('run.pause', { target: { agent: 'builder' } }, YOU);
    const ids: string[] = [];
    for (let i = 0; i < 10; i++)
      ids.push(await send('builder', `${String(i)} ${'"'.repeat(16_000)}`));
    const read: string[] = [];
    let after: string | undefined;
    for (let pages = 0; pages < 10 && read.length < ids.length; pages++) {
      const page: { items: Message[]; next: string } = await ok('messages', {
        ...(after === undefined ? {} : { after }),
      });
      expect(Buffer.byteLength(JSON.stringify(page.items))).toBeLessThanOrEqual(MAX_PAGE_BYTES);
      expect(page.items.length).toBeGreaterThan(0);
      read.push(...page.items.filter(({ kind }) => kind === 'text').map(({ id }) => id));
      after = page.next;
    }
    expect(read).toEqual(ids);
  });

  it('shows an MCP server’s link in a transcript only to you', async () => {
    // A turn whose MCP server asks the user to sign in, at a link.
    const signIn: Connector<SessionMode> = {
      start: (_spec, host) => {
        host.emit({ type: 'started', model: 'default', mode: 'auto', models: [] });
        const idle = () => Promise.resolve();
        return Promise.resolve({
          send: (message) => {
            host.emit({ type: 'user', id: message.id, text: message.text });
            host.emit({ type: 'status', status: 'working' });
            host.emit({
              type: 'elicitation',
              id: 'sign-in',
              server: 'tracker',
              message: 'Sign in to the tracker',
              url: 'https://tracker.example/sign-in?code=secret',
            });
            host.emit({ type: 'status', status: 'waiting' });
            return idle();
          },
          answer: idle,
          interrupt: idle,
          setMode: idle,
          setModel: idle,
          close: idle,
        });
      },
    };
    await keepCanvas();
    await start({ appServer: signIn });
    await send('builder', 'Look up the ticket');
    interface Entries {
      entries: { kind: string; url?: string; server?: string }[];
    }
    const shown = async (caller: Caller) =>
      (await ok<Entries>('session.transcript', { agent: 'builder' }, caller)).entries.find(
        ({ kind }) => kind === 'elicitation',
      );
    await vi.waitFor(async () => {
      expect(await shown(YOU)).toMatchObject({
        server: 'tracker',
        url: 'https://tracker.example/sign-in?code=secret',
      });
    });
    for (const caller of [OUTSIDE, READER]) {
      const theirs = await shown(caller);
      expect(theirs).toMatchObject({ server: 'tracker', message: 'Sign in to the tracker' });
      expect(theirs).not.toHaveProperty('url');
    }
  });

  it('gives the catalog to every party', async () => {
    await keepCanvas();
    await start();
    for (const caller of [YOU, OUTSIDE, READER, BUILDER]) {
      const result = await core?.call('catalog.get', {}, caller);
      if (!result?.ok) throw new Error(JSON.stringify(result));
      expect(result.value.adapters.map(({ id }) => id)).toEqual(['claude-code', 'codex']);
    }
  });

  it('asks a token with several canvases to name the one it means, over MCP too', async () => {
    await keepCanvas();
    const started = await start();
    const both: OutsideCaller = { ...OUTSIDE, canvases: [CANVAS, crypto.randomUUID() as CanvasId] };
    // Naming the canvases it may choose from, all within its reach.
    const sentence = `Name the canvas: there is more than one to choose from (${both.canvases.join(', ')}).`;
    for (const [name, args] of [
      ['message', { to: 'builder', body: 'Say hello' }],
      ['agents', {}],
    ] as const) {
      expect(await started.call(name, args, both)).toEqual({
        ok: false,
        error: { code: 'invalid', sentence },
      });
      expect(await callTool(started, both, name, args)).toMatchObject({
        isError: true,
        content: [
          { text: sentence },
          { text: JSON.stringify({ error: { code: 'invalid', sentence } }) },
        ],
      });
    }
    expect(await inbox()).toEqual([]);
    // Named, it goes.
    await ok('run.pause', { target: { agent: 'builder' } }, YOU);
    const id = await send('builder', 'Say hello', both);
    // `withdraw` names no canvas: the message it names says which, if the caller sent or got it.
    const builders = await send('helper', 'Hello', BUILDER);
    expect(await started.call('withdraw', { id: builders }, both)).toEqual({
      ok: false,
      error: { code: 'invalid', sentence },
    });
    expect(await started.call('withdraw', { id }, both)).toEqual({ ok: true, value: {} });
    expect(await find(id)).toMatchObject({ state: 'withdrawn' });
  });

  it('pages a party’s messages from a cursor, and keeps those with one party', async () => {
    await keepCanvas();
    await start();
    await ok('run.pause', { target: { agent: 'builder' } }, YOU);
    await ok('run.pause', { target: { agent: 'helper' } }, YOU);
    const toBuilder = [await send('builder', 'One'), await send('builder', 'Two')];
    const toHelper = await send('helper', 'Three');
    const texts = async (args: Record<string, unknown>) =>
      (await ok<{ items: Message[]; next: string }>('messages', args)).items
        .filter(({ kind }) => kind === 'text')
        .map(({ id }) => id);
    const first = await ok<{ items: Message[]; next: string }>('messages', { limit: 1 });
    expect(first.items.map(({ id }) => id)).toEqual([toBuilder[0]]);
    const rest = await texts({ after: first.next });
    expect(rest).toEqual([toBuilder[1], toHelper]);
    expect(await texts({ with: 'agent:helper' })).toEqual([toHelper]);
    // Read from where the last page ended, nothing is read again.
    const all = await ok<{ items: Message[]; next: string }>('messages', {});
    expect((await ok<{ items: Message[] }>('messages', { after: all.next })).items).toEqual([]);
  });

  it('says how each agent is, the message its turn is on, and what waits for you', async () => {
    await keepCanvas();
    await start();
    await ok('run.pause', { target: { agent: 'helper' } }, YOU);
    interface Status {
      agents: { id: string; state: string; message: string | null }[];
      waitingForYou: NeedsItem[];
      next: string;
    }
    const before: Status = await ok('status', {});
    // Checker, in Read only, asks before it acts.
    const id = await send('checker', 'Run the tests');
    await vi.waitFor(async () => {
      expect((await ok<Status>('status', {})).waitingForYou).toHaveLength(1);
    });
    const now: Status = await ok('status', {});
    expect(now.agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'checker', state: 'waiting', message: id }),
        expect.objectContaining({ id: 'helper', state: 'paused', message: null }),
        expect.objectContaining({ id: 'builder', state: 'idle', message: null }),
      ]),
    );
    expect(now.waitingForYou).toEqual([
      expect.objectContaining({ kind: 'prompt', agent: 'checker', choices: [] }),
    ]);
    // Its cursor is at the end: what came since is after it.
    const since = await ok<{ items: Message[] }>('messages', { after: before.next });
    expect(since.items.map((message) => message.id)).toContain(id);
    expect((await ok<{ items: Message[] }>('messages', { after: now.next })).items).toEqual([]);
  });

  it('says whether an agent is paused, and what it replied last', async () => {
    await keepCanvas();
    await start();
    const id = await send('builder', 'Say hello');
    await vi.waitFor(async () => {
      expect((await find(id))?.state).toBe('replied');
    });
    await ok('run.pause', { target: { agent: 'builder' } }, YOU);
    expect(await ok('session.get', { agent: 'builder' })).toMatchObject({
      paused: true,
      status: 'idle',
      reply: `You said: ${FRAME(id)}Say hello`,
    });
  });

  it('refuses a transcript cursor it doesn’t know, and counts a message’s images', async () => {
    await keepCanvas();
    const engine = await (await start()).engines.open(CANVAS);
    engine.sessions.send('builder', 'codex', 'Look', undefined, [
      { mediaType: 'image/png', data: 'iVBORw0KGgo=' },
      { mediaType: 'image/png', data: 'iVBORw0KGgo=' },
    ]);
    await vi.waitFor(() => {
      expect(engine.sessions.of('builder').status).toBe('idle');
      expect(engine.sessions.of('builder').entries.some(({ kind }) => kind === 'end')).toBe(true);
    });
    const { entries } = await ok<{ entries: { kind: string; images?: number }[] }>(
      'session.transcript',
      { agent: 'builder' },
    );
    expect(entries[0]).toMatchObject({ kind: 'user', images: 2 });
    expect(
      await core?.call(
        'session.transcript',
        { canvas: CANVAS, agent: 'builder', after: 'no-such-entry' },
        OUTSIDE,
      ),
    ).toMatchObject({ ok: false, error: { code: 'not-found' } });
  });

  it('refuses a reply to a message there isn’t, from you too', async () => {
    await keepCanvas();
    await start();
    for (const caller of [OUTSIDE, YOU]) {
      expect(
        await core?.call(
          'message',
          { canvas: CANVAS, to: 'builder', body: 'About that', replyTo: crypto.randomUUID() },
          caller,
        ),
      ).toMatchObject({ ok: false, error: { code: 'not-found' } });
    }
    expect(await inbox(YOU)).toEqual([]);
  });

  it('lists the agents each caller reaches, and their state', async () => {
    await keepCanvas();
    await start();
    const { agents } = await ok<{ agents: { id: string; linked: string[]; state: string }[] }>(
      'agents',
      {},
      BUILDER,
    );
    expect(agents.map(({ id }) => id)).toEqual(['builder', 'helper', 'checker']);
    expect(agents[0]).toMatchObject({ linked: ['helper', 'checker'], state: 'idle' });
  });
});
