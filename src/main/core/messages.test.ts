import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_MESSAGE_BYTES } from '../../shared/api/limits';
import type { Message } from '../../shared/model/messages';
import { withoutChoices } from '../../shared/engine/needs';
import type { NeedsItem } from '../../shared/model/needs';
import type { SessionMode } from '../../shared/session';
import type { Connector } from '../sessions/connector';
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
  await rm(profile, { recursive: true, force: true });
});

/** A profile keeping a canvas of `agents`, as the app would once its folder was picked. */
async function keepCanvas(agents = AGENTS, links = LINKS): Promise<void> {
  const file = path.join(profile, 'canvas.corral');
  await writeFile(
    file,
    JSON.stringify({
      format: 'corrallm',
      version: 2,
      id: CANVAS,
      nodes: agents.map(({ id, label, connection, settings, queue }, i) => ({
        id,
        kind: 'agent',
        label,
        position: { x: 0, y: i * 100 },
        adapter: 'codex',
        connection,
        ...(settings ? { settings } : {}),
        ...(queue ? { queue } : {}),
      })),
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
  return (await ok<{ items: Message[] }>('messages', {}, caller)).items;
}

/** A message `caller` sent, as it is now. */
async function find(id: string, caller: Caller = OUTSIDE): Promise<Message | undefined> {
  return (await inbox(caller)).find((message) => message.id === id);
}

/** What `caller` sends `to`: its id. */
async function send(to: string, body: string, caller: Caller = OUTSIDE): Promise<string> {
  return (await ok<{ id: string }>('message', { to, body }, caller)).id;
}

/** The text the agent's session was sent, each turn. */
function sent(connector: FakeConnector): string[] {
  return connector.sessions.flatMap((session) => session.sent.map(({ text }) => text));
}

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
    const refusing: Connector<SessionMode> = {
      start: (spec, host) => {
        if (!refuse) return appServer.start(spec, host);
        host.emit({
          type: 'notice',
          id: crypto.randomUUID(),
          level: 'error',
          text: 'This login can’t run here.',
          switchTo: 'codex.terminal',
        });
        return Promise.reject(new Error('This login can’t run here.'));
      },
    };
    await start({ appServer: refusing });
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
    await send('builder', 'x'.repeat(MAX_MESSAGE_BYTES));
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
    // A party names only its own messages.
    const builders = await send('helper', 'Hello', BUILDER);
    expect(await core?.call('withdraw', { canvas: CANVAS, id: builders }, OUTSIDE)).toMatchObject({
      ok: false,
      error: { code: 'not-found' },
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

describe('the shell prefix', () => {
  it('refuses a token’s body a Terminal agent would run as a shell command, naming the prefix', async () => {
    await keepCanvas();
    await start();
    expect(
      await core?.call('message', { canvas: CANVAS, to: 'shell', body: '!ls' }, OUTSIDE),
    ).toEqual({
      ok: false,
      error: {
        code: 'refused',
        sentence:
          'It starts with "!", which Codex · Terminal runs as a shell command without asking: only you may send that.',
      },
    });
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
  async function overRule(action: string, resetsAt: number): Promise<void> {
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

  it('never holds what you send', async () => {
    await overRule('waitForReset', Date.now() + 60_000);
    await keepCanvas();
    await start();
    const id = await send('builder', 'Go ahead', YOU);
    await vi.waitFor(async () => {
      expect((await find(id, YOU))?.state).toBe('replied');
    });
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

  it('gives the catalog to every party', async () => {
    await keepCanvas();
    await start();
    for (const caller of [YOU, OUTSIDE, READER, BUILDER]) {
      const result = await core?.call('catalog.get', {}, caller);
      if (!result?.ok) throw new Error(JSON.stringify(result));
      expect(result.value.adapters.map(({ id }) => id)).toEqual(['claude-code', 'codex']);
    }
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
