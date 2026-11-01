import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_PAGE_BYTES } from '../../shared/api/limits';
import type { RuntimeTopicKey, TopicUpdate } from '../../shared/api/topics';
import type { CanvasId } from '../../shared/canvas';
import type { Message } from '../../shared/model/messages';
import type { NeedsItem } from '../../shared/model/needs';
import type { PromptAnswer } from '../../shared/model/prompts';
import type { EntryView } from '../../shared/model/views';
import type { SessionMode, UserMessage } from '../../shared/session';
import type { Connector, SessionHost } from '../sessions/connector';
import type { Caller, OutsideCaller } from './caller';
import { createCore } from './core';
import type { Core } from './core';
import { STALL_MS, WATCH_EVERY_MS } from './stalled';
import { keepCanvases } from './store/test-store';
import { CALLERS, NO_DESKTOP } from './test-registry';
import { legacyDirectories } from './workspaces/test-directories';

/*
 * B13 C9 through createCore: the core's prompt owner as the one publisher of what its agents'
 * sessions ask, and what reads it. Each prompt it lists is placed in its agent's transcript and
 * session topic as it is raised and settled there as it ends, its agent's summary republished
 * with its count; delivery holds a party's message while the agent waits on one, and tells a
 * token whose message's turn waits on one, in what it may read; the watchdog never takes a wait
 * for silence; `agents` and `status` say the agent waits; a page cuts one too big for it, and
 * marks it; closing its canvas ends what it asked.
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
const SESSION = `session:${CANVAS}:b` as RuntimeTopicKey;
const SESSIONS = `sessions:${CANVAS}` as RuntimeTopicKey;

const approval = {
  kind: 'approval',
  title: 'Run the cleanup?',
  subject: { type: 'command', command: 'rm -rf build', cwd: '/work/app' },
  answerIn: 'api',
  choices: [
    { value: 'yes', label: 'Yes', hint: 'allow_once', effects: {} },
    { value: 'no', label: 'No', hint: 'reject_once', effects: {} },
  ],
};
const LINK = 'https://signin.example.test/link?token=private-signin-secret';
const link = {
  kind: 'form',
  title: `Sign in at ${LINK}`,
  summary: `private-form-message: ${LINK}`,
  server: 'tracker',
  answerIn: 'api',
  form: { url: LINK },
};

let profile: string;
let core: Core;
let now: number;
let tick: (() => void) | undefined;
/** Each session started, by agent, newest last. */
let hosts: SessionHost[];
let sent: UserMessage[];
let answered: [string, PromptAnswer][];
let declined: string[];
/** What a session does as it starts, and as it is sent a message (after saying it works). */
let onStart: (host: SessionHost) => void;
let onSend: (host: SessionHost, message: UserMessage) => void;
/** The keys of the prompts the test's sessions raised, in order. */
let keys: string[];

/** The key of the `n`th prompt raised (0: the first). */
function keyOf(n: number): string {
  const key = keys[n];
  if (key === undefined) throw new Error(`No prompt ${String(n)} was raised`);
  return key;
}

/** Raises `prompt` from `host`'s session under a fresh key, which it returns. */
function raise(host: SessionHost, prompt: object): string {
  const key = crypto.randomUUID();
  host.emit({ type: 'prompt', key, prompt: prompt as never });
  return key;
}

function host(): SessionHost {
  const last = hosts.at(-1);
  if (last === undefined) throw new Error('No session started');
  return last;
}

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-prompt-integration-'));
  const project = path.join(profile, 'project');
  await mkdir(project);
  const file = path.join(profile, 'team.corral');
  const node = (id: string, label: string, x: number) => ({
    id,
    kind: 'agent',
    label,
    position: { x, y: 0 },
    adapter: 'claude-code',
    connection: 'claude-code.sdk',
  });
  await writeFile(
    file,
    JSON.stringify({
      format: 'corrallm',
      version: 2,
      id: CANVAS,
      nodes: [node('b', 'Reviewer', 0), node('l', 'Linker', 200)],
      links: [{ agents: ['l', 'b'] }],
    }),
  );
  await keepCanvases(profile, { [CANVAS]: { file, project } });
  now = Date.now();
  tick = undefined;
  hosts = [];
  sent = [];
  answered = [];
  declined = [];
  onStart = () => undefined;
  onSend = () => undefined;
  keys = [];
  const connector: Connector<SessionMode> = {
    start: (_spec, given) => {
      hosts.push(given);
      given.emit({ type: 'started', model: null, mode: 'acceptEdits', models: [] });
      onStart(given);
      return Promise.resolve({
        send: (message) => {
          sent.push(message);
          given.emit({ type: 'user', id: message.id, text: message.text });
          given.emit({ type: 'status', status: 'working' });
          onSend(given, message);
          return Promise.resolve();
        },
        answer: () => Promise.resolve(),
        interrupt: () => Promise.resolve(),
        close: () => Promise.resolve(),
        setMode: () => Promise.resolve(),
        setModel: () => Promise.resolve(),
        prompts: {
          answer: (key, answer) => {
            answered.push([key, answer]);
          },
          decline: (key) => {
            declined.push(key);
          },
        },
      });
    },
  };
  core = await createCore(
    {
      profile,
      app: { name: 'corrallm', version: '9.8.7' },
      check: true,
      distribution: 'local',
      directoryResolver: legacyDirectories,
      leads: (_canvas, id) => id === 'l',
      watchdog: {
        now: () => now,
        later: (run) => {
          tick = run;
          return () => {
            tick = undefined;
          };
        },
      },
      watchdogNetwork: () => ({}),
      sessions: {
        connectors: { 'claude-code.sdk': connector },
        environment: () => Promise.resolve({}),
      },
      watchFolder: () => ({ close: () => undefined }),
    },
    NO_DESKTOP,
  );
  await core.engines.open(CANVAS);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await core.close().catch(() => undefined);
  await rm(profile, { recursive: true, force: true });
});

async function ok<T = unknown>(op: string, args: object, caller: Caller = YOU): Promise<T> {
  const result = await core.call(op as never, { canvas: CANVAS, ...args }, caller);
  if (!result.ok) throw new Error(`${op}: ${result.error.code}: ${result.error.sentence}`);
  return result.value;
}

/** The owner's prompts of the Reviewer's waiting in your Needs, once `count` do. */
async function owned(count: number): Promise<NeedsItem[]> {
  let found: NeedsItem[] = [];
  await vi.waitFor(
    async () => {
      found = (await ok<{ items: NeedsItem[] }>('needs', {})).items.filter(
        ({ id, agent }) => agent === 'b' && /^prompt\/b\/\d+\/[0-9a-f-]{36}$/.test(id),
      );
      expect(found).toHaveLength(count);
    },
    { timeout: 10_000, interval: 10 },
  );
  return found;
}

/** The prompt entries of the Reviewer's transcript, as `caller` reads them on one page. */
async function promptEntries(caller: Caller = YOU) {
  const { entries } = await ok<{ entries: EntryView[] }>(
    'session.transcript',
    { agent: 'b', limit: 200 },
    caller,
  );
  return entries.filter((entry) => entry.kind === 'prompt');
}

/** Follows `topic` as you, keeping every update it publishes. */
async function follow(topic: RuntimeTopicKey): Promise<TopicUpdate[]> {
  const heard: TopicUpdate[] = [];
  const { stop } = await core.topics.follow(YOU, topic, (updates) => {
    heard.push(...updates);
  });
  stops.push(stop);
  return heard;
}
const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

/** The Reviewer's prompt count in each summary its canvas's sessions topic published. */
function counts(heard: readonly TopicUpdate[]): number[] {
  return heard.flatMap((update) => {
    const summary = (update as { agents?: { set?: Record<string, { prompts: number }> } }).agents
      ?.set?.b;
    return summary === undefined ? [] : [summary.prompts];
  });
}

/** The prompt entries the Reviewer's session topic published, upserted, in order. */
function upserted(heard: readonly TopicUpdate[]): EntryView[] {
  return heard.flatMap((update) =>
    ((update as { entries?: { upsert?: EntryView[] } }).entries?.upsert ?? []).filter(
      (entry) => entry.kind === 'prompt',
    ),
  );
}

describe('the canonical publisher', () => {
  it('places each prompt in its agent’s session topic as raised, settles it there, and republishes its count', async () => {
    onSend = (given) => {
      keys.push(raise(given, approval), raise(given, link));
    };
    const sessions = await follow(SESSIONS);
    const session = await follow(SESSION);
    await ok('message', { to: 'b', body: 'Clean up' });
    const [asked, opened] = await owned(2);
    await vi.waitFor(() => {
      expect(counts(sessions).at(-1)).toBe(2);
      expect(upserted(session).map(({ id }) => id)).toEqual([
        asked?.prompt?.id,
        opened?.prompt?.id,
      ]);
    });
    expect(upserted(session)[0]).toMatchObject({
      kind: 'prompt',
      need: asked?.id,
      prompt: { kind: 'approval', subject: approval.subject, choices: asked?.choices },
    });
    expect(upserted(session)[0]).not.toHaveProperty('outcome');
    await ok('reply', { to: asked?.id, answer: { choice: 'yes' } });
    await vi.waitFor(() => {
      expect(counts(sessions).at(-1)).toBe(1);
      expect(upserted(session).at(-1)).toEqual({
        id: asked?.prompt?.id,
        kind: 'prompt',
        need: asked?.id,
        prompt: {
          id: asked?.prompt?.id,
          kind: 'approval',
          agent: 'b',
          raised: asked?.prompt?.raised,
          answerIn: 'api',
          title: approval.title,
        },
        outcome: { type: 'choice', value: 'yes', hint: 'allow_once', by: 'you' },
      });
    });
    // Withdrawn by its session: settled so, and counted no more.
    expect(answered).toEqual([[keyOf(0), { kind: 'choice', value: 'yes' }]]);
    host().emit({ type: 'prompt-ended', key: keyOf(1), reason: 'withdrawn' });
    await vi.waitFor(() => {
      expect(counts(sessions).at(-1)).toBe(0);
      expect(upserted(session).at(-1)).toMatchObject({
        id: opened?.prompt?.id,
        outcome: { type: 'withdrawn' },
      });
    });
    // The transcript, read as the topic gives it.
    const read = await core.topics.read(SESSION, YOU);
    if (!read.ok) throw new Error(read.error.sentence);
    const state = read.value as { entries: Record<string, EntryView>; order: string[] };
    expect(await promptEntries()).toEqual(
      state.order.flatMap((id) =>
        state.entries[id]?.kind === 'prompt' ? [state.entries[id]] : [],
      ),
    );
  });

  it('cuts a prompt too big for one page and marks it so, its ids whole; the topic gives it whole', async () => {
    const command = `echo ${'x'.repeat(62 * 1024)}`;
    onSend = (given) => {
      raise(given, { ...approval, subject: { type: 'command', command, cwd: '/work/app' } });
    };
    await ok('message', { to: 'b', body: 'Clean up' });
    const [asked] = await owned(1);
    const { entries } = await ok<{ entries: EntryView[] }>('session.transcript', {
      agent: 'b',
      after: (await ok<{ entries: EntryView[] }>('session.transcript', { agent: 'b' })).entries
        .filter(({ kind }) => kind !== 'prompt')
        .at(-1)?.id,
    });
    const [page] = entries;
    expect(page).toMatchObject({
      id: asked?.prompt?.id,
      kind: 'prompt',
      need: asked?.id,
      cut: true,
      prompt: { id: asked?.prompt?.id, kind: 'approval', agent: 'b' },
    });
    expect(Buffer.byteLength(JSON.stringify(entries))).toBeLessThanOrEqual(MAX_PAGE_BYTES);
    const read = await core.topics.read(SESSION, YOU);
    if (!read.ok) throw new Error(read.error.sentence);
    const whole = (read.value as { entries: Record<string, EntryView> }).entries[
      asked?.prompt?.id ?? ''
    ];
    expect(whole).toMatchObject({ prompt: { subject: { command } } });
    expect(whole).not.toHaveProperty('cut');
  });
});

describe('delivery', () => {
  it('holds a party’s message while its agent waits on a prompt, even with its session idle, and delivers it once that ends', async () => {
    onStart = (given) => {
      keys.push(raise(given, link));
    };
    await ok('message', { to: 'b', body: 'Party work' }, ORCHESTRATOR);
    await owned(1);
    // Its session started, and asks something: the message waits.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(sent).toEqual([]);
    const { agents } = await ok<{ agents: { id: string; state: string }[] }>('agents', {});
    expect(agents.find(({ id }) => id === 'b')?.state).toBe('waiting');
    const status = await ok<{ agents: { id: string; state: string }[] }>(
      'status',
      {},
      ORCHESTRATOR,
    );
    expect(status.agents.find(({ id }) => id === 'b')?.state).toBe('waiting');
    host().emit({ type: 'prompt-ended', key: keyOf(0), reason: 'withdrawn' });
    await vi.waitFor(() => {
      expect(sent.map(({ text }) => text)).toEqual([expect.stringContaining('Party work')]);
    });
  });

  it('tells a token whose message’s turn waits on a prompt, once, in what it may read of it', async () => {
    onSend = (given) => {
      raise(given, link);
    };
    await ok('message', { to: 'b', body: 'Sign in' }, ORCHESTRATOR);
    await owned(1);
    let notices: Message[] = [];
    await vi.waitFor(
      async () => {
        const { items } = await ok<{ items: Message[] }>('messages', {}, ORCHESTRATOR);
        notices = items.filter(({ kind }) => kind === 'notice');
        expect(notices.map(({ body }) => body)).toEqual([
          'Reviewer is waiting for the user: MCP server “tracker” asks you to open a link',
        ]);
      },
      { timeout: 10_000, interval: 25 },
    );
    expect(JSON.stringify(notices)).not.toMatch(/private-|signin\.example/);
  });
});

describe('the watchdog', () => {
  it('never takes a turn waiting on a prompt for silence, and counts silence from the wait’s end', async () => {
    onSend = (given) => {
      keys.push(raise(given, approval));
    };
    await ok('message', { to: 'b', body: 'Clean up' }, ORCHESTRATOR);
    await owned(1);
    const ticks = async (ms: number) => {
      for (let i = 0; i < ms / WATCH_EVERY_MS; i++) {
        now += WATCH_EVERY_MS;
        tick?.();
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    };
    const stalled = async () =>
      (await ok<{ items: NeedsItem[] }>('needs', {})).items.some(({ id }) => id === 'stalled/b');
    await ticks(STALL_MS * 2);
    expect(await stalled()).toBe(false);
    host().emit({ type: 'prompt-ended', key: keyOf(0), reason: 'withdrawn' });
    await vi.waitFor(async () => {
      expect(await owned(0)).toEqual([]);
    });
    await ticks(STALL_MS - 2 * WATCH_EVERY_MS);
    expect(await stalled()).toBe(false);
    await ticks(2 * WATCH_EVERY_MS);
    await vi.waitFor(async () => {
      expect(await stalled()).toBe(true);
    });
  });
});

describe('the close barrier', () => {
  it('ends what an agent asked as its canvas closes; nothing of it answers once open again', async () => {
    onSend = (given) => {
      keys.push(raise(given, approval));
    };
    await ok('message', { to: 'b', body: 'Clean up' });
    const [asked] = await owned(1);
    const old = host();
    await core.engines.closeCanvas(CANVAS);
    // What its session raises once its canvas is closing or closed is declined, never kept.
    const late = raise(old, approval);
    expect(declined).toContain(late);
    await core.engines.open(CANVAS);
    expect(await owned(0)).toEqual([]);
    const reply = await core.call(
      'reply',
      { canvas: CANVAS, to: asked?.id, answer: { choice: 'yes' } },
      YOU,
    );
    expect(reply.ok).toBe(false);
    expect(answered).toEqual([]);
  });
});
