import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CanvasId } from '../../shared/canvas';
import type { Message } from '../../shared/model/messages';
import type { NeedsItem } from '../../shared/model/needs';
import type { PromptAnswer } from '../../shared/model/prompts';
import type { Entry } from '../../shared/model/session';
import type { SessionMode } from '../../shared/session';
import type { Connector, LiveSession } from '../sessions/connector';
import { FakeConnector } from '../sessions/fake';
import type { AgentCaller, Caller, OutsideCaller } from './caller';
import { createCore } from './core';
import type { Core } from './core';
import { keepCanvases } from './store/test-store';
import { CALLERS, NO_DESKTOP } from './test-registry';
import { legacyDirectories } from './workspaces/test-directories';

/*
 * B13 Design §9.2 C11 through core.call, at every read boundary, for every reader: you; a token
 * that reaches the prompt's agent (an outside token on its canvas, an agent linked to it); a parent
 * for its team's prompts (which Needs alone shows it); and a token that doesn't reach it. You see a
 * prompt whole, with its choices; a token sees it without them, without a form's schema, link or
 * words, without a terminal's screen, and never an answer; one that doesn't reach it, nothing.
 */

const CANVAS = '9b5a6c7d-8e9f-4a0b-9c1d-2e3f4a5b6c7d' as CanvasId;
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
  session: `${id}-session`,
});
/** A lead linked to the Reviewer and the Worker: it reaches them, their transcripts too. */
const LINKER = agent('l');
/** The Reviewer's and the Worker's group: it sees their prompts in Needs, and reaches neither. */
const PARENT = agent('p');
/** Linked to nobody: it reaches neither. */
const STRANGER = agent('s');
/** Every token that reaches the Reviewer and the Worker. */
const REACHED = [ORCHESTRATOR, LINKER];

const LINK = 'https://signin.example.test/link?token=private-signin-secret';
const SCREEN = 'private-screen-row one\nprivate-screen-row two';
/** What no token may read of what waits, whatever the boundary. */
const PRIVATE = [
  'private-signin-secret',
  'signin.example.test',
  'private-form',
  'private-field-title',
  'private-screen-row',
  'private-rule-text',
  'private-answer-text',
  'private-feedback-words',
  'private-revise-words',
];

const approval = {
  kind: 'approval',
  title: 'Run the cleanup?',
  summary: 'It removes the build folder',
  reason: 'The agent asks to clean',
  subject: { type: 'command', command: 'rm -rf build', cwd: '/work/app' },
  answerIn: 'api',
  choices: [
    { value: 'yes', label: 'Yes', hint: 'allow_once', effects: {} },
    {
      value: 'always',
      label: 'Yes, and don’t ask again for private-rule-text',
      hint: 'allow_always',
      effects: { rules: [{ behavior: 'allow', rule: 'private-rule-text', scope: 'session' }] },
    },
    { value: 'no', label: 'No', hint: 'reject_once', effects: {} },
  ],
};
const link = {
  kind: 'form',
  title: `Sign in at ${LINK}`,
  summary: `private-form-message: ${LINK}`,
  server: 'tracker',
  answerIn: 'api',
  form: { url: LINK },
};
const form = {
  kind: 'form',
  title: `Your details, then ${LINK}`,
  reason: 'private-form-reason',
  server: 'tracker',
  answerIn: 'api',
  form: {
    schema: {
      type: 'object',
      properties: { key: { type: 'string', title: 'private-field-title' } },
      required: ['key'],
      additionalProperties: false,
    },
  },
};
/** A terminal's wait its report alone describes, with what its screen shows. */
const screen = {
  kind: 'approval',
  title: 'The CLI needs you: see its terminal.',
  answerIn: 'terminal',
  detail: { kind: 'output', text: SCREEN },
  choices: [],
};
/** A terminal's wait a hook described: its tool and the tool's input. */
const hooked = {
  kind: 'approval',
  title: 'Approve Bash: npm test?',
  answerIn: 'terminal',
  subject: { type: 'tool', tool: 'Bash', input: { command: 'npm test' } },
  detail: { kind: 'output', text: 'npm test' },
  choices: [],
};
const RAISED = [approval, link, form, screen, hooked];

/** The Parent holds the Reviewer and the Worker; the Linker is linked to both; the Stranger to none. */
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
      node('p', 'Parent', 0),
      node('b', 'Reviewer', 100, { parent: 'p' }),
      node('w', 'Worker', 200, {
        parent: 'p',
        adapter: 'codex',
        connection: 'codex.app-server',
        settings: { codex: { mode: 'read-only' } },
      }),
      node('l', 'Linker', 300),
      node('s', 'Stranger', 400),
    ],
    links: [{ agents: ['l', 'b'] }, { agents: ['l', 'w'] }],
  });
}

let profile: string;
const cores: Core[] = [];

/**
 * A connector whose session raises, through the core's prompt owner, the prompts the test gives as
 * the Reviewer's first message arrives, then an MCP server's request among the events B13 replaces;
 * and answers both.
 */
function raising(prompts: object[]) {
  const fake = new FakeConnector({ mode: 'acceptEdits' });
  const answered: [string, PromptAnswer][] = [];
  const connector: Connector<SessionMode> = {
    start: async (spec, host) => {
      const session: LiveSession<SessionMode> = await fake.start(spec, host);
      session.send = (message) => {
        host.emit({ type: 'user', id: message.id, text: message.text });
        host.emit({ type: 'status', status: 'working' });
        for (const prompt of prompts.splice(0)) {
          host.emit({ type: 'prompt', key: crypto.randomUUID(), prompt: prompt as never });
        }
        if (message.text.includes('Sign in')) {
          host.emit({
            type: 'elicitation',
            id: 'sign-in',
            server: 'tracker',
            message: `private-form-message: ${LINK}`,
            url: LINK,
          });
        }
        host.emit({ type: 'status', status: 'waiting' });
        return Promise.resolve();
      };
      session.answer = () => Promise.resolve();
      Object.assign(session, {
        prompts: {
          answer: (key: string, answer: PromptAnswer) => {
            answered.push([key, answer]);
          },
          decline: () => undefined,
        },
      });
      return session;
    },
  };
  return { connector, answered };
}

async function start(connector: Connector<SessionMode>): Promise<Core> {
  const core = await createCore(
    {
      profile,
      app: { name: 'corrallm', version: '9.8.7' },
      check: true,
      distribution: 'local',
      directoryResolver: legacyDirectories,
      leads: (_canvas, id) => id === 'l',
      sessions: {
        connectors: {
          'claude-code.sdk': connector,
          // The Worker's CLI asks before it runs a command, and plays /question and /plan.
          'codex.app-server': new FakeConnector({ adapter: 'codex', mode: 'read-only' }),
        },
        environment: () => Promise.resolve({}),
      },
      watchFolder: () => ({ close: () => undefined }),
    },
    NO_DESKTOP,
  );
  cores.push(core);
  await core.engines.open(CANVAS);
  return core;
}

async function ok<T = unknown>(core: Core, op: string, args: object, caller: Caller = YOU) {
  const result = await core.call(op as never, { canvas: CANVAS, ...args }, caller);
  if (!result.ok) throw new Error(`${op}: ${result.error.code}: ${result.error.sentence}`);
  return result.value as T;
}

function call(core: Core, op: string, args: object, caller: Caller = YOU) {
  return core.call(op as never, { canvas: CANVAS, ...args }, caller);
}

async function needsOf(core: Core, caller: Caller = YOU): Promise<NeedsItem[]> {
  return (await ok<{ items: NeedsItem[] }>(core, 'needs', {}, caller)).items;
}

/** A Needs id of a prompt of the Reviewer's the core's prompt owner holds: by its PromptId. */
const OWNED = /^prompt\/b\/\d+\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The Reviewer's prompts the core's owner holds, once `count` wait. */
async function owned(core: Core, count: number): Promise<NeedsItem[]> {
  let found: NeedsItem[] = [];
  await vi.waitFor(
    async () => {
      found = (await needsOf(core)).filter(({ id }) => OWNED.test(id));
      expect(found).toHaveLength(count);
    },
    { timeout: 10_000, interval: 10 },
  );
  return found;
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

function expectNothingPrivate(read: unknown, what: string): void {
  const text = JSON.stringify(read);
  for (const word of PRIVATE) expect.soft(text, `${what}: ${word}`).not.toContain(word);
}

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-prompt-views-'));
  const project = path.join(profile, 'project');
  await mkdir(project);
  const file = path.join(profile, 'team.corral');
  await writeFile(file, canvasText());
  await keepCanvases(profile, { [CANVAS]: { file, project } });
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const core of cores.splice(0)) await core.close().catch(() => undefined);
  await rm(profile, { recursive: true, force: true });
});

describe('needs, status and the needs topic', () => {
  it('give you each prompt whole: its choices with what each does, its form, its own fields and a terminal’s screen', async () => {
    const core = await start(raising([...RAISED]).connector);
    await ok(core, 'message', { to: 'b', body: 'Clean up' });
    const [asked, opened, filled, waits, told] = await owned(core, RAISED.length);
    expect(asked).toMatchObject({
      title: 'Run the cleanup?',
      choices: [
        { value: 'yes', hint: 'allow_once', effects: {} },
        {
          value: 'always',
          hint: 'allow_always',
          effects: approval.choices[1]?.effects,
          humanOnly: expect.any(String) as string,
        },
        { value: 'no', hint: 'reject_once', effects: {} },
      ],
      prompt: {
        kind: 'approval',
        summary: approval.summary,
        reason: approval.reason,
        subject: approval.subject,
        raised: expect.any(Number) as number,
      },
    });
    expect(asked?.prompt?.id).toBe(asked?.id.split('/').at(-1));
    expect(opened).toMatchObject({
      title: 'MCP server “tracker” asks you to open a link',
      form: { url: LINK },
      prompt: { kind: 'form', summary: link.summary },
    });
    expect(filled).toMatchObject({
      title: 'MCP server “tracker” asks you to fill in a form',
      form: form.form,
      prompt: { kind: 'form', reason: form.reason },
    });
    expect(waits).toMatchObject({
      answerIn: 'terminal',
      detail: SCREEN,
      choices: [{ value: 'not-waiting', label: 'Not waiting' }],
    });
    expect(told).toMatchObject({
      detail: 'npm test',
      choices: [],
      prompt: { subject: hooked.subject },
    });
  });

  it('give a token that reaches its agent, and a parent its team’s, each without choices, form, a form’s words or a screen; a stranger nothing', async () => {
    const core = await start(raising([...RAISED]).connector);
    await ok(core, 'message', { to: 'b', body: 'Clean up' });
    const yours = await owned(core, RAISED.length);
    for (const caller of [...REACHED, PARENT]) {
      const who = JSON.stringify(caller);
      // `status` is outside tokens' alone.
      const status =
        caller.kind === 'outside'
          ? (await ok<{ waitingForYou: NeedsItem[] }>(core, 'status', {}, caller)).waitingForYou
          : undefined;
      const boundaries: [string, NeedsItem[]][] = [
        ['needs', (await needsOf(core, caller)).filter(({ agent }) => agent === 'b')],
        ...(status === undefined
          ? []
          : [['status', status.filter(({ agent }) => agent === 'b')] as [string, NeedsItem[]]]),
      ];
      for (const [boundary, items] of boundaries) {
        expect(
          items.map(({ id }) => id),
          `${boundary} ${who}`,
        ).toEqual(yours.map(({ id }) => id));
        for (const item of items) {
          expect(item.choices, `${boundary} ${who}`).toEqual([]);
          expect(item).not.toHaveProperty('form');
        }
        const [asked, opened, filled, waits, told] = items;
        expect(asked?.prompt).toEqual(yours[0]?.prompt);
        expect(opened?.title).toBe('MCP server “tracker” asks you to open a link');
        expect(opened?.prompt).toEqual({
          id: yours[1]?.prompt?.id,
          kind: 'form',
          server: 'tracker',
          raised: yours[1]?.prompt?.raised,
          humanOnly: yours[1]?.prompt?.humanOnly,
        });
        expect(filled?.prompt).not.toHaveProperty('reason');
        expect(waits).not.toHaveProperty('detail');
        expect(told).toMatchObject({ detail: 'npm test', prompt: { subject: hooked.subject } });
        expectNothingPrivate(items, `${boundary} ${who}`);
      }
    }
    expect((await needsOf(core, STRANGER)).filter(({ agent }) => agent === 'b')).toEqual([]);
    expect(await call(core, 'status', {}, STRANGER)).toMatchObject({
      ok: false,
      error: { code: 'forbidden' },
    });
  });

  it('follow as each reader’s needs say: the topic is never a second way to what its read leaves out', async () => {
    const core = await start(raising([...RAISED]).connector);
    await ok(core, 'message', { to: 'b', body: 'Clean up' });
    await owned(core, RAISED.length);
    for (const caller of [YOU, ...REACHED, PARENT, STRANGER]) {
      const { snapshot, stop } = await core.topics.follow(
        caller,
        `needs:${CANVAS}`,
        () => undefined,
      );
      stop();
      expect('state' in snapshot ? snapshot.state : undefined).toEqual({
        items: await needsOf(core, caller),
      });
    }
  });
});

describe('the counts agents and session.get give', () => {
  it('count each prompt the owner holds once, for whoever reaches its agent', async () => {
    const core = await start(raising([approval, screen]).connector);
    await ok(core, 'message', { to: 'b', body: 'Clean up' });
    await owned(core, 2);
    for (const caller of [YOU, ...REACHED]) {
      const { agents } = await ok<{ agents: { id: string; prompts: number }[] }>(
        core,
        'agents',
        {},
        caller,
      );
      expect(agents.find(({ id }) => id === 'b')?.prompts).toBe(2);
      expect(await ok(core, 'session.get', { agent: 'b' }, caller)).toMatchObject({ prompts: 2 });
    }
    for (const caller of [PARENT, STRANGER]) {
      const { agents } = await ok<{ agents: { id: string }[] }>(core, 'agents', {}, caller);
      expect(agents.map(({ id }) => id)).not.toContain('b');
      expect(await call(core, 'session.get', { agent: 'b' }, caller)).toMatchObject({
        ok: false,
        error: { code: 'not-found' },
      });
    }
  });
});

describe('session.transcript and the session topic', () => {
  it('keep restored prompt-reply text yours alone at both read boundaries', async () => {
    const fake = new FakeConnector({ mode: 'acceptEdits' });
    const core = await start({
      start: async (spec, host) => {
        const session = await fake.start(spec, host);
        host.emit({
          type: 'history',
          events: [
            { type: 'user', id: 'native-reply', text: 'private-revision', promptReply: true },
          ],
        });
        return session;
      },
    });
    await ok(core, 'message', { to: 'b', body: 'Continue' });
    await vi.waitFor(async () => {
      const { entries } = await ok<{ entries: Entry[] }>(core, 'session.transcript', {
        agent: 'b',
      });
      expect(entries).toContainEqual(expect.objectContaining({ id: 'native-reply' }));
    });
    for (const caller of [YOU, ...REACHED]) {
      const transcript = await ok(core, 'session.transcript', { agent: 'b' }, caller);
      const topic = await core.topics.read(`session:${CANVAS}:b`, caller);
      expect(topic.ok).toBe(true);
      const shown = JSON.stringify({ transcript, topic });
      expect(shown.includes('private-revision')).toBe(caller.kind === 'human');
      expect(shown).not.toContain('promptReply');
    }
    for (const caller of [PARENT, STRANGER]) {
      expect((await call(core, 'session.transcript', { agent: 'b' }, caller)).ok).toBe(false);
      expect((await core.topics.read(`session:${CANVAS}:b`, caller)).ok).toBe(false);
    }
  });

  /** The Worker's prompts among the events B13 replaces, each answered by you. */
  async function answered(core: Core): Promise<void> {
    const isWorkers = (item: NeedsItem) => item.agent === 'w' && item.kind === 'prompt';
    const asked = new Set<string>();
    const next = async () => {
      const item = await waitingFor(core, (one) => isWorkers(one) && !asked.has(one.id));
      asked.add(item.id);
      return item;
    };
    await ok(core, 'message', { to: 'w', body: '/question' });
    await ok(core, 'reply', {
      to: (await next()).id,
      answer: { answers: { '0': 'private-answer-text' } },
    });
    await ok(core, 'message', { to: 'w', body: '/plan it' });
    await ok(core, 'reply', {
      to: (await next()).id,
      answer: { plan: { approve: false, feedback: 'private-revise-words' } },
    });
    await ok(core, 'message', { to: 'w', body: 'Run it' });
    await ok(core, 'reply', {
      to: (await next()).id,
      answer: { permission: 'deny', feedback: 'private-feedback-words' },
    });
  }

  /** The prompt entries of `agent`'s transcript and of its session topic, as `caller` reads them. */
  async function prompts(core: Core, agent: string, caller: Caller) {
    const isPrompt = ({ kind }: { kind: string }) =>
      ['permission', 'question', 'plan', 'elicitation'].includes(kind);
    const { entries } = await ok<{ entries: Entry[] }>(
      core,
      'session.transcript',
      { agent, limit: 200 },
      caller,
    );
    const topic = await core.topics.read(`session:${CANVAS}:${agent}`, caller);
    if (!topic.ok) throw new Error(topic.error.sentence);
    const state = topic.value as { entries: Record<string, Entry>; order: string[] };
    return {
      transcript: entries.filter(isPrompt),
      topic: state.order.flatMap((id) => {
        const entry = state.entries[id];
        return entry && isPrompt(entry) ? [entry] : [];
      }),
    };
  }

  it('give you each prompt with your answers; a token that reaches its agent none of them, no label and no feedback', async () => {
    const core = await start(raising([]).connector);
    await answered(core);
    const yours = await prompts(core, 'w', YOU);
    expect(yours.topic).toEqual(yours.transcript);
    expect(yours.transcript).toEqual([
      expect.objectContaining({
        kind: 'question',
        questions: [expect.objectContaining({ answer: 'private-answer-text' })],
      }),
      expect.objectContaining({
        kind: 'plan',
        answer: { approve: false, feedback: 'private-revise-words' },
      }),
      expect.objectContaining({
        kind: 'permission',
        always: expect.any(String) as string,
        answer: 'deny',
        feedback: 'private-feedback-words',
      }),
    ]);
    for (const caller of REACHED) {
      const theirs = await prompts(core, 'w', caller);
      expect(theirs.topic).toEqual(theirs.transcript);
      expect(theirs.transcript.map(({ kind }) => kind)).toEqual(['question', 'plan', 'permission']);
      for (const entry of theirs.transcript) {
        expect(entry).not.toHaveProperty('answer');
        expect(entry).not.toHaveProperty('feedback');
        expect(entry).not.toHaveProperty('always');
        if (entry.kind === 'question') {
          for (const question of entry.questions) expect(question).not.toHaveProperty('answer');
        }
      }
      expectNothingPrivate(theirs, JSON.stringify(caller));
    }
  });

  it('give a token an MCP server’s request in the core’s words alone, never its link or how you answered it', async () => {
    const core = await start(raising([]).connector);
    await ok(core, 'message', { to: 'b', body: 'Sign in' });
    const item = await waitingFor(core, (one) => one.agent === 'b' && one.kind === 'prompt');
    await ok(core, 'reply', { to: item.id, answer: { form: { action: 'accept' } } });
    await vi.waitFor(async () => {
      expect((await prompts(core, 'b', YOU)).transcript).toEqual([
        expect.objectContaining({ kind: 'elicitation', url: LINK, answer: 'accept' }),
      ]);
    });
    for (const caller of REACHED) {
      const theirs = await prompts(core, 'b', caller);
      expect(theirs.transcript).toEqual([
        {
          id: 'sign-in',
          kind: 'elicitation',
          server: 'tracker',
          message: 'MCP server “tracker” asks you to open a link',
        },
      ]);
      expect(theirs.topic).toEqual(theirs.transcript);
    }
  });

  it('are not a parent’s or a stranger’s to read', async () => {
    const core = await start(raising([]).connector);
    await answered(core);
    for (const caller of [PARENT, STRANGER]) {
      expect(await call(core, 'session.transcript', { agent: 'w' }, caller)).toMatchObject({
        ok: false,
        error: { code: 'not-found' },
      });
      expect(await core.topics.read(`session:${CANVAS}:w`, caller)).toMatchObject({
        ok: false,
        error: { code: 'not-found' },
      });
    }
  });
});

describe('the owner’s prompts in session.transcript and the session topic (B13 C9)', () => {
  interface Placed {
    id: string;
    kind: 'prompt';
    need: string;
    prompt: { choices?: unknown[]; form?: unknown; detail?: unknown } & Record<string, unknown>;
    outcome?: Record<string, unknown>;
  }

  /** The prompt entries of the Reviewer's transcript and of its session topic, as `caller` reads them. */
  async function placed(core: Core, caller: Caller) {
    const isPlaced = (entry: { kind: string } | undefined): entry is Placed =>
      entry?.kind === 'prompt';
    const { entries } = await ok<{ entries: { kind: string }[] }>(
      core,
      'session.transcript',
      { agent: 'b', limit: 200 },
      caller,
    );
    const topic = await core.topics.read(`session:${CANVAS}:b`, caller);
    if (!topic.ok) throw new Error(topic.error.sentence);
    const state = topic.value as { entries: Record<string, { kind: string }>; order: string[] };
    return {
      transcript: entries.filter(isPlaced),
      topic: state.order.flatMap((id) => {
        const entry = state.entries[id];
        return isPlaced(entry) ? [entry] : [];
      }),
    };
  }

  it('place each as raised: yours whole, with its choices; a token’s as its Needs item says, alike at both boundaries', async () => {
    const core = await start(raising([...RAISED]).connector);
    await ok(core, 'message', { to: 'b', body: 'Clean up' });
    const yours = await owned(core, RAISED.length);
    await vi.waitFor(async () => {
      expect((await placed(core, YOU)).transcript).toHaveLength(RAISED.length);
    });
    const mine = await placed(core, YOU);
    expect(mine.topic).toEqual(mine.transcript);
    expect(mine.transcript.map(({ id, need }) => [id, need])).toEqual(
      yours.map(({ id, prompt }) => [prompt?.id, id]),
    );
    const [asked, opened, filled, waits, told] = mine.transcript;
    expect(asked?.prompt).toMatchObject({
      kind: 'approval',
      title: approval.title,
      summary: approval.summary,
      subject: approval.subject,
      choices: yours[0]?.choices,
    });
    expect(opened?.prompt).toMatchObject({ title: link.title, form: { url: LINK } });
    expect(filled?.prompt).toMatchObject({ form: form.form, reason: form.reason });
    expect(waits?.prompt).toMatchObject({
      detail: { kind: 'output', text: SCREEN },
      choices: [expect.objectContaining({ value: 'not-waiting' })],
    });
    expect(told?.prompt).toMatchObject({ subject: hooked.subject });
    for (const entry of mine.transcript) expect(entry).not.toHaveProperty('outcome');
    for (const caller of REACHED) {
      const who = JSON.stringify(caller);
      const theirs = await placed(core, caller);
      expect(theirs.topic, who).toEqual(theirs.transcript);
      expect(theirs.transcript.map(({ id }) => id)).toEqual(mine.transcript.map(({ id }) => id));
      for (const entry of theirs.transcript) {
        expect(entry.prompt.choices, who).toEqual([]);
        expect(entry.prompt, who).not.toHaveProperty('form');
      }
      const [theirAsk, theirLink, , theirWait, theirTold] = theirs.transcript;
      expect(theirAsk?.prompt).toMatchObject({ subject: approval.subject });
      expect(theirLink?.prompt.title).toBe('MCP server “tracker” asks you to open a link');
      expect(theirWait?.prompt).not.toHaveProperty('detail');
      expect(theirTold?.prompt).toMatchObject({ subject: hooked.subject });
      expectNothingPrivate(theirs, who);
    }
    for (const caller of [PARENT, STRANGER]) {
      expect((await call(core, 'session.transcript', { agent: 'b' }, caller)).ok).toBe(false);
    }
  });

  it('settle each in place as it ends: how and by whom yours, a token’s only its type and by whom, never what was given', async () => {
    const core = await start(raising([approval, screen]).connector);
    await ok(core, 'message', { to: 'b', body: 'Clean up' });
    const [asked, waits] = await owned(core, 2);
    await ok(core, 'reply', { to: asked?.id, answer: { choice: 'always' } });
    await ok(core, 'reply', { to: waits?.id, answer: { choice: 'not-waiting' } });
    await vi.waitFor(async () => {
      expect((await placed(core, YOU)).transcript.map(({ outcome }) => outcome)).toEqual([
        { type: 'choice', value: 'always', hint: 'allow_always', by: 'you' },
        { type: 'dismissed', by: 'you' },
      ]);
    });
    const mine = await placed(core, YOU);
    expect(mine.topic).toEqual(mine.transcript);
    expect(mine.transcript[0]?.prompt).toEqual({
      id: asked?.prompt?.id,
      kind: 'approval',
      agent: 'b',
      raised: asked?.prompt?.raised,
      answerIn: 'api',
      title: approval.title,
    });
    for (const caller of REACHED) {
      const theirs = await placed(core, caller);
      expect(theirs.topic).toEqual(theirs.transcript);
      expect(theirs.transcript.map(({ outcome }) => outcome)).toEqual([
        { type: 'choice', by: 'you' },
        { type: 'dismissed', by: 'you' },
      ]);
      const text = JSON.stringify(theirs);
      for (const word of ['always', 'allow_always', 'rm -rf', 'private-']) {
        expect.soft(text, `${JSON.stringify(caller)}: ${word}`).not.toContain(word);
      }
    }
  });
});

describe('an approval of an MCP server’s tool: its words yours alone, a token’s in the core’s (B13 C9)', () => {
  /** The server's own words for its tool's approval: an SDK `permissionDisplay` title, or Codex's. */
  const WORDS = 'Create the issue? First sign in at https://signin.example.test/?t=private-server';
  const SERVER = /private-server|signin\.example|Create the issue/;
  const CORE = 'MCP server “tracker” asks to use its tool “create_issue”';
  const tool = {
    kind: 'approval',
    title: WORDS,
    summary: 'private-server-summary',
    subject: {
      type: 'mcpTool',
      server: 'tracker',
      tool: 'create_issue',
      input: { title: 'Bug' },
    },
    answerIn: 'api',
    choices: [
      { value: 'allow', label: 'Yes', hint: 'allow_once', effects: {} },
      { value: 'deny', label: 'No', hint: 'reject_once', effects: {} },
    ],
  };

  /**
   * A session that asks to use the server's tool as each turn starts, as the Agent SDK's and Codex
   * App Server's adapters raise it: through the core's owner, and, `mirrored` (as both do until
   * X10), as the event B13 replaces too, its title the server's words.
   */
  function asking(mirrored: boolean, adapter: 'claude-code' | 'codex'): Connector<SessionMode> {
    const fake = new FakeConnector({ adapter, mode: adapter === 'codex' ? 'read-only' : 'manual' });
    return {
      start: async (spec, host) => {
        if (mirrored)
          host.bridge?.(() => {
            throw new Error('Answered through the owner in these tests.');
          });
        const session = await fake.start(spec, host);
        session.send = (message) => {
          host.emit({ type: 'user', id: message.id, text: message.text });
          host.emit({ type: 'status', status: 'working' });
          host.emit({ type: 'prompt', key: crypto.randomUUID(), prompt: tool as never });
          if (mirrored) {
            host.emit({
              type: 'permission',
              id: `${message.id}/tool`,
              tool: 'mcp__tracker__create_issue',
              summary: 'create_issue',
              always: null,
              title: WORDS,
            });
          }
          host.emit({ type: 'status', status: 'waiting' });
          return Promise.resolve();
        };
        Object.assign(session, {
          prompts: { answer: () => undefined, decline: () => undefined },
        });
        return session;
      },
    };
  }

  async function both(mirrored: boolean): Promise<Core> {
    const core = await createCore(
      {
        profile,
        app: { name: 'corrallm', version: '9.8.7' },
        check: true,
        distribution: 'local',
        directoryResolver: legacyDirectories,
        leads: (_canvas, id) => id === 'l',
        sessions: {
          connectors: {
            'claude-code.sdk': asking(mirrored, 'claude-code'),
            'codex.app-server': asking(mirrored, 'codex'),
          },
          environment: () => Promise.resolve({}),
        },
        watchFolder: () => ({ close: () => undefined }),
      },
      NO_DESKTOP,
    );
    cores.push(core);
    await core.engines.open(CANVAS);
    return core;
  }

  /** What `caller` reads of the agent's prompt in Needs, its transcript and its session topic. */
  async function readsOf(core: Core, agent: string, caller: Caller) {
    const items = (await needsOf(core, caller)).filter(
      (item) => item.agent === agent && item.kind === 'prompt',
    );
    const transcript = await ok(core, 'session.transcript', { agent, limit: 200 }, caller);
    const topic = await core.topics.read(`session:${CANVAS}:${agent}`, caller);
    return { items, transcript, topic };
  }

  /** The notices the orchestrator's waits have read so far, once one names `agent`'s wait. */
  async function told(core: Core, name: string): Promise<string[]> {
    const notices: string[] = [];
    await vi.waitFor(
      async () => {
        const read = await core.call('wait', { timeoutSeconds: 0 }, ORCHESTRATOR);
        if (!read.ok) throw new Error(read.error.sentence);
        notices.push(
          ...read.value.messages.filter(({ kind }) => kind === 'notice').map(({ body }) => body),
        );
        expect(notices.some((body) => body.startsWith(`${name} is waiting for the user`))).toBe(
          true,
        );
      },
      { timeout: 10_000, interval: 25 },
    );
    return notices;
  }

  it.each([
    ['the Agent SDK’s', 'b', 'Reviewer'],
    ['Codex’s', 'w', 'Worker'],
  ])(
    'gives a reached token the core’s words for %s, in Needs, the transcript and the waiting notice; you the server’s',
    async (_which, agent, name) => {
      // As every adapter raises it until X10: the event B13 replaces stands for the owner's prompt.
      const live = await both(true);
      await ok(live, 'message', { to: agent, body: 'File it' }, ORCHESTRATOR);
      await waitingFor(live, (item) => item.agent === agent && item.kind === 'prompt');
      const yours = await readsOf(live, agent, YOU);
      expect(yours.items.map(({ title }) => title)).toEqual([WORDS]);
      expect(JSON.stringify(yours.transcript)).toContain(WORDS);
      for (const caller of REACHED) {
        const theirs = await readsOf(live, agent, caller);
        expect(theirs.items).toHaveLength(1);
        expect(JSON.stringify(theirs), JSON.stringify(caller)).not.toMatch(SERVER);
        // Its reply is refused in what it may read.
        const refused = await call(
          live,
          'reply',
          { to: yours.items[0]?.id, answer: { choice: 'once' } },
          caller,
        );
        expect(refused).toMatchObject({ ok: false, error: { code: 'refused' } });
        expect(JSON.stringify(refused)).not.toMatch(SERVER);
      }
      const notices = await told(live, name);
      expect(notices.join('\n')).not.toMatch(SERVER);
    },
  );

  it.each([
    ['the Agent SDK’s', 'b', 'Reviewer'],
    ['Codex’s', 'w', 'Worker'],
  ])(
    'once X10 stops the mirror, gives a reached token the core’s words for %s, waiting and settled; you the server’s',
    async (_which, agent, name) => {
      const owned = await both(false);
      await ok(owned, 'message', { to: agent, body: 'File it' }, ORCHESTRATOR);
      const asked = await waitingFor(
        owned,
        (item) => item.agent === agent && item.kind === 'prompt',
      );
      expect(asked.title).toBe(WORDS);
      for (const caller of REACHED) {
        const theirs = await readsOf(owned, agent, caller);
        expect(theirs.items.map(({ title }) => title)).toEqual([CORE]);
        expect(JSON.stringify(theirs.transcript)).toContain(CORE);
        expect(JSON.stringify(theirs), JSON.stringify(caller)).not.toMatch(SERVER);
        const refused = await call(
          owned,
          'reply',
          { to: asked.id, answer: { choice: 'allow' } },
          caller,
        );
        expect(refused).toMatchObject({ ok: false, error: { code: 'refused' } });
        expect(JSON.stringify(refused)).toContain(CORE);
        expect(JSON.stringify(refused)).not.toMatch(SERVER);
      }
      expect(await told(owned, name)).toContain(`${name} is waiting for the user: ${CORE}`);
      await ok(owned, 'reply', { to: asked.id, answer: { choice: 'allow' } });
      await vi.waitFor(async () => {
        expect(JSON.stringify((await readsOf(owned, agent, YOU)).transcript)).toMatch(
          /"outcome":\{"type":"choice"/,
        );
      });
      expect(JSON.stringify((await readsOf(owned, agent, YOU)).transcript)).toContain(WORDS);
      for (const caller of REACHED) {
        const settled = await readsOf(owned, agent, caller);
        expect(JSON.stringify(settled.transcript)).toContain(CORE);
        expect(JSON.stringify(settled), JSON.stringify(caller)).not.toMatch(SERVER);
      }
    },
  );
});

describe('records, messages and wait', () => {
  it('keep yours typed and value-free; a token reads none of them, nor what was decided', async () => {
    const native = raising([approval]);
    const core = await start(native.connector);
    await ok(core, 'message', { to: 'b', body: 'Clean up' }, ORCHESTRATOR);
    const [asked] = await owned(core, 1);
    await ok(core, 'reply', { to: asked?.id, answer: { choice: 'always' } });
    const { items } = await ok<{ items: Message[] }>(core, 'messages', {});
    expect(items.filter(({ kind }) => kind === 'settled')).toEqual([
      expect.objectContaining({
        body: 'You allowed Reviewer’s command from now on.',
        settled: expect.objectContaining({
          outcome: { type: 'choice', value: 'always', hint: 'allow_always' },
        }) as object,
      }),
    ]);
    for (const caller of [...REACHED, PARENT, STRANGER]) {
      const read = [
        await ok(core, 'messages', {}, caller),
        ...(caller.kind === 'outside'
          ? [await core.call('wait', { timeoutSeconds: 0 }, caller)]
          : []),
      ];
      const text = JSON.stringify(read);
      for (const word of ['allow_always', 'settled', 'from now on', 'rm -rf']) {
        expect.soft(text, `${JSON.stringify(caller)}: ${word}`).not.toContain(word);
      }
    }
  });
});

describe('conflict and error wording', () => {
  it('tells a token refused a prompt only what it may read of it: a form by the core’s words', async () => {
    const core = await start(raising([link, approval]).connector);
    await ok(core, 'message', { to: 'b', body: 'Clean up' });
    const [opened] = await owned(core, 2);
    for (const caller of REACHED) {
      const refused = await call(
        core,
        'reply',
        { to: opened?.id, answer: { choice: 'yes' } },
        caller,
      );
      expect(refused).toMatchObject({
        ok: false,
        error: {
          code: 'refused',
          sentence: expect.stringContaining(
            'MCP server “tracker” asks you to open a link',
          ) as string,
        },
      });
      expectNothingPrivate(refused, JSON.stringify(caller));
    }
    for (const caller of [PARENT, STRANGER]) {
      const missing = await call(
        core,
        'reply',
        { to: opened?.id, answer: { choice: 'yes' } },
        caller,
      );
      expect(missing).toMatchObject({ ok: false, error: { code: 'not-found' } });
      expect(JSON.stringify(missing)).not.toContain('tracker');
    }
  });

  it('tells you who settled a prompt and how; a token, none of its history', async () => {
    const core = await start(raising([approval]).connector);
    await ok(core, 'message', { to: 'b', body: 'Clean up' });
    const [asked] = await owned(core, 1);
    await ok(core, 'reply', { to: asked?.id, answer: { choice: 'always' } });
    expect(await call(core, 'reply', { to: asked?.id, answer: { choice: 'no' } })).toMatchObject({
      ok: false,
      error: { code: 'conflict', sentence: expect.stringMatching(/from now on/) as string },
    });
    // What no longer waits is in no token's reach: it is told nothing of how it was settled.
    for (const caller of [...REACHED, PARENT, STRANGER]) {
      const missing = await call(
        core,
        'reply',
        { to: asked?.id, answer: { choice: 'no' } },
        caller,
      );
      expect(missing).toMatchObject({ ok: false, error: { code: 'not-found' } });
      expect(JSON.stringify(missing)).not.toMatch(/now on|allowed|command/);
    }
  });
});

describe('notices and wait', () => {
  it('tell a token whose message waits on a prompt only the core’s words for an MCP server’s request', async () => {
    const core = await start(raising([]).connector);
    await ok(core, 'message', { to: 'b', body: 'Sign in' }, ORCHESTRATOR);
    const notices: { kind: string; body: string }[] = [];
    await vi.waitFor(
      async () => {
        // Each wait reads on from the last: what it returned is kept.
        const read = await core.call('wait', { timeoutSeconds: 0 }, ORCHESTRATOR);
        if (!read.ok) throw new Error(read.error.sentence);
        notices.push(...read.value.messages.filter(({ kind }) => kind === 'notice'));
        expect(notices.map(({ body }) => body)).toContain(
          'Reviewer is waiting for the user: MCP server “tracker” asks you to open a link',
        );
      },
      { timeout: 10_000, interval: 25 },
    );
    expectNothingPrivate(notices, 'wait');
    expectNothingPrivate(await ok(core, 'messages', {}, ORCHESTRATOR), 'messages');
  });
});
