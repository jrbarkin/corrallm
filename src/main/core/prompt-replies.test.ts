import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CanvasId } from '../../shared/canvas';
import type { Message } from '../../shared/model/messages';
import type { NeedsItem } from '../../shared/model/needs';
import type { PromptAnswer } from '../../shared/model/prompts';
import type { SessionMode } from '../../shared/session';
import type { Connector, LiveSession, SessionHost } from '../sessions/connector';
import { FakeConnector } from '../sessions/fake';
import { callTool } from '../api/mcp';
import { toolName } from '../../shared/api/registry';
import { WindowPorts } from './gui';
import { openWindow } from './test-window';
import type { AgentCaller, Caller, OutsideCaller } from './caller';
import { createCore } from './core';
import type { Core } from './core';
import { keepCanvases } from './store/test-store';
import { CALLERS, NO_DESKTOP } from './test-registry';
import { legacyDirectories } from './workspaces/test-directories';

/*
 * B13 C3 through core.call: a prompt a session raises waits in Needs as yours, through the core's
 * prompt owner; you answer it through the one reply router, on the session that raised it, after
 * its record is on disk; no token answers it, nor its own agent; and answering never starts a
 * session.
 */

const CANVAS = '9b5a6c7d-8e9f-4a0b-9c1d-2e3f4a5b6c7d' as CanvasId;
const ORCHESTRATOR: OutsideCaller = {
  kind: 'outside',
  token: 'write-token',
  name: 'orchestrator',
  access: 'write',
  merge: true,
  canvases: [CANVAS],
};
const YOU = CALLERS.you;
/** The Reviewer, as its own session's token. */
const REVIEWER: AgentCaller = {
  kind: 'agent',
  canvas: CANVAS,
  agent: 'b',
  generation: 1,
  session: 'b-session',
};
const COMMAND = 'rm -rf build # private-command-text';
const URL_SECRET = 'https://signin.example.test/link?token=private-signin-secret';

const approval = {
  kind: 'approval',
  title: 'Run the cleanup?',
  subject: { type: 'command', command: COMMAND, cwd: '/work/app' },
  answerIn: 'api',
  choices: [
    { value: 'yes', label: 'Yes', hint: 'allow_once', effects: {} },
    {
      value: 'always',
      label: 'Yes, and don’t ask again',
      hint: 'allow_always',
      effects: { rules: [{ behavior: 'allow', rule: 'rm', scope: 'session' }] },
    },
    { value: 'no', label: 'No', hint: 'reject_once', effects: {} },
  ],
};
const link = {
  kind: 'form',
  title: `Sign in at ${URL_SECRET}`,
  summary: URL_SECRET,
  answerIn: 'api',
  form: { url: URL_SECRET },
};

function canvasText(): string {
  return JSON.stringify({
    format: 'corrallm',
    version: 2,
    id: CANVAS,
    nodes: [
      {
        id: 'b',
        kind: 'agent',
        label: 'Reviewer',
        position: { x: 0, y: 0 },
        adapter: 'claude-code',
        connection: 'claude-code.sdk',
      },
    ],
    links: [],
  });
}

let profile: string;
const cores: Core[] = [];

/** Each session it started: its host, and what it was answered. */
interface Raising {
  host: SessionHost;
  answered: [string, PromptAnswer][];
  declined: [string, string][];
  dismissed: string[];
}

/**
 * A connector whose session raises the prompts the test gives, by fresh keys, as each message
 * arrives, and answers them on its own `prompts`.
 */
function raising(prompts: object[]) {
  const fake = new FakeConnector({ mode: 'acceptEdits' });
  const sessions: Raising[] = [];
  const connector: Connector<SessionMode> = {
    start: async (spec, host) => {
      const session: LiveSession<SessionMode> = await fake.start(spec, host);
      const raised: Raising = { host, answered: [], declined: [], dismissed: [] };
      sessions.push(raised);
      session.send = (message) => {
        host.emit({ type: 'user', id: message.id, text: message.text });
        host.emit({ type: 'status', status: 'working' });
        for (const prompt of prompts.splice(0)) {
          host.emit({ type: 'prompt', key: crypto.randomUUID(), prompt: prompt as never });
        }
        host.emit({ type: 'status', status: 'waiting' });
        return Promise.resolve();
      };
      Object.assign(session, {
        prompts: {
          answer: (key: string, answer: PromptAnswer) => {
            raised.answered.push([key, answer]);
          },
          decline: (key: string, why: string) => {
            raised.declined.push([key, why]);
          },
          dismiss: (key: string) => {
            raised.dismissed.push(key);
          },
        },
      });
      return session;
    },
  };
  return { connector, sessions };
}

async function start(connector: Connector<SessionMode>): Promise<Core> {
  const core = await createCore(
    {
      profile,
      app: { name: 'corrallm', version: '9.8.7' },
      check: true,
      distribution: 'local',
      directoryResolver: legacyDirectories,
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
  await core.engines.open(CANVAS);
  return core;
}

async function ok(core: Core, op: string, args: object, caller: Caller = YOU): Promise<unknown> {
  const result = await core.call(op as never, { canvas: CANVAS, ...args }, caller);
  if (!result.ok) throw new Error(`${op}: ${result.error.code}: ${result.error.sentence}`);
  return result.value;
}

function call(core: Core, op: string, args: object, caller: Caller = YOU) {
  return core.call(op as never, { canvas: CANVAS, ...args }, caller);
}

async function needsOf(core: Core, caller: Caller = YOU): Promise<NeedsItem[]> {
  return ((await ok(core, 'needs', {}, caller)) as { items: NeedsItem[] }).items;
}

/** What waits once `count` prompts of the Reviewer's do. */
async function prompts(core: Core, count = 1): Promise<NeedsItem[]> {
  let found: NeedsItem[] = [];
  await vi.waitFor(
    async () => {
      found = (await needsOf(core)).filter((item) => item.kind === 'prompt');
      expect(found).toHaveLength(count);
    },
    { timeout: 10_000, interval: 10 },
  );
  return found;
}

async function records(core: Core): Promise<Message[]> {
  return ((await ok(core, 'messages', {})) as { items: Message[] }).items.filter(
    (message) => message.kind === 'settled',
  );
}

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-prompt-replies-'));
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

describe('a prompt the core owns', () => {
  it.each(['core', 'MCP', 'window'] as const)(
    'takes feedback and id-keyed answers through %s, with value-free records',
    async (route) => {
      const native = raising([
        {
          kind: 'plan',
          title: 'Ready to implement?',
          plan: 'Read it, then change it.',
          answerIn: 'api',
          choices: [
            { value: 'yes', label: 'Yes', hint: 'allow_once', effects: {} },
            {
              value: 'revise',
              label: 'Keep planning',
              hint: 'reject_once',
              effects: {},
              feedback: 'optional',
            },
          ],
        },
        {
          kind: 'question',
          title: 'Choose the work',
          answerIn: 'api',
          questions: [
            {
              id: 'branch',
              header: 'Branch',
              text: 'Which branch?',
              options: [{ label: 'main' }],
              multiple: false,
              other: false,
            },
            {
              id: 'checks',
              header: 'Checks',
              text: 'Which checks?',
              options: [],
              multiple: false,
              other: true,
            },
          ],
        },
        { ...link, server: 'fixture-server' },
      ]);
      const core = await start(native.connector);
      await ok(core, 'message', { to: 'b', body: 'Review it' });
      const asked = await prompts(core, 3);
      const window = route === 'window' ? openWindow(new WindowPorts(core), 1) : undefined;
      const replies = [
        { choice: 'revise', feedback: 'Keep the first step small' },
        { answers: { branch: { picked: ['main'] }, checks: { text: 'Run the full suite' } } },
        { form: { action: 'accept' } },
      ];
      try {
        for (const [i, answer] of replies.entries()) {
          const args = { canvas: CANVAS, to: asked[i]?.id, answer };
          if (route === 'core') {
            expect(await call(core, 'reply', args)).toMatchObject({
              ok: true,
              value: { outcome: 'answered' },
            });
          } else if (route === 'MCP') {
            const result = await callTool(core, YOU, toolName('reply'), args);
            expect(result.isError).not.toBe(true);
            expect(result.structuredContent).toMatchObject({ outcome: 'answered' });
          } else {
            expect(await window?.link.request('call', 'reply', args)).toMatchObject({
              ok: true,
              value: { ok: true, value: { outcome: 'answered' } },
            });
          }
        }
      } finally {
        window?.close();
      }
      expect(native.sessions[0]?.answered.map(([, answer]) => answer)).toEqual([
        { kind: 'choice', value: 'revise', feedback: 'Keep the first step small' },
        { kind: 'questions', answers: replies[1]?.answers },
        { kind: 'form', action: 'accept' },
      ]);
      const settled = await records(core);
      expect(settled).toHaveLength(3);
      expect(settled.map(({ settled }) => settled?.outcome.type)).toEqual([
        'choice',
        'answers',
        'form',
      ]);
      for (const words of ['Keep the first step small', 'Run the full suite', URL_SECRET]) {
        expect(JSON.stringify(settled)).not.toContain(words);
      }
    },
  );

  it('settles Not waiting through the registered receipt, with no decision record or native answer', async () => {
    const native = raising([
      { kind: 'approval', title: 'See its terminal', answerIn: 'terminal', choices: [] },
    ]);
    const core = await start(native.connector);
    await ok(core, 'message', { to: 'b', body: 'Go on' });
    const [asked] = await prompts(core);
    expect(
      await call(core, 'reply', { to: asked?.id, answer: { choice: 'not-waiting' } }),
    ).toMatchObject({ ok: true, value: { outcome: 'dismissed' } });
    expect(native.sessions[0]?.dismissed).toHaveLength(1);
    expect(native.sessions[0]?.answered).toEqual([]);
    expect(await records(core)).toEqual([]);
    expect(await prompts(core, 0)).toEqual([]);
  });

  it('refuses a token’s typed form answer in the selector’s words and preserves the current prompt', async () => {
    const native = raising([{ ...link, server: 'fixture-server' }]);
    const core = await start(native.connector);
    await ok(core, 'message', { to: 'b', body: 'Review it' });
    const [asked] = await prompts(core);
    const [seen] = await needsOf(core, ORCHESTRATOR);
    expect(seen?.prompt).toMatchObject({ kind: 'form', server: 'fixture-server' });
    for (const answer of [
      { form: { action: 'accept' } },
      { choice: 'no', feedback: 'Use a different approach' },
      { answers: { q: { text: 'An answer' } } },
    ]) {
      const result = await call(core, 'reply', { to: asked?.id, answer }, ORCHESTRATOR);
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'refused', sentence: expect.stringContaining(seen?.title ?? '') as string },
      });
      expect(JSON.stringify(result)).not.toContain(URL_SECRET);
    }
    expect(native.sessions[0]?.answered).toEqual([]);
    expect(await prompts(core)).toHaveLength(1);
  });

  it('waits in Needs as yours, with its choices; a token sees it without them, and a form by the core’s title', async () => {
    const native = raising([approval, link]);
    const core = await start(native.connector);
    await ok(core, 'message', { to: 'b', body: 'Clean up' });
    const [asked, form] = await prompts(core, 2);
    expect(asked).toMatchObject({
      agent: 'b',
      for: 'you',
      by: ['you'],
      title: 'Run the cleanup?',
      answerIn: 'api',
      choices: [
        { value: 'yes', label: 'Yes' },
        { value: 'always', humanOnly: expect.any(String) as string },
        { value: 'no', label: 'No' },
      ],
    });
    expect(asked?.id).toMatch(/^prompt\/b\/\d+\/[0-9a-f-]{36}$/);
    expect(form).toMatchObject({ form: { url: URL_SECRET } });
    expect(form?.title).not.toContain('example.test');
    const seen = await needsOf(core, ORCHESTRATOR);
    expect(seen.map(({ id }) => id)).toEqual([asked?.id, form?.id]);
    for (const item of seen) {
      expect(item.choices).toEqual([]);
      expect(item).not.toHaveProperty('form');
    }
    for (const part of [URL_SECRET, 'signin.example.test', 'private-signin-secret']) {
      expect(JSON.stringify(seen)).not.toContain(part);
    }
  });

  it('is answered by you on the session that raised it, recorded first, with no command in the record', async () => {
    const native = raising([approval]);
    const core = await start(native.connector);
    await ok(core, 'message', { to: 'b', body: 'Clean up' });
    const [asked] = await prompts(core);
    const result = (await ok(core, 'reply', { to: asked?.id, answer: { choice: 'yes' } })) as {
      id: string;
      outcome: string;
    };
    expect(result.outcome).toBe('answered');
    expect(native.sessions[0]?.answered).toEqual([
      [expect.any(String), { kind: 'choice', value: 'yes' }],
    ]);
    expect(await prompts(core, 0)).toEqual([]);
    const [record] = await records(core);
    expect(record).toMatchObject({
      id: result.id,
      by: 'you',
      state: 'delivered',
      body: 'You allowed Reviewer’s command once.',
    });
    expect(JSON.stringify(await records(core))).not.toContain('rm -rf');
    // Once: a second answer is a conflict naming who settled it.
    expect(await call(core, 'reply', { to: asked?.id, answer: { choice: 'no' } })).toMatchObject({
      ok: false,
      error: { code: 'conflict', sentence: expect.stringMatching(/You allowed/) as string },
    });
    expect(native.sessions[0]?.answered).toHaveLength(1);
  });

  it('records what was decided, typed and value-free, read by you alone, across a restart too', async () => {
    const native = raising([approval]);
    const core = await start(native.connector);
    await ok(core, 'message', { to: 'b', body: 'Clean up' }, ORCHESTRATOR);
    const [asked] = await prompts(core);
    const id = asked?.id ?? '';
    await ok(core, 'reply', { to: id, answer: { choice: 'always' } });
    const decided = {
      v: 1,
      need: id,
      prompt: { id: id.split('/').at(-1), kind: 'approval', subject: 'command' },
      outcome: { type: 'choice', value: 'always', hint: 'allow_always' },
    };
    expect(await records(core)).toEqual([
      expect.objectContaining({
        body: 'You allowed Reviewer’s command from now on.',
        settled: decided,
      }),
    ]);
    // A token reads no record of yours, and nothing of what was decided.
    for (const read of [
      await ok(core, 'messages', {}, ORCHESTRATOR),
      await core.call('wait', { timeoutSeconds: 0 }, ORCHESTRATOR),
    ]) {
      expect(JSON.stringify(read)).not.toContain('allow_always');
      expect(JSON.stringify(read)).not.toContain('settled');
    }
    await core.close();
    const again = await start(raising([]).connector);
    expect(await records(again)).toEqual([
      expect.objectContaining({ state: 'delivered', settled: decided }),
    ]);
  });

  it('is never answered by a token, nor by its own agent, nor with what it doesn’t offer', async () => {
    const native = raising([approval]);
    const core = await start(native.connector);
    await ok(core, 'message', { to: 'b', body: 'Clean up' });
    const [asked] = await prompts(core);
    for (const answer of [{ choice: 'yes' }, { choice: 'no' }, { choice: 'always' }]) {
      expect(await call(core, 'reply', { to: asked?.id, answer }, ORCHESTRATOR)).toMatchObject({
        ok: false,
        error: { code: 'refused' },
      });
    }
    expect(
      await call(core, 'reply', { to: asked?.id, answer: { choice: 'yes' } }, REVIEWER),
    ).toMatchObject({
      ok: false,
      error: {
        code: 'refused',
        sentence: expect.stringMatching(/never answers what waits on itself/) as string,
      },
    });
    for (const answer of [
      { choice: 'maybe' },
      { choice: 'yes', text: 'and more' },
      { permission: 'once' },
      { text: 'Go on' },
    ]) {
      expect
        .soft(await call(core, 'reply', { to: asked?.id, answer }), JSON.stringify(answer))
        .toMatchObject({
          ok: false,
          error: { code: 'invalid' },
        });
    }
    expect(native.sessions[0]?.answered).toEqual([]);
    expect(await records(core)).toEqual([]);
    expect(await prompts(core)).toHaveLength(1);
  });

  it('offers Not waiting on a terminal’s wait raised from its report alone, yours: never a token’s', async () => {
    const waiting = {
      kind: 'approval',
      title: 'Claude Code is waiting for you.',
      answerIn: 'terminal',
      choices: [],
    };
    const native = raising([waiting]);
    const core = await start(native.connector);
    await ok(core, 'message', { to: 'b', body: 'Go on' });
    const [asked] = await prompts(core);
    expect(asked).toMatchObject({
      title: 'Claude Code is waiting for you.',
      answerIn: 'terminal',
      choices: [
        { value: 'not-waiting', label: 'Not waiting', humanOnly: expect.any(String) as string },
      ],
    });
    const [seen] = await needsOf(core, ORCHESTRATOR);
    expect(seen?.choices).toEqual([]);
    for (const caller of [ORCHESTRATOR, REVIEWER]) {
      expect(
        await call(core, 'reply', { to: asked?.id, answer: { choice: 'not-waiting' } }, caller),
      ).toMatchObject({ ok: false, error: { code: 'refused' } });
    }
    expect(await prompts(core)).toHaveLength(1);
    expect(await records(core)).toEqual([]);
  });

  it('is never answered once its session has ended, and answering starts no session', async () => {
    const native = raising([approval]);
    const started = vi.spyOn(native.connector, 'start');
    const core = await start(native.connector);
    await ok(core, 'message', { to: 'b', body: 'Clean up' });
    const [asked] = await prompts(core);
    native.sessions[0]?.host.emit({ type: 'closed' });
    await prompts(core, 0);
    expect(await call(core, 'reply', { to: asked?.id, answer: { choice: 'yes' } })).toMatchObject({
      ok: false,
      error: { code: 'conflict', sentence: expect.stringMatching(/withdrawn/) as string },
    });
    expect(started).toHaveBeenCalledOnce();
    expect(native.sessions[0]?.answered).toEqual([]);
  });

  it('is answered through the owner when its session also shows it as one of the events B13 replaces (until X10)', async () => {
    const fake = new FakeConnector({ mode: 'acceptEdits' });
    const key = crypto.randomUUID();
    const told: [string, PromptAnswer][] = [];
    const old: unknown[] = [];
    const connector: Connector<SessionMode> = {
      start: async (spec, host) => {
        const session: LiveSession<SessionMode> = await fake.start(spec, host);
        session.send = (message) => {
          host.emit({ type: 'user', id: message.id, text: message.text });
          host.emit({ type: 'prompt', key, prompt: tool as never });
          host.emit({
            type: 'permission',
            id: 'toolu_1:prompt',
            tool: 'Bash',
            summary: 'touch made.txt',
            always: null,
          });
          host.emit({ type: 'status', status: 'waiting' });
          return Promise.resolve();
        };
        host.bridge?.((id, answer) => {
          if (id !== 'toolu_1:prompt') throw new Error('That request is no longer asked.');
          if (answer.kind !== 'permission' || answer.answer === 'always')
            throw new Error('That prompt doesn’t offer "always".');
          return {
            key,
            answer: { kind: 'choice', value: answer.answer === 'once' ? 'allow' : 'deny' },
          };
        });
        Object.assign(session, {
          answer: (...args: unknown[]) => {
            old.push(args);
            return Promise.reject(new Error('answered only through the owner'));
          },
          prompts: {
            answer: (answered: string, answer: PromptAnswer) => {
              told.push([answered, answer]);
            },
            decline: () => undefined,
          },
        });
        return session;
      },
    };
    const tool = {
      kind: 'approval',
      title: 'Claude wants to use Bash',
      subject: { type: 'tool', tool: 'Bash', input: { command: 'touch made.txt' } },
      answerIn: 'api',
      choices: [
        { value: 'allow', label: 'Yes', hint: 'allow_once', effects: {} },
        { value: 'deny', label: 'No', hint: 'reject_once', effects: {}, endsTurn: true },
      ],
    };
    const core = await start(connector);
    await ok(core, 'message', { to: 'b', body: 'Touch it' });
    // One item: the old event's, which the window's card answers, standing for the owner's.
    const [asked] = await prompts(core);
    expect(asked?.id).toMatch(/^prompt\/b\/\d+\/toolu_1:prompt$/);
    expect(
      await call(core, 'reply', { to: asked?.id, answer: { permission: 'always' } }),
    ).toMatchObject({ ok: false, error: { code: 'invalid' } });
    // No token answers it this way either.
    expect(
      await call(core, 'reply', { to: asked?.id, answer: { permission: 'once' } }, ORCHESTRATOR),
    ).toMatchObject({ ok: false, error: { code: 'refused' } });
    expect(told).toEqual([]);
    const result = (await ok(core, 'reply', {
      to: asked?.id,
      answer: { permission: 'once' },
    })) as { id: string; outcome: string };
    expect(result.outcome).toBe('answered');
    // Through the owner, by its key: never the old way.
    expect(told).toEqual([[key, { kind: 'choice', value: 'allow' }]]);
    expect(old).toEqual([]);
    const [record] = await records(core);
    expect(record).toMatchObject({
      id: result.id,
      by: 'you',
      state: 'delivered',
      body: 'You allowed Reviewer’s tool call once.',
    });
    expect(JSON.stringify(await records(core))).not.toContain('touch');
    // The card shows it answered; a second answer is a conflict naming who settled it.
    const transcript = (await ok(core, 'session.transcript', { agent: 'b' })) as {
      entries: { id: string; kind: string; answer?: string }[];
    };
    expect(transcript.entries.find(({ id }) => id === 'toolu_1:prompt')).toMatchObject({
      answer: 'once',
    });
    expect(await prompts(core, 0)).toEqual([]);
    expect(
      await call(core, 'reply', { to: asked?.id, answer: { permission: 'deny' } }),
    ).toMatchObject({
      ok: false,
      error: { code: 'conflict', sentence: expect.stringMatching(/You allowed/) as string },
    });
    expect(told).toHaveLength(1);
  });

  it('shows a reached token an MCP server’s request only in the core’s words, while you see its form', async () => {
    const fake = new FakeConnector({ mode: 'acceptEdits' });
    const url = 'https://tracker.example.test/sign-in?state=link-private';
    const connector: Connector<SessionMode> = {
      start: async (spec, host) => {
        const session: LiveSession<SessionMode> = await fake.start(spec, host);
        session.send = (message) => {
          host.emit({ type: 'user', id: message.id, text: message.text });
          host.emit({
            type: 'elicitation',
            id: 'elicitation:link',
            server: 'tracker',
            message: 'Sign in at tracker.example.test/sign-in%3Fstate%3Dlink-private',
            url,
          });
          host.emit({
            type: 'elicitation',
            id: 'elicitation:form',
            server: 'tracker',
            message: 'Paste the key from tracker.example.test/k%3Ftoken%3Dform-private',
            fields: [{ name: 'key', label: 'Key', required: true, kind: 'text' }],
          });
          host.emit({ type: 'status', status: 'waiting' });
          return Promise.resolve();
        };
        return session;
      },
    };
    const words = ['link-private', 'form-private', 'Sign in at', 'Paste the key', 'example.test'];
    const core = await start(connector);
    await ok(core, 'message', { to: 'b', body: 'Connect the tracker' }, ORCHESTRATOR);
    const [link, form] = await prompts(core, 2);
    const titles = {
      link: 'MCP server “tracker” asks you to open a link',
      form: 'MCP server “tracker” asks you to fill in a form',
    };
    // Yours: titled in the core's words too, the link's form yours to open.
    expect(link).toMatchObject({ title: titles.link, form: { url } });
    expect(form).toMatchObject({ title: titles.form });
    // A reached token's reads: Needs, the transcript and what it is told, in the core's words only.
    const needs = await needsOf(core, ORCHESTRATOR);
    expect(needs.map(({ title }) => title)).toEqual([titles.link, titles.form]);
    const transcript = (await ok(core, 'session.transcript', { agent: 'b' }, ORCHESTRATOR)) as {
      entries: { id: string; kind: string; message?: string }[];
    };
    const asked = transcript.entries.filter(({ kind }) => kind === 'elicitation');
    expect(asked.map(({ message }) => message)).toEqual([titles.link, titles.form]);
    for (const entry of asked) {
      expect(entry).not.toHaveProperty('url');
      expect(entry).not.toHaveProperty('fields');
    }
    let told: string[] = [];
    await vi.waitFor(async () => {
      told = ((await ok(core, 'messages', {}, ORCHESTRATOR)) as { items: Message[] }).items.map(
        ({ body }) => body,
      );
      expect(told).toContainEqual(expect.stringContaining('is waiting for the user'));
    });
    for (const read of [needs, transcript, told]) {
      for (const word of words) expect.soft(JSON.stringify(read)).not.toContain(word);
    }
    // Yours, the card: the form as its server words it, and the link to open.
    const card = (await ok(core, 'session.transcript', { agent: 'b' })) as {
      entries: { id: string; kind: string; message?: string; url?: string; fields?: unknown[] }[];
    };
    expect(card.entries.find(({ id }) => id === 'elicitation:form')).toMatchObject({
      message: 'Paste the key from tracker.example.test/k%3Ftoken%3Dform-private',
      fields: [{ name: 'key' }],
    });
    expect(card.entries.find(({ id }) => id === 'elicitation:link')).toMatchObject({ url });
  });

  it('declines what it can’t show whole, its transcript saying why', async () => {
    const native = raising([{ ...approval, title: 'x'.repeat(5000) }]);
    const core = await start(native.connector);
    await ok(core, 'message', { to: 'b', body: 'Clean up' });
    await vi.waitFor(() => {
      expect(native.sessions[0]?.declined).toEqual([[expect.any(String), expect.any(String)]]);
    });
    expect(await prompts(core, 0)).toEqual([]);
    await vi.waitFor(async () => {
      const transcript = (await ok(core, 'session.transcript', { agent: 'b' })) as {
        entries: { kind: string; text?: string }[];
      };
      expect(transcript.entries).toContainEqual(
        expect.objectContaining({
          kind: 'notice',
          text: expect.stringMatching(/^corrallm declined a request from Reviewer’s CLI/) as string,
        }),
      );
    });
  });
});
