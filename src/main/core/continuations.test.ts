import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OpResult } from '../../shared/api/errors';
import type { Message } from '../../shared/model/messages';
import type { NeedsItem } from '../../shared/model/needs';
import type { SessionMode, TurnResult, UserMessage } from '../../shared/session';
import type { Connector, SessionHost } from '../sessions/connector';
import { fakeConnector } from '../sessions/test-fake';
import type { AgentCaller, Caller, OutsideCaller } from './caller';
import { createCore } from './core';
import type { Core } from './core';
import { mailboxTasks } from './delivery/tasks';
import { expectRestorable, liveRunOf } from './engine/run/test-restore';
import { keepCanvases, readOnDisk, writeOnDisk } from './store/test-store';
import { CALLERS, CANVAS, NO_DESKTOP } from './test-registry';
import { legacyDirectories } from './workspaces/test-directories';

/*
 * B21 C5 (Design §9.2 C7, C8) through the whole core: an ask made during a step's own turn belongs
 * to its task; the step's turn that ends with it open isn't judged; its settlement goes back first
 * in line as the attempt's own turn, which judges it; Stop withdraws its asks; a restart keeps a
 * waiting task waiting, and holds uncertain one whose answer had reached its agent; and `complete`
 * reports the caller's own step, fixed at once and applied at its turn's end.
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
const PLANNER = agentCaller('planner');
const BUILDER = agentCaller('builder');
const COMPLETED: TurnResult = { status: 'completed', reason: 'completed' };
const QUESTION = {
  id: 'scope',
  header: 'Scope',
  text: 'How much of it?',
  options: [{ label: 'All' }, { label: 'Some' }],
  multiple: false,
  other: true,
};

let profile: string;
const cores: Core[] = [];

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-continuations-'));
});

afterEach(async () => {
  expectRestorable();
  vi.restoreAllMocks();
  for (const core of cores.splice(0)) await core.close().catch(() => undefined);
  await rm(profile, { recursive: true, force: true });
});

/**
 * A profile keeping a canvas of Planner, whose queue is a tool step and then a message, and
 * Builder, linked to it, on Codex's App Server.
 */
async function keepCanvas(queue: unknown[] = [BUILD, SHIP]): Promise<void> {
  const project = path.join(profile, 'project');
  await mkdir(project);
  const file = path.join(profile, 'canvas.corral');
  await writeFile(
    file,
    JSON.stringify({
      format: 'corrallm',
      version: 2,
      id: CANVAS,
      nodes: ['planner', 'builder'].map((id, i) => ({
        id,
        kind: 'agent',
        label: id.charAt(0).toUpperCase() + id.slice(1),
        position: { x: 0, y: i * 100 },
        adapter: 'codex',
        connection: 'codex.app-server',
        ...(id === 'planner' ? { queue } : {}),
      })),
      links: [{ agents: ['planner', 'builder'] }],
    }),
  );
  await keepCanvases(profile, { [CANVAS]: { file, project } });
}
const BUILD = { id: 'build', action: 'exec_command', instruction: 'Build it' };
const SHIP = { id: 'ship', message: 'Ship it' };

/** A connector whose turns the test ends: what each agent's sessions were sent, and `reply`. */
function driven() {
  const fake = fakeConnector({ adapter: 'codex', mode: 'auto' });
  const to = new Map<string, { host: SessionHost; sent: UserMessage[] }>();
  const connector: Connector<SessionMode> = {
    start: async (spec, given) => {
      const mine = { host: given, sent: to.get(spec.agentId)?.sent ?? [] };
      to.set(spec.agentId, mine);
      const session = await fake.start(spec, given);
      session.send = (message) => {
        mine.sent.push(message);
        given.emit({ type: 'user', id: message.id, text: message.text });
        given.emit({ type: 'status', status: 'working' });
        return Promise.resolve();
      };
      // An interrupt ends the turn going on, cancelled.
      session.interrupt = () => {
        const last = mine.sent.at(-1);
        if (last !== undefined)
          given.emit({
            type: 'end',
            messages: [last.id],
            seconds: 1,
            result: { status: 'cancelled', reason: 'interrupted' },
          });
        return Promise.resolve();
      };
      return session;
    },
  };
  return {
    connector,
    /** What `agent`'s sessions were sent, in order. */
    sentTo: (agent: string) => to.get(agent)?.sent ?? [],
    /** Ends the turn of the last thing sent `agent`, having replied `text`. */
    reply: (agent: string, text: string, result: TurnResult = COMPLETED) => {
      const mine = to.get(agent);
      const last = mine?.sent.at(-1);
      if (mine === undefined || last === undefined) throw new Error(`Nothing was sent ${agent}.`);
      if (text !== '') mine.host.emit({ type: 'text', id: randomUUID(), text });
      mine.host.emit({ type: 'end', messages: [last.id], seconds: 1, result });
    },
  };
}

async function start(connector: Connector<SessionMode>): Promise<Core> {
  const core = await createCore(
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
        connectors: { 'codex.app-server': connector },
        environment: () => Promise.resolve({}),
      },
      watchFolder: () => ({ close: () => undefined }),
    },
    NO_DESKTOP,
  );
  cores.push(core);
  const engine = await core.engines.open(CANVAS);
  const open = core.engines.canvas(CANVAS);
  if (open === undefined) throw new Error('No open canvas.');
  liveRunOf(engine.run, engine.catalog, () => Date.now(), mailboxTasks(open.messages));
  engine.run.update(open.document.nodes);
  return core;
}

async function restart(connector: Connector<SessionMode>): Promise<Core> {
  for (const core of cores.splice(0)) await core.close();
  return start(connector);
}

function call(core: Core, name: string, args: Record<string, unknown>, caller: Caller) {
  return core.call(name as never, { canvas: CANVAS, ...args }, caller) as Promise<
    OpResult<unknown>
  >;
}

async function ok<T = Record<string, unknown>>(
  core: Core,
  name: string,
  args: Record<string, unknown>,
  caller: Caller,
): Promise<T> {
  const result = await call(core, name, args, caller);
  if (!result.ok) throw new Error(`${name} failed: ${JSON.stringify(result)}`);
  return result.value as T;
}

/** Every message on the canvas, as you read them. */
function messagesOf(core: Core): Message[] {
  return core.engines.canvas(CANVAS)?.messages.all() ?? [];
}
const messageOf = (core: Core, id: string) => messagesOf(core).find((one) => one.id === id);

async function needsOf(core: Core): Promise<NeedsItem[]> {
  return (await ok<{ items: NeedsItem[] }>(core, 'needs', {}, YOU)).items;
}

/** Planner's run, as its engine has it. */
const planner = (core: Core) => core.engines.canvas(CANVAS)?.engine.run.snapshot().agents.planner;
/** Planner's current task's last attempt's id. */
const attemptOf = (core: Core, item = 'build') => planner(core)?.attempts?.[item]?.at(-1)?.id ?? '';

const ask = async (core: Core, to: unknown, caller: Caller) =>
  (await ok<{ id: string }>(core, 'ask', { to, questions: [QUESTION] }, caller)).id;

/** Starts the run, as you, and waits for Planner's step to reach its session. */
async function run(core: Core, cli: ReturnType<typeof driven>): Promise<void> {
  await ok(core, 'run.start', {}, YOU);
  await vi.waitFor(() => {
    expect(cli.sentTo('planner')).toHaveLength(1);
  });
}

describe('an ask during a task (C7)', () => {
  it('belongs to the step’s attempt when made in its own turn, and to none made in any other', async () => {
    await keepCanvas();
    const cli = driven();
    const core = await start(cli.connector);
    // Before any run: Builder's ask is taskless.
    const taskless = await ask(core, 'planner', BUILDER);
    expect(messageOf(core, taskless)?.ask).not.toHaveProperty('task');
    await run(core, cli);
    const asked = await ask(core, { party: 'you' }, PLANNER);
    expect(messageOf(core, asked)?.ask).toMatchObject({
      type: 'question',
      task: { owner: 'planner', item: 'build', attempt: attemptOf(core) },
    });
    // Its task is on disk with it.
    const row = readOnDisk(profile, (disk) =>
      disk.prepare('SELECT ask FROM message WHERE id = ?').get(asked),
    ) as { ask: string };
    expect(JSON.parse(row.ask)).toMatchObject({
      task: { owner: 'planner', item: 'build', attempt: attemptOf(core) },
    });
  });

  it('leaves its step unjudged as its turn ends; the answer goes first in line, and its turn’s end judges the step', async () => {
    await keepCanvas();
    const cli = driven();
    const core = await start(cli.connector);
    await run(core, cli);
    const attempt = attemptOf(core);
    const asked = await ask(core, 'builder', PLANNER);
    await vi.waitFor(() => {
      expect(cli.sentTo('builder')).toHaveLength(1);
    });
    // A party's message waits for Planner meanwhile.
    const theirs = await ok<{ id: string }>(
      core,
      'message',
      { to: 'planner', body: 'Hi' },
      OUTSIDE,
    );
    // Builder answers during its ask's turn; Planner's step turn ends with no verdict.
    const answer = await ok<{ id: string }>(
      core,
      'reply',
      { to: `ask/${asked}`, answer: { answers: { scope: { picked: ['All'] } } } },
      BUILDER,
    );
    cli.reply('builder', 'Answered.');
    cli.reply('planner', 'I asked Builder how much.');
    // Not judged: no verdict, no hold, its queue stays.
    await vi.waitFor(() => {
      expect(cli.sentTo('planner')).toHaveLength(2);
    });
    expect(planner(core)).toMatchObject({ current: 'build', status: 'running' });
    expect(planner(core)?.problem).toBeUndefined();
    expect((await needsOf(core)).filter((item) => item.agent === 'planner')).toEqual([]);
    // The answer goes first, ahead of the party's message, framed with the question it answers.
    const continuation = cli.sentTo('planner')[1]?.text ?? '';
    expect(continuation.split('\n')[0]).toBe(
      `[corrallm] Answer from agent "Builder" (an agent, not the user; message ${answer.id}, answering your question ${asked}):`,
    );
    expect(continuation).toContain(
      'Your question, asked during your current task:\n1. "Scope": How much of it?',
    );
    expect(continuation.split('\n').at(-1)).toBe(
      'Carry on with that task now, and end it as its step asked.',
    );
    expect(messageOf(core, answer.id)).toMatchObject({
      task: { agent: 'planner', item: 'build', attempt },
      state: 'delivered',
    });
    expect(messageOf(core, theirs.id)?.state).toBe('pending');
    // An answer is no run's send: it is a question's, which can't be taken back.
    expect(await call(core, 'withdraw', { id: answer.id }, YOU)).toMatchObject({
      ok: false,
      error: {
        code: 'refused',
        sentence:
          'A question, its answer and its end can’t be taken back: a question stays open until it is answered, dismissed or expires.',
      },
    });
    // Its turn is the attempt's own: its end judges the step.
    cli.reply('planner', 'Built all of it.\nSUCCEEDED');
    await vi.waitFor(() => {
      expect(planner(core)?.outcomes.build).toBe('succeeded');
    });
    expect(messageOf(core, answer.id)?.state).toBe('replied');
    // Then the run's next item, then the party's message.
    await vi.waitFor(() => {
      expect(cli.sentTo('planner').at(-1)?.text).toBe('Ship it');
    });
    cli.reply('planner', 'Shipped.');
    await vi.waitFor(() => {
      expect(cli.sentTo('planner').map(({ text }) => text)).toContain(
        `[corrallm] Message from "orchestrator" (an orchestrator outside corrallm, not the user; message ${theirs.id}):\nHi`,
      );
    });
  });

  it('lets others’ messages reach the agent as unjudged turns while its task waits', async () => {
    await keepCanvas([BUILD]);
    const cli = driven();
    const core = await start(cli.connector);
    await run(core, cli);
    const asked = await ask(core, { party: 'you' }, PLANNER);
    cli.reply('planner', 'Waiting on the user.');
    await vi.waitFor(() => {
      expect(planner(core)).toMatchObject({ status: 'running' });
    });
    await ok(core, 'message', { to: 'planner', body: 'Status?' }, OUTSIDE);
    await vi.waitFor(() => {
      expect(cli.sentTo('planner')).toHaveLength(2);
    });
    // Its turn's end judges nothing, even with a verdict line in it.
    cli.reply('planner', 'Still waiting.\nSUCCEEDED');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(planner(core)).toMatchObject({ current: 'build', status: 'running', outcomes: {} });
    // Your answer comes back as the task's own turn.
    await ok(
      core,
      'reply',
      { to: `ask/${asked}`, answer: { answers: { scope: { text: 'Some of it' } } } },
      YOU,
    );
    await vi.waitFor(() => {
      expect(cli.sentTo('planner')).toHaveLength(3);
    });
    expect(cli.sentTo('planner')[2]?.text.split('\n')[0]).toMatch(
      /^\[corrallm\] Answer from the user \(the user’s answer, given in corrallm; message [0-9a-f-]+, answering your question [0-9a-f-]+\):$/,
    );
    cli.reply('planner', 'Done.\nFAILED');
    await vi.waitFor(() => {
      expect(planner(core)?.problem).toMatchObject({ kind: 'failed', reason: 'task-failed' });
    });
  });

  it('withdraws a stopped task’s asks (its recipient told with its next message) and its answers to come', async () => {
    await keepCanvas([BUILD]);
    const cli = driven();
    const core = await start(cli.connector);
    await run(core, cli);
    const toBuilder = await ask(core, 'builder', PLANNER);
    const toYou = await ask(core, { party: 'you' }, PLANNER);
    await vi.waitFor(() => {
      expect(cli.sentTo('builder')).toHaveLength(1);
    });
    cli.reply('planner', 'Asked both.');
    await vi.waitFor(() => {
      expect(planner(core)).toMatchObject({ status: 'running' });
    });
    await ok(core, 'run.stop', {}, YOU);
    await vi.waitFor(() => {
      expect(messageOf(core, toYou)?.settled).toBeDefined();
    });
    for (const id of [toBuilder, toYou]) {
      expect(messageOf(core, id)).toMatchObject({
        state: 'withdrawn',
        settled: { outcome: { type: 'withdrawn', why: 'stopped' } },
      });
    }
    expect((await needsOf(core)).map(({ id }) => id)).not.toContain(`ask/${toYou}`);
    // Nothing goes back to Planner: its task stopped.
    expect(
      messagesOf(core).filter((one) => one.to === 'agent:planner' && one.replyTo === toBuilder),
    ).toEqual([]);
    // Builder, answering already, isn't interrupted; a late answer is refused: yours saying why, a
    // token's not found, as every ended item is out of its reach.
    const late = { to: `ask/${toBuilder}`, answer: { answers: { scope: { picked: ['All'] } } } };
    expect(await call(core, 'reply', late, YOU)).toMatchObject({
      ok: false,
      error: {
        code: 'conflict',
        sentence: `ask/${toBuilder} was withdrawn: its task was stopped.`,
      },
    });
    expect(await call(core, 'reply', late, BUILDER)).toMatchObject({
      ok: false,
      error: { code: 'not-found' },
    });
    cli.reply('builder', 'All of it.');
    // Builder's next message carries the note.
    await ok(core, 'message', { to: 'builder', body: 'Next' }, OUTSIDE);
    await vi.waitFor(() => {
      expect(cli.sentTo('builder')).toHaveLength(2);
    });
    expect(cli.sentTo('builder')[1]?.text).toContain(
      `Question ${toBuilder} from "Planner" was withdrawn after it reached you: its task was stopped. Do not answer it. Anything already done is left as it is.`,
    );
  });

  it('takes back a stopped task’s answer being delivered, its turn interrupted, telling no one', async () => {
    await keepCanvas([BUILD]);
    const cli = driven();
    const core = await start(cli.connector);
    await run(core, cli);
    const asked = await ask(core, { party: 'you' }, PLANNER);
    cli.reply('planner', 'Asked the user.');
    await vi.waitFor(() => {
      expect(planner(core)).toMatchObject({ status: 'running' });
    });
    const { id: answer } = await ok<{ id: string }>(
      core,
      'reply',
      { to: `ask/${asked}`, answer: { answers: { scope: { picked: ['All'] } } } },
      YOU,
    );
    await vi.waitFor(() => {
      expect(cli.sentTo('planner')).toHaveLength(2);
    });
    await ok(core, 'run.stop', {}, YOU);
    await vi.waitFor(() => {
      expect(messageOf(core, answer)).toMatchObject({ state: 'withdrawn', by: 'corrallm' });
    });
    expect(planner(core)?.problem).toMatchObject({ kind: 'cancelled' });
    expect(
      messagesOf(core).filter((one) => one.kind === 'notice' && one.replyTo === answer),
    ).toEqual([]);
    // No note of it waits for Planner's next message.
    expect(core.engines.canvas(CANVAS)?.messages.withdrawals('agent:planner')).toEqual([]);
  });

  it('keeps a waiting task waiting across a restart, and sends its answer once the run is resumed', async () => {
    await keepCanvas([BUILD]);
    const cli = driven();
    let core = await start(cli.connector);
    await run(core, cli);
    const attempt = attemptOf(core);
    const asked = await ask(core, { party: 'you' }, PLANNER);
    cli.reply('planner', 'Asked the user.');
    await vi.waitFor(() => {
      expect(planner(core)).toMatchObject({ status: 'running' });
    });
    core = await restart(cli.connector);
    // Restored paused, waiting: no uncertain turn, its attempt running.
    expect(planner(core)).toMatchObject({ current: 'build', status: 'running' });
    expect(planner(core)?.problem).toBeUndefined();
    expect(attemptOf(core)).toBe(attempt);
    expect((await needsOf(core)).map(({ id }) => id)).toContain(`ask/${asked}`);
    // Answered while the run is paused, its answer waits for the run.
    await ok(
      core,
      'reply',
      { to: `ask/${asked}`, answer: { answers: { scope: { picked: ['All'] } } } },
      YOU,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(cli.sentTo('planner')).toHaveLength(1);
    await ok(core, 'run.resume', {}, YOU);
    await vi.waitFor(() => {
      expect(cli.sentTo('planner')).toHaveLength(2);
    });
    cli.reply('planner', 'Done.\nSUCCEEDED');
    await vi.waitFor(() => {
      expect(planner(core)?.outcomes.build).toBe('succeeded');
    });
  });

  it('holds uncertain, never resent, a task whose answer was being delivered as corrallm stopped', async () => {
    await keepCanvas([BUILD]);
    const cli = driven();
    let core = await start(cli.connector);
    await run(core, cli);
    const asked = await ask(core, { party: 'you' }, PLANNER);
    cli.reply('planner', 'Asked the user.');
    await vi.waitFor(() => {
      expect(planner(core)).toMatchObject({ status: 'running' });
    });
    const { id: answer } = await ok<{ id: string }>(
      core,
      'reply',
      { to: `ask/${asked}`, answer: { answers: { scope: { picked: ['All'] } } } },
      YOU,
    );
    await vi.waitFor(() => {
      expect(cli.sentTo('planner')).toHaveLength(2);
    });
    core = await restart(cli.connector);
    expect(planner(core)?.problem).toMatchObject({ kind: 'uncertain' });
    expect(planner(core)?.problem?.text).toContain(
      'An answer to a question it asked had reached the agent.',
    );
    expect(messageOf(core, answer)?.state).toBe('unresolved');
    // Its answerer is told nothing of it cut off: the run holds the task, as for its own sends.
    expect(
      messagesOf(core).filter((one) => one.kind === 'notice' && one.replyTo === answer),
    ).toEqual([]);
    await ok(core, 'run.resume', {}, YOU);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(cli.sentTo('planner')).toHaveLength(2);
  });

  it.each(['last line', 'complete'])(
    'waits unjudged while the loop breaker holds its answer, then judges by %s after you let the pair go on (B21 C6)',
    async (verdict) => {
      await keepCanvas([BUILD]);
      // Planner and Builder have passed nine turns between them since you last spoke to either.
      writeOnDisk(
        profile,
        `INSERT INTO loop_pair (canvas_id, a, b, turns) VALUES ('${CANVAS}', 'builder', 'planner', 9)`,
      );
      const cli = driven();
      const core = await start(cli.connector);
      await run(core, cli);
      const attempt = attemptOf(core);
      // The step's ask is the tenth turn between them.
      const asked = await ask(core, 'builder', PLANNER);
      await vi.waitFor(() => {
        expect(cli.sentTo('builder')).toHaveLength(1);
      });
      cli.reply('planner', 'I asked Builder how much.');
      const answer = await ok<{ id: string }>(
        core,
        'reply',
        { to: `ask/${asked}`, answer: { answers: { scope: { picked: ['All'] } } } },
        BUILDER,
      );
      cli.reply('builder', 'Answered.');
      // Its answer, the eleventh, waits for you, and the task with it: unjudged, still running.
      await vi.waitFor(async () => {
        expect((await needsOf(core)).map(({ id }) => id)).toContain('loop/builder/planner');
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(cli.sentTo('planner')).toHaveLength(1);
      expect(messageOf(core, answer.id)).toMatchObject({
        state: 'pending',
        task: { agent: 'planner', item: 'build', attempt },
      });
      expect(planner(core)).toMatchObject({ current: 'build', status: 'running' });
      expect(planner(core)?.problem).toBeUndefined();
      // Go on: the answer goes as the attempt's own turn, whose end judges the step.
      await ok(core, 'reply', { to: 'loop/builder/planner', answer: { choice: 'goOn' } }, YOU);
      await vi.waitFor(() => {
        expect(cli.sentTo('planner')).toHaveLength(2);
      });
      expect(cli.sentTo('planner')[1]?.text.split('\n')[0]).toBe(
        `[corrallm] Answer from agent "Builder" (an agent, not the user; message ${answer.id}, answering your question ${asked}):`,
      );
      if (verdict === 'complete') {
        await ok(
          core,
          'complete',
          { task: attempt, outcome: 'succeeded', summary: 'Built all of it.' },
          PLANNER,
        );
      }
      cli.reply('planner', 'Built all of it.\nSUCCEEDED');
      await vi.waitFor(() => {
        expect(planner(core)?.outcomes.build).toBe('succeeded');
      });
      expect(
        readOnDisk(profile, (disk) => disk.prepare('SELECT a, b, turns FROM loop_pair').all()),
      ).toEqual([{ a: 'builder', b: 'planner', turns: 1 }]);
    },
  );
});

describe('complete (C8)', () => {
  it.each(['step', 'continuation'])(
    'applies a live report at the %s turn’s native end after later traffic exceeds retention',
    async (turn) => {
      await keepCanvas([BUILD]);
      const cli = driven();
      const core = await start(cli.connector);
      await run(core, cli);
      if (turn === 'continuation') {
        const asked = await ask(core, { party: 'you' }, PLANNER);
        cli.reply('planner', 'Asked the user.');
        await ok(
          core,
          'reply',
          { to: `ask/${asked}`, answer: { answers: { scope: { picked: ['All'] } } } },
          YOU,
        );
        await vi.waitFor(() => {
          expect(cli.sentTo('planner')).toHaveLength(2);
        });
      }
      await ok(
        core,
        'complete',
        { task: attemptOf(core), outcome: 'succeeded', summary: 'Done.' },
        PLANNER,
      );
      const store = core.engines.canvas(CANVAS)?.messages;
      if (store === undefined) throw new Error('No open canvas.');
      for (let n = 0; n < 450; n++)
        store.add({
          from: 'agent:planner',
          to: 'corrallm',
          kind: 'notice',
          origin: 'party',
          body: 'Later notice',
          state: 'delivered',
        });
      await store.durable();
      cli.reply('planner', 'Done.');
      await vi.waitFor(() => {
        expect(planner(core)?.outcomes.build).toBe('succeeded');
      });
    },
  );

  it('keeps the reported outcome fixed when another ask is attempted before native end', async () => {
    await keepCanvas([BUILD]);
    const cli = driven();
    const core = await start(cli.connector);
    await run(core, cli);
    await ok(
      core,
      'complete',
      { task: attemptOf(core), outcome: 'succeeded', summary: 'Done.' },
      PLANNER,
    );
    expect(
      await call(core, 'ask', { to: { party: 'you' }, questions: [QUESTION] }, PLANNER),
    ).toMatchObject({
      ok: false,
      error: { code: 'conflict' },
    });
    expect(messagesOf(core).filter((message) => message.ask?.type === 'question')).toEqual([]);
    cli.reply('planner', 'Done.');
    await vi.waitFor(() => {
      expect(planner(core)?.outcomes.build).toBe('succeeded');
    });
  });

  it('keeps a live report through retention and restart, then prunes it once its turn settles', async () => {
    await keepCanvas([BUILD]);
    const cli = driven();
    let core = await start(cli.connector);
    await run(core, cli);
    const task = attemptOf(core);
    await ok(core, 'complete', { task, outcome: 'failed', summary: 'Two tests fail.' }, PLANNER);
    const result = messagesOf(core).find((message) => message.kind === 'result');
    if (result?.replyTo === undefined) throw new Error('No report of a native turn.');
    const mailbox = () => {
      const store = core.engines.canvas(CANVAS)?.messages;
      if (store === undefined) throw new Error('No open canvas.');
      return store;
    };
    const later = async () => {
      const store = mailbox();
      for (let n = 0; n < 450; n++)
        store.add({
          from: 'agent:planner',
          to: 'corrallm',
          kind: 'notice',
          origin: 'party',
          body: 'Later notice',
          state: 'delivered',
        });
      await store.durable();
    };
    await later();
    expect(
      await call(core, 'complete', { task, outcome: 'succeeded', summary: 'Second.' }, PLANNER),
    ).toMatchObject({
      ok: false,
      error: { code: 'conflict' },
    });
    core = await restart(cli.connector);
    expect(planner(core)?.problem?.text).toContain('The agent had reported this step failed.');
    await later();
    expect(messageOf(core, result.id)?.verdict?.outcome).toBe('failed');
    mailbox().update(result.replyTo, { state: 'replied' });
    await later();
    expect(messageOf(core, result.id)).toBeUndefined();
  });

  it('reports only the caller’s own tool step, in its own turn, once', async () => {
    await keepCanvas();
    const cli = driven();
    const core = await start(cli.connector);
    const report = (task: string, caller: Caller, more: Record<string, unknown> = {}) =>
      call(core, 'complete', { task, outcome: 'succeeded', summary: 'Built it.', ...more }, caller);
    // No run, no attempt.
    expect(await report(randomUUID(), PLANNER)).toMatchObject({
      ok: false,
      error: { code: 'not-found' },
    });
    await run(core, cli);
    const attempt = attemptOf(core);
    // Another agent's attempt, an unknown one, an outside token, you: never.
    expect(await report(attempt, BUILDER)).toMatchObject({
      ok: false,
      error: { code: 'not-found' },
    });
    expect(await report(randomUUID(), PLANNER)).toMatchObject({
      ok: false,
      error: { code: 'not-found' },
    });
    expect(await report(attempt, OUTSIDE)).toMatchObject({
      ok: false,
      error: { code: 'forbidden' },
    });
    expect(await report(attempt, YOU)).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    // A summary that says nothing.
    expect(await report(attempt, PLANNER, { summary: ' \n' })).toMatchObject({
      ok: false,
      error: { code: 'invalid' },
    });
    const request = randomUUID();
    const first = await report(attempt, PLANNER, { request });
    expect(first).toMatchObject({ ok: true, value: { revs: expect.any(Object) as object } });
    // On disk before it returned: a result record, from Planner to corrallm, replying to its turn.
    const step = cli.sentTo('planner')[0]?.id;
    const row = readOnDisk(profile, (disk) =>
      disk
        .prepare(
          "SELECT from_party, to_party, kind, reply_to, task, verdict FROM message WHERE kind = 'result'",
        )
        .get(),
    ) as Record<string, string>;
    expect(row).toMatchObject({
      from_party: 'agent:planner',
      to_party: 'corrallm',
      kind: 'result',
      reply_to: step,
    });
    expect(JSON.parse(row.task ?? '')).toEqual({ agent: 'planner', item: 'build', attempt });
    expect(JSON.parse(row.verdict ?? '')).toEqual({
      v: 1,
      outcome: 'succeeded',
      summary: 'Built it.',
    });
    // The same request is the first result; another is a conflict.
    expect(await report(attempt, PLANNER, { request })).toEqual(first);
    expect(await report(attempt, PLANNER, { outcome: 'failed' })).toEqual({
      ok: false,
      error: { code: 'conflict', sentence: 'This step was already reported succeeded.' },
    });
    // Applied at its turn's end: no last line needed.
    cli.reply('planner', 'Built.');
    await vi.waitFor(() => {
      expect(planner(core)?.outcomes.build).toBe('succeeded');
    });
    // Ended, it is no one's to report; nor is a message item's turn.
    expect(await report(attempt, PLANNER)).toMatchObject({
      ok: false,
      error: { code: 'not-found' },
    });
    await vi.waitFor(() => {
      expect(cli.sentTo('planner')).toHaveLength(2);
    });
    expect(await report(attemptOf(core, 'ship'), PLANNER)).toMatchObject({
      ok: false,
      error: { code: 'not-found' },
    });
  });

  it('withdraws its attempt’s open asks at once, and a native failure still wins at its turn’s end', async () => {
    await keepCanvas([BUILD]);
    const cli = driven();
    const core = await start(cli.connector);
    await run(core, cli);
    const asked = await ask(core, { party: 'you' }, PLANNER);
    await ok(
      core,
      'complete',
      { task: attemptOf(core), outcome: 'succeeded', summary: 'Done without it.' },
      PLANNER,
    );
    expect(messageOf(core, asked)).toMatchObject({
      state: 'withdrawn',
      settled: { outcome: { type: 'withdrawn', why: 'completed' } },
    });
    cli.reply('planner', '', { status: 'failed', reason: 'api', message: 'Overloaded.' });
    await vi.waitFor(() => {
      expect(planner(core)?.problem).toMatchObject({ kind: 'failed', reason: 'api' });
    });
  });

  it('holds uncertain, saying what it reported, a step a restart cut off after complete', async () => {
    await keepCanvas([BUILD]);
    const cli = driven();
    let core = await start(cli.connector);
    await run(core, cli);
    await ok(
      core,
      'complete',
      { task: attemptOf(core), outcome: 'failed', summary: 'Two tests fail.' },
      PLANNER,
    );
    core = await restart(cli.connector);
    expect(planner(core)?.problem).toMatchObject({ kind: 'uncertain' });
    expect(planner(core)?.problem?.text).toContain('The agent had reported this step failed.');
  });
});
