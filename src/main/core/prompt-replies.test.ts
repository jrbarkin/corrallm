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
  canvases: [CANVAS],
};
const YOU = CALLERS.you;
/** The Reviewer, as its own session's token. */
const REVIEWER: AgentCaller = { kind: 'agent', canvas: CANVAS, agent: 'b', session: 'b-session' };
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
      const raised: Raising = { host, answered: [], declined: [] };
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
