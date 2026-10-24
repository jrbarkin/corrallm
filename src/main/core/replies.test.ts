import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CanvasId } from '../../shared/canvas';
import type { Message } from '../../shared/model/messages';
import type { NeedsItem } from '../../shared/model/needs';
import type { SessionAnswer, SessionMode } from '../../shared/session';
import type { Connector, LiveSession } from '../sessions/connector';
import { FakeConnector } from '../sessions/fake';
import type { AgentCaller, Caller, OutsideCaller } from './caller';
import { createCore } from './core';
import type { Core } from './core';
import { readOnDisk, keepCanvases } from './store/test-store';
import { CALLERS, NO_DESKTOP } from './test-registry';

/*
 * B11 C7's reply router, through core.call (the typed reply registered early:
 * CoreConfig.preparedOps): a run's holds and its sessions' prompts, yours alone until B24 (R3),
 * never an agent's own (R6), never a pause's release (R9), each answered once at the generation
 * its id names, and recorded with who decided, across a restart; a secret never written, and never
 * shown a token.
 */

const CANVAS = '5d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d' as CanvasId;
const ORCHESTRATOR: OutsideCaller = {
  kind: 'outside',
  token: 'write-token',
  name: 'orchestrator',
  access: 'write',
  canvases: [CANVAS],
};
const YOU = CALLERS.you;
/** The Reviewer, as its own session's token: an agent caller. */
const REVIEWER: AgentCaller = {
  kind: 'agent',
  canvas: CANVAS,
  agent: 'b',
  session: 'b-session',
};
/** The Builder, a lead (as tests say leads, B24's): it may call what a lead may. */
const BUILDER: AgentCaller = { kind: 'agent', canvas: CANVAS, agent: 'a', session: 'a-session' };

/**
 * Builder writes a spec, asks for your OK on it, then builds; Reviewer runs in Manual (its CLI asks
 * before it runs a command); Worker runs on Codex's app server, which refuses to start (its login
 * can't run there), offering Terminal.
 */
function canvasText(): string {
  return JSON.stringify({
    format: 'corrallm',
    version: 2,
    id: CANVAS,
    nodes: [
      {
        id: 'a',
        kind: 'agent',
        label: 'Builder',
        position: { x: 0, y: 0 },
        adapter: 'claude-code',
        connection: 'claude-code.sdk',
        queue: [
          { id: 'spec', message: 'Write the spec' },
          { id: 'ok', approve: 'the spec' },
          { id: 'build', message: 'Build it' },
        ],
      },
      {
        id: 'b',
        kind: 'agent',
        label: 'Reviewer',
        position: { x: 300, y: 0 },
        adapter: 'claude-code',
        connection: 'claude-code.sdk',
        settings: { 'claude-code': { mode: 'manual' } },
      },
      {
        id: 'w',
        kind: 'agent',
        label: 'Worker',
        position: { x: 600, y: 0 },
        adapter: 'codex',
        connection: 'codex.app-server',
        queue: [{ id: 'work', message: 'Do the work' }],
      },
    ],
    links: [],
  });
}

let profile: string;
let project: string;
const cores: Core[] = [];
/** Whether the Reviewer's CLI refuses the next answer it is given. */
let refuseAnswer: boolean;
/** Each answer the Reviewer's CLI took. */
let taken: SessionAnswer[];

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-replies-'));
  project = path.join(profile, 'project');
  await mkdir(project);
  const file = path.join(profile, 'team.corral');
  await writeFile(file, canvasText());
  await keepCanvases(profile, { [CANVAS]: { file, project } });
  refuseAnswer = false;
  taken = [];
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const core of cores.splice(0)) await core.close().catch(() => undefined);
  await rm(profile, { recursive: true, force: true });
});

/** A connector of fakes whose sessions may refuse an answer, and record each they take. */
function answering(fake: FakeConnector): Connector<SessionMode> {
  return {
    start: async (spec, host) => {
      const session: LiveSession<SessionMode> = await fake.start(spec, host);
      const answer = session.answer.bind(session);
      session.answer = async (prompt, given) => {
        if (refuseAnswer) {
          refuseAnswer = false;
          throw new Error('The CLI is busy');
        }
        await answer(prompt, given);
        taken.push(given);
      };
      return session;
    },
  };
}

/** A connector whose sessions won't start here, saying so and offering Terminal, as a login might. */
function refusing(): Connector<SessionMode> {
  return {
    start: (_spec, host) => {
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
}

/** A connector whose sessions ask an MCP server's form for a token, recording what was answered. */
function eliciting(answers: SessionAnswer[]): Connector<SessionMode> {
  const fake = new FakeConnector({ mode: 'acceptEdits' });
  return {
    start: async (spec, host) => {
      const session: LiveSession<SessionMode> = await fake.start(spec, host);
      session.send = (message) => {
        host.emit({ type: 'user', id: message.id, text: message.text });
        host.emit({ type: 'status', status: 'working' });
        host.emit({
          type: 'elicitation',
          id: `${message.id}/form`,
          server: 'tracker',
          message: 'Sign in to the tracker',
          fields: [{ name: 'token', label: 'Token', required: true, kind: 'text' }],
        });
        host.emit({ type: 'status', status: 'waiting' });
        session.answer = (_prompt, given) => {
          answers.push(given);
          host.emit({ type: 'status', status: 'working' });
          host.emit({
            type: 'end',
            messages: [message.id],
            seconds: 1,
            result: { status: 'completed', reason: 'completed' },
          });
          return Promise.resolve();
        };
        return Promise.resolve();
      };
      return session;
    },
  };
}

async function start(
  connectors: Partial<Record<string, Connector<SessionMode>>> = {},
): Promise<{ core: Core; sdk: FakeConnector; terminal: FakeConnector }> {
  // In a mode that doesn't ask, unless an agent's settings say otherwise: its turns run to their end.
  const sdk = new FakeConnector({ mode: 'acceptEdits' });
  const terminal = new FakeConnector({ adapter: 'codex', mode: 'auto' });
  const core = await createCore(
    {
      profile,
      app: { name: 'corrallm', version: '9.8.7' },
      check: true,
      distribution: 'local',
      preparedOps: true,
      leads: (_canvas, agent) => agent === 'a',
      sessions: {
        connectors: {
          'claude-code.sdk': answering(sdk),
          'codex.app-server': refusing(),
          'codex.terminal': terminal,
          ...connectors,
        },
        environment: () => Promise.resolve({}),
      },
      watchFolder: () => ({ close: () => undefined }),
    },
    NO_DESKTOP,
  );
  cores.push(core);
  await core.engines.open(CANVAS);
  return { core, sdk, terminal };
}

/** Calls `op` as `caller`, expecting success: its value. */
async function ok(core: Core, op: string, args: object, caller: Caller = YOU): Promise<unknown> {
  const result = await core.call(op as never, { canvas: CANVAS, ...args }, caller);
  if (!result.ok) throw new Error(`${op}: ${result.error.code}: ${result.error.sentence}`);
  return result.value;
}

/** Calls `op` as `caller`: its result, success or not. */
function call(core: Core, op: string, args: object, caller: Caller = YOU) {
  return core.call(op as never, { canvas: CANVAS, ...args }, caller);
}

/** What waits for an answer on the canvas, as `caller` sees it. */
async function needsOf(core: Core, caller: Caller = YOU): Promise<NeedsItem[]> {
  return ((await ok(core, 'needs', {}, caller)) as { items: NeedsItem[] }).items;
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
  if (found === undefined) throw new Error('nothing waits');
  return found;
}

/** Your messages on the canvas: what was sent to you, records included. */
async function yours(core: Core): Promise<Message[]> {
  return ((await ok(core, 'messages', {})) as { items: Message[] }).items;
}

/** Everything the profile's database keeps, as text: what a secret must never be in. */
function everythingOnDisk(): string {
  return readOnDisk(profile, (disk) =>
    disk
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map(({ name }) =>
        JSON.stringify(
          disk.prepare(`SELECT * FROM "${String(name)}"`).all(),
          (_key, value: unknown) => (typeof value === 'bigint' ? String(value) : value),
        ),
      )
      .join('\n'),
  );
}

const isHold = (agent: string) => (item: NeedsItem) => item.kind === 'hold' && item.agent === agent;
const isPrompt = (agent: string) => (item: NeedsItem) =>
  item.kind === 'prompt' && item.agent === agent;

describe('a run’s hold', () => {
  it('is yours alone (R3), answered once at its generation, and who decided survives a restart', async () => {
    const { core } = await start();
    core.engines.canvas(CANVAS)?.engine.run.start();
    const hold = await waitingFor(core, isHold('a'));
    expect(hold.id).toMatch(/^hold\/a\/[0-9a-f]{8}\/ok$/);
    // R3: no token answers it, whatever it chooses; the lead whose OK it is neither (R6).
    for (const caller of [ORCHESTRATOR, BUILDER]) {
      for (const answer of [{ choice: 'approve' }, { choice: 'stop' }, { text: 'Go' }]) {
        expect(await call(core, 'reply', { to: hold.id, answer }, caller)).toMatchObject({
          ok: false,
          error: { code: 'refused' },
        });
      }
    }
    // Ask for changes: the Builder makes them, then asks again, at another generation.
    expect(
      await ok(core, 'reply', { to: hold.id, answer: { text: 'Make it shorter, please' } }),
    ).toMatchObject({ outcome: 'answered' });
    const again = await waitingFor(core, (item) => isHold('a')(item) && item.id !== hold.id);
    expect(again.id).toMatch(/^hold\/a\/[0-9a-f]{8}\/ok$/);
    // The earlier generation's answer approves nothing: what it was asked was asked again.
    expect(await call(core, 'reply', { to: hold.id, answer: { choice: 'approve' } })).toMatchObject(
      { ok: false, error: { code: 'conflict' } },
    );
    expect((await needsOf(core)).find(isHold('a'))?.id).toBe(again.id);
    const approved = (await ok(core, 'reply', {
      to: again.id,
      answer: { choice: 'approve' },
    })) as { id: string; outcome: string };
    expect(approved.outcome).toBe('answered');
    // Once: a second answer is a conflict naming who settled it.
    expect(await call(core, 'reply', { to: again.id, answer: { choice: 'stop' } })).toMatchObject({
      ok: false,
      error: { code: 'conflict', sentence: expect.stringMatching(/You answered/) as string },
    });
    // Who decided: a record for you, by you, with what kind of answer, never the words given.
    const records = (await yours(core)).filter((message) => message.kind === 'settled');
    expect(records.find((message) => message.id === approved.id)).toMatchObject({
      from: 'corrallm',
      to: 'you',
      by: 'you',
      state: 'delivered',
      body: 'You answered “Your OK on the spec?”: Approve.',
    });
    expect(records.map(({ body }) => body).join('\n')).not.toContain('shorter');
    // The run goes on past it.
    await vi.waitFor(
      () => {
        expect(core.engines.canvas(CANVAS)?.engine.run.snapshot().agents.a?.status).toBe('done');
      },
      { timeout: 10_000, interval: 10 },
    );
    await core.close();
    cores.splice(0);
    // Across a restart: the record is kept, and still settles a second answer.
    const restarted = (await start()).core;
    expect((await yours(restarted)).find((message) => message.id === approved.id)).toMatchObject({
      by: 'you',
      kind: 'settled',
    });
    expect(
      await call(restarted, 'reply', { to: again.id, answer: { choice: 'approve' } }),
    ).toMatchObject({
      ok: false,
      error: { code: 'conflict', sentence: expect.stringMatching(/You answered/) as string },
    });
  });

  it('is never answered while a pause holds its agent, and no answer releases one (R9)', async () => {
    const { core } = await start();
    const open = core.engines.canvas(CANVAS);
    open?.engine.run.start();
    const hold = await waitingFor(core, isHold('a'));
    await ok(core, 'run.pause', { target: { agent: 'a' } });
    expect(await call(core, 'reply', { to: hold.id, answer: { choice: 'approve' } })).toMatchObject(
      {
        ok: false,
        error: { code: 'refused', sentence: expect.stringMatching(/paused by the user/) as string },
      },
    );
    // The pause stays yours: the lead can't release it either.
    expect(open?.engine.run.holding({ agent: 'a' })).toEqual([{ id: 'a', by: 'you' }]);
    expect(await call(core, 'run.unpause', { target: { agent: 'a' } }, BUILDER)).toMatchObject({
      ok: false,
      error: { code: 'refused' },
    });
    expect(open?.engine.run.snapshot().agents.a?.outcomes.ok).toBeUndefined();
    // Released by you, it asks again, and your answer is taken.
    await ok(core, 'run.unpause', { target: { agent: 'a' } });
    const asked = await waitingFor(core, isHold('a'));
    expect(asked.id).toBe(hold.id);
    await ok(core, 'reply', { to: asked.id, answer: { choice: 'approve' } });
    expect(open?.engine.run.snapshot().agents.a?.outcomes.ok).toBe('succeeded');
  });

  it('switches a session that won’t start, as yours alone, and its held attempt goes on there once', async () => {
    const { core, terminal } = await start();
    const open = core.engines.canvas(CANVAS);
    // The Worker's task: its session refuses to start, so the run asks you to switch it.
    open?.engine.run.start();
    const hold = await waitingFor(core, isHold('w'));
    expect(hold.choices).toMatchObject([
      { value: 'switch', humanOnly: expect.any(String) as string },
    ]);
    const attempts = () =>
      Object.values(open?.engine.run.snapshot().agents.w?.attempts ?? {}).flat();
    const [held] = attempts();
    // No token switches how an agent runs, through a reply or otherwise (R3, D9).
    expect(
      await call(core, 'reply', { to: hold.id, answer: { choice: 'switch' } }, ORCHESTRATOR),
    ).toMatchObject({ ok: false, error: { code: 'refused' } });
    expect(await ok(core, 'reply', { to: hold.id, answer: { choice: 'switch' } })).toMatchObject({
      outcome: 'answered',
    });
    expect(open?.document.nodes.find((node) => node.id === 'w')).toMatchObject({
      data: { connection: 'codex.terminal' },
    });
    await vi.waitFor(
      () => {
        expect(open?.engine.run.snapshot().agents.w?.status).toBe('done');
      },
      { timeout: 10_000, interval: 10 },
    );
    // Exactly the attempt it held: sent once, on the new connection, never typed a second time.
    expect(terminal.sessions.flatMap((session) => session.sent.map(({ text }) => text))).toEqual([
      expect.stringContaining('Do the work'),
    ]);
    expect(attempts().map(({ id }) => id)).toEqual([held?.id]);
    expect((await yours(core)).find((message) => message.kind === 'settled')?.body).toBe(
      'You switched Worker to Terminal: its held task goes on there.',
    );
  });
});

describe('a session’s prompt', () => {
  it('is answered through its CLI first: one it refused still waits; never by a token or itself', async () => {
    const { core } = await start();
    await ok(core, 'message', { to: 'b', body: 'Run the tests' });
    const prompt = await waitingFor(core, isPrompt('b'));
    expect(prompt.id).toMatch(/^prompt\/b\/\d+\/.+\/permission$/);
    // R6, then R3: not the agent whose prompt it is, nor any token.
    expect(
      await call(core, 'reply', { to: prompt.id, answer: { permission: 'once' } }, REVIEWER),
    ).toMatchObject({
      ok: false,
      error: {
        code: 'refused',
        sentence: expect.stringMatching(/never answers what waits on itself/) as string,
      },
    });
    for (const answer of [{ permission: 'once' }, { permission: 'always' }, { choice: 'deny' }]) {
      expect(await call(core, 'reply', { to: prompt.id, answer }, ORCHESTRATOR)).toMatchObject({
        ok: false,
        error: { code: 'refused' },
      });
    }
    // An earlier session's prompt of the same native id is another: refused as stale.
    const [, , generation, ...rest] = prompt.id.split('/');
    const earlier = ['prompt', 'b', String(Number(generation) - 1), ...rest].join('/');
    expect(
      await call(core, 'reply', { to: earlier, answer: { permission: 'once' } }),
    ).toMatchObject({ ok: false, error: { code: 'conflict' } });
    // The CLI refuses the first answer: nothing is shown answered, and it still waits for one.
    refuseAnswer = true;
    expect(
      await call(core, 'reply', { to: prompt.id, answer: { permission: 'once' } }),
    ).toMatchObject({
      ok: false,
      error: { code: 'unavailable', sentence: expect.stringMatching(/still waits/) as string },
    });
    expect((await needsOf(core)).map(({ id }) => id)).toContain(prompt.id);
    expect(taken).toEqual([]);
    const answered = (await ok(core, 'reply', {
      to: prompt.id,
      answer: { permission: 'deny', feedback: 'Use the other script' },
    })) as { id: string };
    expect(taken).toEqual([
      { kind: 'permission', answer: 'deny', feedback: 'Use the other script' },
    ]);
    expect((await needsOf(core)).map(({ id }) => id)).not.toContain(prompt.id);
    // The answer that didn't take is withdrawn; the one that took is who decided, without its
    // feedback.
    const records = (await yours(core)).filter((message) => message.kind === 'settled');
    expect(records).toEqual([
      expect.objectContaining({
        state: 'withdrawn',
        body: 'Reviewer’s CLI didn’t take this answer, so it changed nothing: You allowed Reviewer’s Bash: echo hello, once.',
      }),
      expect.objectContaining({
        id: answered.id,
        by: 'you',
        state: 'delivered',
        body: 'You denied Reviewer’s Bash: echo hello.',
      }),
    ]);
    expect(
      await call(core, 'reply', { to: prompt.id, answer: { permission: 'once' } }),
    ).toMatchObject({
      ok: false,
      error: { code: 'conflict', sentence: expect.stringMatching(/You denied/) as string },
    });
  });

  it('never writes a secret, nor shows a token the form', async () => {
    const answers: SessionAnswer[] = [];
    const { core } = await start({ 'claude-code.sdk': eliciting(answers) });
    await ok(core, 'message', { to: 'b', body: 'Sign in' });
    const form = await waitingFor(core, isPrompt('b'));
    expect(form).toMatchObject({ title: 'Sign in to the tracker' });
    // A token sees that the Reviewer waits for you, never the form, and can't answer it.
    const seen = (await needsOf(core, ORCHESTRATOR)).find(({ id }) => id === form.id);
    expect(seen).toMatchObject({ title: 'Sign in to the tracker', choices: [] });
    expect(seen).not.toHaveProperty('form');
    const secret = 'hunter2-only-the-user-knows';
    expect(
      await call(
        core,
        'reply',
        { to: form.id, answer: { form: { action: 'accept', values: { token: secret } } } },
        ORCHESTRATOR,
      ),
    ).toMatchObject({ ok: false, error: { code: 'refused' } });
    const result = await ok(core, 'reply', {
      to: form.id,
      answer: { form: { action: 'accept', values: { token: secret } } },
    });
    // Its CLI got the values, and nothing else did: no result, record, transcript, read or row.
    expect(answers).toEqual([{ kind: 'elicitation', action: 'accept', values: { token: secret } }]);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(await yours(core))).not.toContain(secret);
    expect(JSON.stringify(await ok(core, 'messages', {}, ORCHESTRATOR))).not.toContain(secret);
    expect(JSON.stringify(await ok(core, 'session.transcript', { agent: 'b' }))).not.toContain(
      secret,
    );
    await core.engines.canvas(CANVAS)?.journal();
    expect(everythingOnDisk()).not.toContain(secret);
    expect((await yours(core)).find((message) => message.kind === 'settled')?.body).toBe(
      'You accepted the tracker MCP server’s request for Reviewer.',
    );
  });
});
