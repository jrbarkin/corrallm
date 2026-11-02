import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PromptEvent } from '../../../../shared/model/prompts';
import { entryFor } from '../../../../shared/model/prompt-views';
import type { CodexMode, SessionAnswer, SessionEvent } from '../../../../shared/session';
import type { UsageBackendId } from '../../../../shared/adapter';
import type { UsageWindows } from '../../../../shared/usage';
import type { Bridge, HostEvent, LiveSession, SessionSpec } from '../../connector';
import { AppServerConnector } from './connector';
import type { AppServerConnectorDeps } from './connector';
import type { Fixture } from './recorded';
import { replay } from './replay';
import type { SpawnAppServer } from '../rpc';

/** A fake `codex` that speaks the app server's protocol (../fake-codex.mjs), run with node. */
const FAKE = fileURLToPath(new URL('../fake-codex.mjs', import.meta.url));

/*
 * What these tests check is the protocol between the connector and its app server, so the fake
 * runs in a worker thread of this process (`inProcess`): its stdio the worker's streams, its
 * environment and folder those a spawn gives it, a signal emitted on its process, its exit the
 * worker's. The commands it runs are still real processes. A few tests run it as a process of
 * its own (`asProcess`), as Codex runs: an ordinary turn, its crash, and the facts it reports
 * about its own process.
 */

/** Starts the fake in a worker: where it runs, then the fake itself. */
const BOOT = new URL(
  `data:text/javascript,${encodeURIComponent(`
import { parentPort, workerData } from 'node:worker_threads';
process.cwd = () => workerData.cwd;
parentPort.on('message', (signal) => {
  process.emit(signal, signal);
});
parentPort.unref();
await import(workerData.fake);
`)}`,
);

/** Workers still running, ended after each test as a process group would be. */
const workers = new Set<Worker>();

/** The fake in a worker of this process, as a child process for the connector to speak to. */
function inProcess(
  args: readonly string[],
  options: { cwd?: string | URL | undefined; env?: NodeJS.ProcessEnv | undefined },
): ChildProcessWithoutNullStreams {
  const worker = new Worker(BOOT, {
    argv: [FAKE, ...args],
    env: { ...options.env },
    stdin: true,
    stdout: true,
    stderr: true,
    workerData: { cwd: String(options.cwd ?? process.cwd()), fake: pathToFileURL(FAKE).href },
  });
  workers.add(worker);
  const child = Object.assign(new EventEmitter(), {
    stdin: worker.stdin,
    stdout: worker.stdout,
    stderr: worker.stderr,
    kill: (signal: NodeJS.Signals = 'SIGTERM') => {
      worker.postMessage(signal);
      return true;
    },
  });
  // 'close' once it has exited and its output is read to the end, as a process's.
  let code: number | null = null;
  let exited = false;
  let read = false;
  const closed = () => {
    if (exited && read) child.emit('close', code);
  };
  worker.stdout.once('end', () => {
    read = true;
    closed();
  });
  worker.once('exit', (exitCode) => {
    workers.delete(worker);
    code = exitCode;
    exited = true;
    child.emit('exit', exitCode, null);
    closed();
  });
  worker.once('error', (error) => child.emit('error', error));
  return child as unknown as ChildProcessWithoutNullStreams;
}

/** The fake as a process of its own, with `env` added to its environment. */
function asProcess(env: Record<string, string> = {}): SpawnAppServer {
  return (_codex, args, options) =>
    spawn(process.execPath, [FAKE, ...args], { ...options, env: { ...options.env, ...env } });
}

it('keeps plan-revision feedback private when resuming a native conversation', async () => {
  const env = { FAKE_CODEX_STATE: path.join(dir, 'threads.json') };
  const first = await start({ mode: 'plan' }, env);
  await first.session.send({ id: 'review-plan', text: 'Plan a change' });
  const plan = await first.heard('plan');
  first.answer(plan.id, { kind: 'plan', answer: { approve: false, feedback: 'private-revision' } });
  let revised: Extract<SessionEvent, { type: 'plan' }> | undefined;
  await vi.waitFor(() => {
    revised = first.events.find(
      (event): event is Extract<SessionEvent, { type: 'plan' }> =>
        event.type === 'plan' && event.id !== plan.id,
    );
    expect(revised).toBeDefined();
  });
  if (!revised) throw new Error('No revised plan');
  first.answer(revised.id, { kind: 'plan', answer: { approve: false, feedback: '' } });
  await first.ended('review-plan');
  const conversation = first.remembered.at(-1);
  if (!conversation) throw new Error('No conversation');
  await first.session.close();
  const resumed = await start({ resume: conversation, mode: 'plan' }, env);
  const history = resumed.events.find((event) => event.type === 'history');
  if (!history) throw new Error('No history');
  const users = history.events
    .filter((event): event is Extract<SessionEvent, { type: 'user' }> => event.type === 'user')
    .map((event) => ({
      id: event.id,
      kind: 'user' as const,
      text: event.text,
      ...(event.promptReply ? { promptReply: true as const } : {}),
    }));
  expect(users.map((entry) => entryFor(entry, 'you'))).toContainEqual(
    expect.objectContaining({ text: 'private-revision' }),
  );
  expect(JSON.stringify(users.map((entry) => entryFor(entry, 'token')))).not.toContain(
    'private-revision',
  );
}, 15000);

it('the recorded fake reports whether native instructions reached it, without their text', async () => {
  const file = path.join(dir, 'diagnostics.jsonl');
  const instructions = 'Native project guidance';
  const env = { FAKE_CODEX_DEVELOPER_INSTRUCTIONS: instructions, FAKE_CODEX_DIAGNOSTICS: file };
  await start({ role: 'Reviewer' }, env, { spawn: asProcess(env) });
  const text = await readFile(file, 'utf8');
  expect(text).not.toContain(instructions);
  expect(JSON.parse(text)).toMatchObject({
    nativeInstructionsPresent: true,
    node: process.execPath,
  });
});

it('reports the last request context with the native configured compaction limit before end', async () => {
  const { turn, events } = await start({}, { FAKE_CODEX_COMPACT_AT: '150000' });
  await turn('Hello');
  const beforeEnd = events.slice(
    0,
    events.findIndex((event) => event.type === 'end'),
  );
  expect(beforeEnd.filter((event) => event.type === 'usage').at(-1)).toMatchObject({
    usage: { context: { used: 2000, window: 200000, compactAt: 150000 } },
  });
});

it('refuses a resume option before finding or spawning a CLI', async () => {
  const findCodex = vi.fn().mockResolvedValue('/not-run');
  const spawn = vi.fn();
  await expect(start({ resume: '--help' }, {}, { findCodex, spawn })).rejects.toThrow(
    /conversation.*id/i,
  );
  expect(findCodex).not.toHaveBeenCalled();
  expect(spawn).not.toHaveBeenCalled();
});

it('refuses an unsafe native thread id and closes the private server', async () => {
  const rpc = await import('../rpc');
  const original = rpc.startAppServer;
  const close = vi.fn<Awaited<ReturnType<typeof original>>['close']>();
  const starting = vi.spyOn(rpc, 'startAppServer').mockImplementation(async (options) => {
    const server = await original(options);
    close.mockImplementation(() => server.close());
    return {
      ...server,
      close,
      request: async (method, params) => {
        const answer = await server.request(method, params);
        return method === 'thread/start' ? { thread: { id: '--resume' } } : answer;
      },
    };
  });
  try {
    await expect(start()).rejects.toThrow(/conversation id/);
    expect(close).toHaveBeenCalledOnce();
  } finally {
    starting.mockRestore();
  }
});

let dir: string;
let sessions: LiveSession<CodexMode>[];

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'corrallm-app-server-'));
  sessions = [];
});
afterEach(async () => {
  await Promise.all(sessions.map((session) => session.close()));
  await Promise.all([...workers].map((worker) => worker.terminate()));
  await rm(dir, { recursive: true, force: true });
});

/** The connector, running the fake with `env` added to the agents' environment. */
function connector(env: Record<string, string> = {}, deps: Partial<AppServerConnectorDeps> = {}) {
  return new AppServerConnector({
    clientApp: 'corrallm/0.1.0',
    findCodex: () => Promise.resolve('/home/me/.local/bin/codex'),
    spawn: (_codex, args, options) =>
      inProcess(args, { ...options, env: { ...options.env, ...env } }),
    home: '/home/me',
    ...deps,
  });
}

/** Starts a session: what it emits, the ids it remembers, and the session. */
async function start(
  spec: Partial<SessionSpec<CodexMode>> = {},
  env: Record<string, string> = {},
  deps: Partial<AppServerConnectorDeps> = {},
) {
  const events: HostEvent[] = [];
  const remembered: string[] = [];
  const activity = vi.fn();
  let bridge: Bridge | undefined;
  const session = await connector(env, deps).start(
    {
      agentId: 'a',
      cwd: dir,
      env: { PATH: process.env.PATH ?? '', FAKE_CODEX_LOG: path.join(dir, 'requests.jsonl') },
      model: null,
      mode: 'auto',
      resume: null,
      ...spec,
    },
    {
      emit: (event: HostEvent) => events.push(event),
      remember: (id) => remembered.push(id),
      activity,
      bridge: (translate) => {
        bridge = translate;
      },
    },
  );
  sessions.push(session);
  /** Sends a message, and waits for its turn to end. */
  const turn = async (text: string, id = `m${String(events.length)}`, extra = {}) => {
    await session.send({ id, text, ...extra });
    await ended(id);
    return id;
  };
  const ended = (id: string) =>
    vi.waitFor(
      () => {
        expect(events.some((event) => event.type === 'end' && event.messages.includes(id))).toBe(
          true,
        );
      },
      { timeout: 5000 },
    );
  /** Waits for an event like `like`, and returns it. */
  const heard = async <T extends SessionEvent['type']>(type: T, like: object = {}) => {
    let found: Extract<SessionEvent, { type: T }> | undefined;
    await vi.waitFor(
      () => {
        found = events.find(
          (event): event is Extract<SessionEvent, { type: T }> =>
            event.type === type && matches(event, like),
        );
        expect(found).toBeDefined();
      },
      { timeout: 5000 },
    );
    return found as Extract<SessionEvent, { type: T }>;
  };
  /**
   * Answers a prompt shown as the events B13 replaces show it, as the core answers an old card's
   * answer (until X11): its session names the prompt's key, and the owner answers by that key.
   */
  const answer = (id: string, given: SessionAnswer) => {
    const bridged = bridge?.(id, given);
    if (bridged === undefined) throw new Error('no bridge');
    session.prompts?.answer(bridged.key, bridged.answer);
  };
  /** The prompts raised to the core's owner so far. */
  const raised = () => events.filter((event): event is PromptEvent => event.type === 'prompt');
  return { session, events, remembered, turn, ended, heard, activity, answer, raised };
}

function matches(event: object, like: object): boolean {
  try {
    expect(event).toMatchObject(like);
    return true;
  } catch {
    return false;
  }
}

/** The requests the fake got, by method. */
async function requests(method: string): Promise<Record<string, unknown>[]> {
  const log = await readFile(path.join(dir, 'requests.jsonl'), 'utf8');
  return log
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> })
    .filter((request) => request.method === method)
    .map((request) => request.params);
}

/** Each text entry's text, streamed together. */
function texts(events: HostEvent[]): string[] {
  const joined = new Map<string, string>();
  for (const event of events) {
    if (event.type === 'text') joined.set(event.id, (joined.get(event.id) ?? '') + event.text);
  }
  return [...joined.values()];
}

describe('the App Server connection', () => {
  it('reports the app server’s incoming turn notifications as activity', async () => {
    const { activity, turn } = await start();
    const before = activity.mock.calls.length;
    await turn('Hello');
    expect(activity.mock.calls.length).toBeGreaterThan(before);
  });
  it('leaves an omitted mode to Codex, reports it, and preserves it on the next turn', async () => {
    const { events, turn } = await start({ mode: null });
    const [began] = await requests('thread/start');
    expect(began).not.toHaveProperty('approvalPolicy');
    expect(began).not.toHaveProperty('sandbox');
    expect(events[0]).toMatchObject({ type: 'started', mode: 'read-only' });
    await turn('Hello');
    const [sent] = await requests('turn/start');
    expect(sent).not.toHaveProperty('approvalPolicy');
    expect(sent).not.toHaveProperty('sandboxPolicy');
  });

  it('trusts the project folder for its app server alone, as a Terminal session trusts it', async () => {
    /** What each app server was started with, and where. */
    const servers: { args: readonly string[]; cwd: unknown }[] = [];
    const spawnFake: AppServerConnectorDeps['spawn'] = (_codex, args, options) => {
      servers.push({ args, cwd: options.cwd });
      return spawn(process.execPath, [FAKE, ...args], options);
    };
    const trusted = (folder: string) => `${JSON.stringify(folder)}={trust_level="trusted"}`;
    // One `-c` override, for this server alone (the user's config.toml is never written): the
    // folder its thread works in.
    const real = await realpath(dir);
    await start({ cwd: real }, {}, { spawn: spawnFake });
    expect(servers).toEqual([
      { args: ['app-server', '-c', `projects={${trusted(real)}}`], cwd: real },
    ]);
    expect(await requests('thread/start')).toMatchObject([{ cwd: real }]);
    // Reached through a link, by both its names: the thread works in it as given, and Codex may
    // resolve it.
    const link = path.join(dir, 'link');
    await mkdir(path.join(dir, 'shop'));
    await symlink(path.join(dir, 'shop'), link);
    await start({ cwd: link }, {}, { spawn: spawnFake });
    expect(servers[1]).toEqual({
      args: ['app-server', '-c', `projects={${trusted(link)},${trusted(await realpath(link))}}`],
      cwd: link,
    });
  });

  it('says whether the user’s own policies ask before acting, where they are none of its modes', async () => {
    const reported = async (sandbox: string, approval: string) => {
      const { events } = await start(
        { mode: null },
        { FAKE_CODEX_SANDBOX: sandbox, FAKE_CODEX_APPROVAL: approval },
      );
      const [started] = events;
      return started?.type === 'started' ? [started.mode, started.asks] : undefined;
    };
    // No sandbox, asking only once one fails: there is nothing to fail, so it never asks.
    expect(await reported('danger-full-access', 'on-failure')).toEqual([null, false]);
    // Even without a sandbox, on-request asks for dangerous commands.
    expect(await reported('danger-full-access', 'on-request')).toEqual([null, true]);
    // A sandbox, asking for anything untrusted: it asks.
    expect(await reported('workspace-write', 'untrusted')).toEqual([null, true]);
    // A preset says it all: Full access never asks.
    expect(await reported('danger-full-access', 'never')).toEqual(['full-access', undefined]);
  });

  it.each([undefined, 'Review changes'])(
    'appends supplied core workspace context with role %s through thread startup, never a user turn',
    async (role) => {
      await start(
        { ...(role === undefined ? {} : { role }), workspaceContext: 'Branch: generated-ref' },
        { FAKE_CODEX_DEVELOPER_INSTRUCTIONS: 'Native project guidance' },
      );
      expect(await requests('thread/start')).toMatchObject([
        {
          developerInstructions: `Native project guidance\n\n${role === undefined ? '' : `${role}\n\n`}[corrallm workspace context]\nBranch: generated-ref`,
        },
      ]);
      expect(await requests('turn/start')).toEqual([]);
    },
  );

  it('resumes without a role even if the optional context config read fails', async () => {
    const env = {
      FAKE_CODEX_STATE: path.join(dir, 'threads.json'),
      FAKE_CODEX_CONFIG_FAIL: 'Could not read config',
    };
    const first = await start({}, env);
    await first.turn('Hello');
    const id = first.remembered.at(-1);
    expect(id).toBeDefined();
    await first.session.close();

    const next = await start({ resume: id ?? null, roleChanged: false }, env);
    expect(await requests('config/read')).toEqual([{ cwd: dir }, { cwd: dir }]);
    expect((await requests('thread/resume')).at(-1)).toMatchObject({ threadId: id });
    expect((await requests('thread/resume')).at(-1)).not.toHaveProperty('developerInstructions');
    expect(next.events[0]).toMatchObject({ type: 'started' });
  });

  it('appends roles to native developer instructions and replaces or removes them on exact-ID resume', async () => {
    const env = {
      FAKE_CODEX_STATE: path.join(dir, 'threads.json'),
      FAKE_CODEX_DEVELOPER_INSTRUCTIONS: 'Native project guidance',
    };
    const initial =
      '--dangerously-bypass-approvals-and-sandbox\nReview "quoted" paths\t$(echo literal)';
    const first = await start({ role: initial }, env);
    expect(await requests('thread/start')).toMatchObject([
      { developerInstructions: `Native project guidance\n\n${initial}` },
    ]);
    expect(await requests('turn/start')).toEqual([]);
    await first.turn('Hello');
    const id = first.remembered.at(-1);
    expect(id).toBeDefined();
    await first.session.close();
    for (const { role, roleChanged } of [
      { role: initial, roleChanged: false },
      { role: 'Updated review role', roleChanged: true },
      { role: undefined, roleChanged: true },
    ]) {
      const next = await start(
        { resume: id ?? null, roleChanged, ...(role === undefined ? {} : { role }) },
        env,
      );
      expect((await requests('thread/resume')).at(-1)).toMatchObject({
        threadId: id,
        developerInstructions:
          role === undefined ? 'Native project guidance' : `Native project guidance\n\n${role}`,
      });
      expect(await requests('turn/start')).toHaveLength(1);
      if (role !== undefined) {
        await next.turn('/new');
        expect((await requests('thread/start')).at(-1)).toMatchObject({
          developerInstructions: `Native project guidance\n\n${role}`,
        });
        await next.turn('/clear');
        expect((await requests('thread/start')).at(-1)).toMatchObject({
          developerInstructions: `Native project guidance\n\n${role}`,
        });
      }
      await next.session.close();
    }
  });

  it.each([
    { login: 'none', distribution: 'local' as const, why: /isn't logged in/ },
    { login: 'chatgpt', distribution: 'hosted' as const, why: /commercial or hosted/ },
    { login: 'chatgpt', distribution: 'commercial' as const, why: /commercial or hosted/ },
  ])(
    'offers Codex Terminal when $login login is refused in a $distribution build',
    async ({ login, distribution, why }) => {
      const events: SessionEvent[] = [];
      const remember = vi.fn();
      await expect(
        connector({ FAKE_CODEX_LOGIN: login }, { distribution }).start(
          {
            agentId: 'a',
            cwd: dir,
            env: { PATH: process.env.PATH ?? '', FAKE_CODEX_LOG: path.join(dir, 'requests.jsonl') },
            model: null,
            mode: 'auto',
            resume: null,
          },
          { emit: (event: SessionEvent) => events.push(event), remember },
        ),
      ).rejects.toThrow(why);
      expect(events).toEqual([
        {
          type: 'notice',
          id: expect.any(String) as unknown,
          level: 'error',
          text: expect.stringMatching(why) as unknown,
          switchTo: 'codex.terminal',
        },
      ]);
      expect(remember).not.toHaveBeenCalled();
      expect(await requests('thread/start')).toEqual([]);
      expect(await requests('turn/start')).toEqual([]);
    },
  );

  it('starts a Codex thread in the project folder, offering Codex’s models, efforts and commands', async () => {
    const { events } = await start({ mode: 'read-only' });
    expect(events[0]).toEqual({
      type: 'started',
      model: 'gpt-6.1-sol',
      mode: 'read-only',
      models: [
        {
          value: 'gpt-6.1-sol',
          label: 'GPT-6.1-Sol',
          description: 'Latest workhorse model for coding and everyday work.',
          efforts: [
            { value: 'low', label: 'Low', description: 'Fast responses with lighter reasoning' },
            {
              value: 'high',
              label: 'High',
              description: 'Greater reasoning depth for complex problems',
            },
            {
              value: 'xhigh',
              label: 'Extra high',
              description: 'Extra high reasoning depth for complex problems',
            },
          ],
          defaultEffort: 'low',
        },
        {
          value: 'gpt-6-luna',
          label: 'GPT-6-Luna',
          description: 'Fast and affordable model for easier tasks.',
          efforts: [{ value: 'medium', label: 'Medium', description: 'Balanced' }],
          defaultEffort: 'medium',
        },
      ],
      effort: 'low',
    });
    const commands = events.find((event) => event.type === 'commands');
    expect(commands?.type === 'commands' && commands.commands.map((c) => c.name)).toEqual([
      'review',
      'compact',
      'init',
      'diff',
      'plan',
      'model',
      'permissions',
      'status',
      'mcp',
      'skills',
      'new',
      'clear',
      'rename',
      // The project's skill.
      'deploy',
    ]);
    // The account's limits, with the session's usage.
    expect(events).toContainEqual({
      type: 'usage',
      usage: {
        costUsd: null,
        context: null,
        contextTokens: null,
        contextWindow: null,
        // (The fake's windows reset hours and days from when it starts.)
        limits: [
          { name: '5h', usedPercent: 12, resetsAt: expect.any(Number) as number },
          { name: 'weekly', usedPercent: 3, resetsAt: expect.any(Number) as number },
        ],
      },
    });
    const [started] = await requests('thread/start');
    expect(started).toEqual({
      cwd: dir,
      approvalPolicy: 'on-request',
      sandbox: 'read-only',
      serviceName: 'corrallm',
    });
  });

  it('runs a turn: reasoning and the reply stream in, and the thread is remembered once it has one', async () => {
    const { turn, events, remembered } = await start({}, {}, { spawn: asProcess() });
    expect(remembered).toEqual([]);
    const id = await turn('Hello');
    expect(events.filter((e) => e.type === 'user' || e.type === 'status').slice(0, 2)).toEqual([
      { type: 'user', id, text: 'Hello' },
      { type: 'status', status: 'working' },
    ]);
    expect(
      events
        .filter((e) => e.type === 'thinking')
        .map((e) => e.text)
        .join(''),
    ).toBe('**Reading the request**');
    expect(texts(events)).toEqual(['You said: Hello']);
    expect(events.at(-1)).toMatchObject({
      type: 'end',
      messages: [id],
      result: { status: 'completed' },
    });
    expect(remembered).toHaveLength(1);
    // The turn was sent in the session's mode: Default's preset, not plan mode.
    const [sent] = await requests('turn/start');
    expect(sent).toMatchObject({
      input: [{ type: 'text', text: 'Hello', text_elements: [] }],
      clientUserMessageId: id,
      model: 'gpt-6.1-sol',
      effort: 'low',
      approvalPolicy: 'on-request',
      sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
      collaborationMode: {
        mode: 'default',
        settings: { model: 'gpt-6.1-sol', reasoning_effort: 'low', developer_instructions: null },
      },
    });
  });

  it('passes Codex’s usage limits on to the usage readings: as it connects, and as they change', async () => {
    const readings: [UsageBackendId, UsageWindows][] = [];
    const { turn } = await start({}, {}, { usage: (...reading) => readings.push(reading) });
    const now = Date.now();
    expect(readings).toEqual([
      [
        'codex',
        {
          fiveHour: { usedPercent: 12, resetsAt: expect.any(Number) as number },
          weekly: { usedPercent: 3, resetsAt: expect.any(Number) as number },
        },
      ],
    ]);
    expect(readings[0]?.[1].fiveHour?.resetsAt).toBeGreaterThan(now);
    // Codex tells them again after a turn.
    await turn('Hello', 'm1');
    expect(readings).toHaveLength(2);
    expect(readings[1]?.[0]).toBe('codex');
  });

  it('asks before running a command in Read only, and runs it once allowed', async () => {
    const { session, answer, heard, ended, events } = await start({ mode: 'read-only' });
    await session.send({ id: 'm1', text: 'run the tests' });
    const prompt = await heard('permission');
    expect(prompt).toMatchObject({
      tool: 'exec_command',
      summary: 'npm test',
      always: "Yes, and don't ask again for commands that start with `npm test`",
      title: 'May I run the tests?',
    });
    expect(events.at(-1)).toEqual({ type: 'status', status: 'waiting' });
    answer(prompt.id, { kind: 'permission', answer: 'once' });
    await ended('m1');
    expect(events.filter((e) => e.type === 'tool').at(-1)).toMatchObject({
      tool: 'exec_command',
      summary: 'npm test',
      status: 'done',
      detail: { kind: 'output', text: 'Tests: 1 passed\n' },
    });
    expect(events).toContainEqual({ type: 'status', status: 'working' });
  });

  it('stops the turn when the user says no, as Codex’s No does', async () => {
    const { session, answer, heard, ended, events } = await start({ mode: 'read-only' });
    await session.send({ id: 'm1', text: 'run the tests' });
    const prompt = await heard('permission');
    answer(prompt.id, { kind: 'permission', answer: 'deny' });
    await ended('m1');
    expect(events.at(-1)).toMatchObject({ type: 'end', result: { status: 'cancelled' } });
    expect(events.filter((e) => e.type === 'tool').at(-1)).toMatchObject({ status: 'failed' });
  });

  it('takes a new mode with the next turn: Default runs the command in its sandbox, unasked', async () => {
    const { session, turn, events } = await start({ mode: 'read-only' });
    await session.setMode('auto');
    await turn('run the tests');
    expect(events.some((e) => e.type === 'permission')).toBe(false);
    const [sent] = await requests('turn/start');
    expect(sent?.sandboxPolicy).toMatchObject({ type: 'workspaceWrite' });
    await session.setMode('full-access');
    await turn('again');
    expect((await requests('turn/start'))[1]).toMatchObject({
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
    });
  });

  it('asks to implement a plan once plan mode proposes one, and carries it out in the same turn', async () => {
    const { session, answer, heard, ended, events } = await start({ mode: 'plan' });
    await session.send({ id: 'm1', text: 'Plan the change' });
    const plan = await heard('plan');
    expect(plan.plan).toBe('# Plan\n\n1. Read the code\n2. Change it\n');
    // The turn waits on the user: it has not ended.
    expect(events.some((e) => e.type === 'end')).toBe(false);
    expect(events.at(-1)).toEqual({ type: 'status', status: 'waiting' });
    answer(plan.id, { kind: 'plan', answer: { approve: true, mode: 'auto' } });
    await ended('m1');
    expect(events).toContainEqual({ type: 'mode', mode: 'auto' });
    expect(events.filter((e) => e.type === 'end')).toHaveLength(1);
    const sent = await requests('turn/start');
    expect(sent.map((params) => (params.collaborationMode as { mode: string }).mode)).toEqual([
      'plan',
      'default',
    ]);
    expect(sent[1]?.input).toEqual([
      { type: 'text', text: 'Implement the plan.', text_elements: [] },
    ]);
  });

  it('keeps planning with what the user says to change, or stops', async () => {
    const { session, answer, heard, ended, events } = await start({ mode: 'plan' });
    await session.send({ id: 'm1', text: 'Plan the change' });
    const first = await heard('plan');
    answer(first.id, {
      kind: 'plan',
      answer: { approve: false, feedback: 'Smaller steps' },
    });
    await vi.waitFor(async () => {
      expect(await requests('turn/start')).toHaveLength(2);
    });
    expect((await requests('turn/start'))[1]?.input).toEqual([
      { type: 'text', text: 'Smaller steps', text_elements: [] },
    ]);
    await vi.waitFor(() => {
      expect(events.filter((e) => e.type === 'plan')).toHaveLength(2);
    });
    const second = events.filter((e) => e.type === 'plan').at(-1);
    answer(second?.id ?? '', {
      kind: 'plan',
      answer: { approve: false, feedback: '' },
    });
    await ended('m1');
    expect(events.some((e) => e.type === 'mode')).toBe(false);
  });

  it('asks Codex’s questions, and goes on with the answers', async () => {
    const { session, answer, heard, ended, events } = await start();
    await session.send({ id: 'm1', text: 'ask me' });
    const question = await heard('question');
    expect(question.questions[0]).toMatchObject({ header: 'Color', text: 'Which color?' });
    answer(question.id, { kind: 'question', answers: ['Blue'] });
    await ended('m1');
    expect(texts(events)).toEqual(['You picked Blue.']);
  });

  it('interrupts a turn, whose simulated command’s output streamed meanwhile', async () => {
    const { session, heard, ended, events } = await start();
    await session.send({ id: 'm1', text: 'slow' });
    await heard('tool', { detail: { kind: 'output' } });
    await session.interrupt();
    await ended('m1');
    expect(await requests('turn/interrupt')).toEqual([
      {
        threadId: (await requests('turn/start'))[0]?.threadId,
        turnId: expect.any(String) as unknown,
      },
    ]);
    expect(events.at(-1)).toMatchObject({ type: 'end', result: { status: 'cancelled' } });
  });

  it('interrupts a turn Codex has not started yet as soon as it starts', async () => {
    const { session, ended, events } = await start();
    const sent = session.send({ id: 'm1', text: 'slow' });
    await session.interrupt();
    await sent;
    await ended('m1');
    expect(events.at(-1)).toMatchObject({ type: 'end', result: { status: 'cancelled' } });
  });

  it('cleans up when the native turn id and command arrive after the stop', async () => {
    const { session, ended } = await start();
    await session.send({ id: 'm1', text: 'slow' });
    await session.interrupt();
    await ended('m1');
    expect(await requests('thread/backgroundTerminals/terminate')).toEqual([
      { threadId: (await requests('turn/start'))[0]?.threadId, processId: '1000' },
    ]);
  });

  it('interrupts a plan prompt and stops the command its plan turn left running', async () => {
    const { session, heard, ended } = await start({ mode: 'plan' });
    await session.send({ id: 'm1', text: 'background plan' });
    await heard('plan');
    await session.interrupt();
    await ended('m1');
    expect(await requests('turn/interrupt')).toEqual([]); // The native plan turn already ended.
    expect(await requests('thread/backgroundTerminals/terminate')).toEqual([
      { threadId: (await requests('turn/start'))[0]?.threadId, processId: '1000' },
    ]);
  });

  it('cleans up a turn Codex interrupts without a corrallm interrupt request', async () => {
    const { session, ended } = await start();
    await session.send({ id: 'm1', text: 'slow self-interrupt' });
    await ended('m1');
    expect(await requests('turn/interrupt')).toEqual([]);
    expect(await requests('thread/backgroundTerminals/terminate')).toEqual([
      { threadId: (await requests('turn/start'))[0]?.threadId, processId: '1000' },
    ]);
  });

  it('keeps the next turn queued until command termination answers, even after turn/completed', async () => {
    const { session, heard, ended, events } = await start(
      {},
      {
        FAKE_CODEX_TERMINATE: 'delay',
        FAKE_CODEX_PROCESS_LOG: path.join(dir, 'processes.jsonl'),
      },
    );
    await session.send({ id: 'm1', text: 'slow' });
    await heard('tool', { detail: { kind: 'output' } });
    await session.send({ id: 'm2', text: 'next' });
    await session.interrupt();
    await vi.waitFor(async () => {
      expect(await requests('thread/backgroundTerminals/terminate')).toHaveLength(1);
    });
    expect(events.some((event) => event.type === 'user' && event.id === 'm2')).toBe(false);
    await ended('m2');
    const log = (await readFile(path.join(dir, 'processes.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; live: string[] });
    expect(log.map((event) => event.type)).toEqual(['turn', 'process', 'terminated', 'turn']);
    expect(log.at(-1)?.live).toEqual([]);
    expect(await requests('thread/backgroundTerminals/clean')).toEqual([]);
  });

  it.each(['missing', 'unknown', 'fail', 'hang'])(
    'warns with the command id and releases the next turn when termination is %s',
    async (behavior) => {
      // Codex's answer is waited for 100 ms here, not two seconds: a hang is one all the same.
      const { session, heard, ended, events } = await start(
        {},
        { FAKE_CODEX_TERMINATE: behavior },
        { terminateMs: 100 },
      );
      await session.send({ id: 'm1', text: 'slow' });
      await heard('tool', { detail: { kind: 'output' } });
      await session.send({ id: 'm2', text: 'next' });
      await session.interrupt();
      await ended('m2');
      expect(
        events.filter((event) => event.type === 'notice' && event.level === 'warning'),
      ).toMatchObject([
        { text: expect.stringMatching(/command 1000 may still be running:/) as string },
      ]);
      if (behavior === 'missing' || behavior === 'unknown') {
        await session.send({ id: 'm3', text: 'slow' });
        await vi.waitFor(async () => {
          expect(await requests('turn/start')).toHaveLength(3);
        });
        // Wait until this turn's command is running, not merely accepted.
        await vi.waitFor(() => {
          expect(new Set(events.flatMap((e) => (e.type === 'tool' ? [e.id] : []))).size).toBe(2);
        });
        await session.interrupt();
        await ended('m3');
        expect(
          events.filter((event) => event.type === 'notice' && event.level === 'warning'),
        ).toHaveLength(1);
        expect(await requests('thread/backgroundTerminals/terminate')).toHaveLength(1);
      }
    },
  );

  it('says why a turn failed, and when the usage limit resets', async () => {
    const { turn, events } = await start();
    await turn('fail please', 'm1');
    expect(events.filter((e) => e.type === 'notice')).toMatchObject([
      {
        level: 'error',
        text: expect.stringMatching(/^You’ve hit your usage limit\. · resets /) as string,
      },
    ]);
    expect(events.at(-1)).toMatchObject({ type: 'end', result: { status: 'failed' } });
  });

  it('sends pasted images, and the skills a message invokes', async () => {
    const { turn, session, events } = await start();
    await turn('/deploy now', 'm1', { images: [{ mediaType: 'image/png', data: 'iVBORw0KGgo=' }] });
    expect(texts(events).at(-1)).toBe('You said: $deploy now [1 image] [skills: deploy]');
    const [sent] = await requests('turn/start');
    expect(sent?.input).toEqual([
      { type: 'text', text: '$deploy now', text_elements: [] },
      { type: 'image', url: 'data:image/png;base64,iVBORw0KGgo=' },
      { type: 'skill', name: 'deploy', path: '/skills/deploy/SKILL.md' },
    ]);
    // A model that reads no images is not sent them.
    await session.setModel('gpt-6-luna');
    await turn('look', 'm2', { images: [{ mediaType: 'image/png', data: 'iVBORw0KGgo=' }] });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'notice',
        text: "GPT-6-Luna doesn't read images: they were left out.",
      }),
    );
  });

  it('switches model and reasoning effort for the next turns', async () => {
    const { session, turn, events } = await start({ effort: 'high' });
    expect(events[0]).toMatchObject({ type: 'started', effort: 'high' });
    await session.setEffort?.('xhigh');
    await turn('one');
    expect((await requests('turn/start'))[0]).toMatchObject({ effort: 'xhigh' });
    // Luna has no xhigh: its default it is.
    await session.setModel('gpt-6-luna');
    expect(events.slice(-2)).toEqual([
      { type: 'model', model: 'gpt-6-luna' },
      { type: 'effort', effort: null },
    ]);
    await turn('two');
    const second = (await requests('turn/start'))[1];
    expect(second).toMatchObject({ model: 'gpt-6-luna' });
    expect(second).not.toHaveProperty('effort');
  });

  it('runs Codex’s slash commands', async () => {
    const { turn, events } = await start();
    const last = () => texts(events).at(-1) ?? '';

    await turn('/review', 'r');
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'notice', text: 'Code review started: current changes' }),
    );
    expect(last()).toBe('No issues found in the current changes.');
    expect((await requests('review/start'))[0]).toEqual({
      threadId: expect.any(String) as string,
      target: { type: 'uncommittedChanges' },
      delivery: 'inline',
    });

    await turn('/compact', 'c');
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'notice', text: 'Context compacted' }),
    );
    expect(events.at(-1)).toMatchObject({
      type: 'end',
      messages: ['c'],
      result: { status: 'completed' },
    });

    await turn('/init', 'i');
    expect((await requests('turn/start')).at(-1)?.input).toEqual([
      expect.objectContaining({
        text: expect.stringMatching(/^Generate a file named AGENTS\.md/) as string,
      }),
    ]);

    await turn('/model', 'model');
    expect(last()).toMatch(/`gpt-6.1-sol` GPT-6.1-Sol — current \(low, high, xhigh\)/);
    await turn('/model gpt-6-luna medium', 'luna');
    expect(events).toContainEqual({ type: 'model', model: 'gpt-6-luna' });
    expect(events).toContainEqual({ type: 'effort', effort: 'medium' });

    await turn('/permissions read-only', 'p');
    expect(events).toContainEqual({ type: 'mode', mode: 'read-only' });
    // Text never leaves the sandbox: a message in a shared canvas, or another agent's, could say
    // it. Full access is the mode menu's, which asks first.
    await turn('/permissions full-access', 'f');
    expect(events).not.toContainEqual({ type: 'mode', mode: 'full-access' });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'notice',
        text: expect.stringMatching(/mode menu/) as string,
      }),
    );
    await turn('/status', 's');
    expect(last()).toMatch(/Approvals: on-request · Sandbox: read-only/);
    expect(last()).toMatch(/Login: an API key/);
    await turn('/mcp', 'mcp');
    expect(last()).toMatch(/\*\*docs\*\*: `search`, `fetch`/);
    // A server's many tools, a few named.
    expect(last()).toMatch(/\*\*apps\*\*: `tool_1`, .*`tool_8` and 2 more$/m);
    await turn('/skills', 'skills');
    expect(last()).toMatch(/`deploy`: Deploy the app to staging/);
    await turn('/rename Shop work', 'n');
    expect((await requests('thread/name/set'))[0]).toMatchObject({ name: 'Shop work' });
    // A slash that names nothing is a message.
    await turn('/usr/bin is missing', 'u');
    expect(last()).toBe('You said: /usr/bin is missing');
  });

  it('starts a new chat with /new, remembered once it has a turn', async () => {
    const { turn, remembered, events } = await start();
    await turn('one');
    await turn('/new', 'n');
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'notice',
        text: expect.stringMatching(/^Started a new chat/) as string,
      }),
    );
    expect(remembered).toHaveLength(1);
    await turn('two');
    expect(remembered).toHaveLength(2);
    expect(remembered[1]).not.toBe(remembered[0]);
    expect((await requests('turn/start'))[1]?.threadId).toBe(remembered[1]);
  });

  it('shows the project’s changes with /diff, a file each', async () => {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync(
      'git',
      [
        '-c',
        'user.email=a@b.c',
        '-c',
        'user.name=a',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'start',
      ],
      { cwd: dir },
    );
    await writeFile(path.join(dir, 'notes.md'), 'one\n');
    const { turn, events } = await start();
    await turn('/diff', 'd');
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool',
        tool: 'git diff',
        summary: 'notes.md',
        detail: { kind: 'diff', added: 1, removed: 0, lines: [{ kind: 'add', text: 'one' }] },
      }),
    );
  });

  it('resumes the agent’s thread after a restart, showing its history; a thread never kept starts afresh', async () => {
    const state = path.join(dir, 'threads.json');
    const first = await start({}, { FAKE_CODEX_STATE: state });
    const id = await first.turn('Hello', 'm1');
    const thread = first.remembered[0];
    await first.session.close();

    const again = await start({ resume: thread ?? null }, { FAKE_CODEX_STATE: state });
    const history = again.events.find((e) => e.type === 'history');
    expect(history?.type === 'history' && history.events.map((e) => e.type)).toEqual([
      'user',
      'thinking',
      'text',
      'end',
    ]);
    expect(history?.type === 'history' && history.events[0]).toEqual({
      type: 'user',
      id,
      text: 'Hello',
    });
    expect((await requests('thread/resume'))[0]).toMatchObject({ threadId: thread, cwd: dir });

    const fresh = await start(
      { resume: '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e99' },
      { FAKE_CODEX_STATE: state },
    );
    expect(fresh.events.some((e) => e.type === 'notice' || e.type === 'history')).toBe(false);
    expect(fresh.events[0]).toMatchObject({ type: 'started' });
  });

  describe('on a ChatGPT login', () => {
    const CHATGPT = { FAKE_CODEX_LOGIN: 'chatgpt' };
    /** The user's say, kept for good, as main's settings keep it. */
    function kept(given = false) {
      const consent = {
        given: vi.fn(() => Promise.resolve(given)),
        give: vi.fn(() => {
          given = true;
          return Promise.resolve();
        }),
      };
      return consent;
    }

    it('asks before its first turn uses the plan: Yes, for this session', async () => {
      const consent = kept();
      const { session, answer, events, heard, ended, turn } = await start({}, CHATGPT, { consent });
      await session.send({ id: 'm1', text: 'Hello' });
      const prompt = await heard('permission', {
        tool: 'ChatGPT plan',
        summary: 'Plus',
        always: "Yes, and don't ask again on this computer",
      });
      expect(events.at(-1)).toEqual({ type: 'status', status: 'waiting' });
      // Nothing went to Codex's model yet.
      expect(await requests('turn/start')).toEqual([]);
      answer(prompt.id, { kind: 'permission', answer: 'once' });
      await ended('m1');
      expect(texts(events)).toContain('You said: Hello');
      expect(consent.give).not.toHaveBeenCalled();
      // Asked once a session.
      await turn('/review', 'r');
      await turn('Again', 'm2');
      expect(events.filter((e) => e.type === 'permission')).toHaveLength(1);

      // The next session asks again.
      const next = await start({}, CHATGPT, { consent });
      await next.session.send({ id: 'n1', text: 'Hello' });
      await next.heard('permission', { tool: 'ChatGPT plan' });
    });

    it('asks no more once told not to ask again, in this session or the next', async () => {
      const consent = kept();
      const first = await start({}, CHATGPT, { consent });
      await first.session.send({ id: 'm1', text: 'Hello' });
      const prompt = await first.heard('permission');
      first.answer(prompt.id, { kind: 'permission', answer: 'always' });
      await first.ended('m1');
      expect(consent.give).toHaveBeenCalledOnce();

      const next = await start({}, CHATGPT, { consent });
      await next.turn('Hello', 'n1');
      expect(texts(next.events)).toContain('You said: Hello');
      expect(next.events.some((e) => e.type === 'permission')).toBe(false);
    });

    it('sends nothing when the user says no, and says what else runs on the plan', async () => {
      const { session, answer, events, heard, ended } = await start({}, CHATGPT, {
        consent: kept(),
      });
      await session.send({ id: 'm1', text: 'Hello' });
      const prompt = await heard('permission');
      answer(prompt.id, { kind: 'permission', answer: 'deny' });
      await ended('m1');
      expect(events.at(-2)).toMatchObject({
        type: 'notice',
        level: 'error',
        text: expect.stringMatching(/^Not sent: .*Codex · Terminal/s) as unknown,
      });
      expect(events.at(-1)).toMatchObject({
        type: 'end',
        result: { status: 'cancelled', reason: 'interrupted' },
      });
      expect(await requests('turn/start')).toEqual([]);
    });

    it('stops asking when the turn is interrupted, and sends nothing', async () => {
      const { session, events, heard, ended } = await start({}, CHATGPT, { consent: kept() });
      await session.send({ id: 'm1', text: 'Hello' });
      const prompt = await heard('permission');
      await session.interrupt();
      await ended('m1');
      expect(events).toContainEqual({ type: 'withdrawn', id: prompt.id });
      expect(events.at(-1)).toMatchObject({ type: 'end', result: { status: 'cancelled' } });
      expect(await requests('turn/start')).toEqual([]);
    });

    it('reads the plan’s usage without asking: reading it uses no model', async () => {
      const readings: [UsageBackendId, UsageWindows][] = [];
      const consent = kept();
      const { events } = await start({}, CHATGPT, {
        consent,
        usage: (...reading) => readings.push(reading),
      });
      expect(
        readings.map(([backend, windows]) => [backend, windows.fiveHour?.usedPercent]),
      ).toEqual([['codex', 12]]);
      expect(consent.given).not.toHaveBeenCalled();
      expect(events.some((e) => e.type === 'permission')).toBe(false);
    });

    it('is refused by a build made as a commercial or hosted product', async () => {
      await expect(start({}, CHATGPT, { distribution: 'hosted' })).rejects.toThrow(
        /logged in with ChatGPT.*commercial or hosted.*Codex · Terminal/s,
      );
    });
  });

  it('runs on an API key without asking; refuses no login, and says how to log in', async () => {
    const consent = { given: vi.fn(), give: vi.fn() };
    const { turn, events } = await start({}, {}, { consent });
    await turn('Hello', 'm1');
    expect(events.some((e) => e.type === 'permission')).toBe(false);
    expect(consent.given).not.toHaveBeenCalled();
    await expect(start({}, { FAKE_CODEX_LOGIN: 'none' })).rejects.toThrow(/isn't logged in/);
  });

  it('says it stopped, and why, when its app server goes', async () => {
    const { session, heard } = await start({}, {}, { spawn: asProcess() });
    await session.send({ id: 'm1', text: 'crash' });
    const closed = await heard('closed');
    expect(closed.error).toMatch(/Codex's app server stopped \(exit code 3\): Error: it crashed/);
  });
});

describe('the App Server connection’s prompts, through the core’s owner (B13 C5)', () => {
  const KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  /** Waits for `count` prompts raised, and returns the last. */
  const raisedNth = async (raised: () => PromptEvent[], count: number) => {
    await vi.waitFor(
      () => {
        expect(raised()).toHaveLength(count);
      },
      { timeout: 5000 },
    );
    const last = raised().at(-1);
    if (last === undefined) throw new Error('nothing raised');
    return last;
  };

  it('raises what Codex asks under a fresh key: only the owner’s answer, by that key, reaches it', async () => {
    const { session, raised, ended } = await start({ mode: 'read-only' });
    await session.send({ id: 'm1', text: 'run the tests' });
    const prompt = await raisedNth(raised, 1);
    expect(prompt).toMatchObject({
      key: expect.stringMatching(KEY) as unknown,
      prompt: {
        kind: 'approval',
        subject: { type: 'command', command: '/bin/zsh -lc "npm test"', cwd: dir },
      },
    });
    // The old way answers nothing.
    await expect(
      session.answer('anything', { kind: 'permission', answer: 'once' }),
    ).rejects.toThrow(/only through/);
    session.prompts?.answer(prompt.key, {
      kind: 'choice',
      value: 'acceptWithExecpolicyAmendment',
    });
    await ended('m1');
    expect(await requests('answer:item/commandExecution/requestApproval')).toEqual([
      { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['npm', 'test'] } } },
    ]);
  });

  it('asks to approve an MCP tool call as Codex does, and keeps it for the session when told', async () => {
    const { session, raised, ended, events } = await start();
    await session.send({ id: 'm1', text: 'mcp' });
    const prompt = await raisedNth(raised, 1);
    expect(prompt.prompt).toMatchObject({
      kind: 'approval',
      subject: { type: 'mcpTool', server: 'probe', tool: 'save_note', input: { text: 'a' } },
    });
    session.prompts?.answer(prompt.key, { kind: 'choice', value: 'session' });
    await ended('m1');
    expect(await requests('answer:mcpServer/elicitation/request')).toEqual([
      { action: 'accept', content: null, _meta: { persist: 'session' } },
    ]);
    expect(texts(events)).toContain('Saved, and allowed for this session.');
  });

  it('keeps a six-field form a typed form, and a link only in its form', async () => {
    const { session, raised, ended } = await start();
    await session.send({ id: 'm1', text: 'form' });
    const form = await raisedNth(raised, 1);
    const fields =
      form.prompt.kind === 'form' && 'schema' in form.prompt.form
        ? Object.keys(form.prompt.form.schema.properties)
        : [];
    expect(fields).toHaveLength(6);
    const values = {
      name: 'Ada',
      email: 'ada@example.com',
      age: 36,
      subscribe: true,
      color: 'green',
      topics: ['news', 'tips'],
    };
    session.prompts?.answer(form.key, { kind: 'form', action: 'accept', values });
    await ended('m1');
    await session.send({ id: 'm2', text: 'link' });
    const link = await raisedNth(raised, 2);
    expect(link.prompt).toMatchObject({
      kind: 'form',
      title: 'MCP server “probe” asks you to open a link on auth.example.com',
      form: { url: 'https://auth.example.com/sign-in?state=probe' },
    });
    session.prompts?.answer(link.key, { kind: 'form', action: 'accept' });
    await ended('m2');
    expect(await requests('answer:mcpServer/elicitation/request')).toEqual([
      { action: 'accept', content: values, _meta: null },
      { action: 'accept', content: null, _meta: null },
    ]);
  });

  it('asks before writing to a running command by its own approval, on its command’s item', async () => {
    const { session, raised, ended, events } = await start({ mode: 'read-only' });
    await session.send({ id: 'm1', text: 'stdin' });
    const command = await raisedNth(raised, 1);
    session.prompts?.answer(command.key, { kind: 'choice', value: 'accept' });
    const input = await raisedNth(raised, 2);
    expect(input.key).not.toBe(command.key);
    expect(input.prompt).toMatchObject({
      title: 'Codex wants to send input to a running command',
      subject: { type: 'command', command: "write_stdin --session-id 7627 'hi\n'" },
    });
    expect(() => {
      session.prompts?.answer(command.key, { kind: 'choice', value: 'accept' });
    }).toThrow(/no longer asked/);
    session.prompts?.answer(input.key, { kind: 'choice', value: 'cancel' });
    await ended('m1');
    expect(events.at(-1)).toMatchObject({ type: 'end', result: { status: 'cancelled' } });
    expect(await requests('answer:item/commandExecution/requestApproval')).toEqual([
      { decision: 'accept' },
      { decision: 'cancel' },
    ]);
  });

  it('grants permissions for the turn with strict auto review', async () => {
    const { session, raised, ended } = await start();
    await session.send({ id: 'm1', text: 'permissions' });
    const prompt = await raisedNth(raised, 1);
    expect(prompt.prompt).toMatchObject({ subject: { type: 'permissions', network: true } });
    session.prompts?.answer(prompt.key, { kind: 'choice', value: 'strict' });
    await ended('m1');
    expect(await requests('answer:item/permissions/requestApproval')).toEqual([
      {
        permissions: { network: { enabled: true }, fileSystem: null },
        scope: 'turn',
        strictAutoReview: true,
      },
    ]);
  });

  it('asks to implement a plan with Codex’s two choices only: an old card’s other mode is refused', async () => {
    const { session, raised, heard, ended, events, answer } = await start({ mode: 'plan' });
    await session.send({ id: 'm1', text: 'Plan the change' });
    const plan = await raisedNth(raised, 1);
    expect(plan.prompt).toMatchObject({
      kind: 'plan',
      title: 'Implement this plan?',
      plan: '# Plan\n\n1. Read the code\n2. Change it\n',
    });
    expect(plan.prompt.kind === 'plan' && plan.prompt.choices.map(({ value }) => value)).toEqual([
      'implement',
      'keep-planning',
    ]);
    const shown = await heard('plan');
    expect(() => {
      answer(shown.id, { kind: 'plan', answer: { approve: true, mode: 'acceptEdits' } });
    }).toThrow(/doesn’t offer acceptEdits/);
    session.prompts?.answer(plan.key, { kind: 'choice', value: 'implement' });
    await ended('m1');
    expect(events).toContainEqual({ type: 'mode', mode: 'auto' });
    expect((await requests('turn/start'))[1]?.input).toEqual([
      { type: 'text', text: 'Implement the plan.', text_elements: [] },
    ]);
  });

  it('asks consent to use the ChatGPT plan as a consent, withdrawn through the owner when interrupted', async () => {
    const consent = { given: () => Promise.resolve(false), give: () => Promise.resolve() };
    const { session, raised, ended, events } = await start(
      {},
      { FAKE_CODEX_LOGIN: 'chatgpt' },
      { consent },
    );
    await session.send({ id: 'm1', text: 'Hello' });
    const prompt = await raisedNth(raised, 1);
    expect(prompt.prompt).toMatchObject({
      kind: 'approval',
      subject: { type: 'consent', key: 'chatgpt-plan' },
    });
    await session.interrupt();
    await ended('m1');
    expect(events).toContainEqual({ type: 'prompt-ended', key: prompt.key, reason: 'withdrawn' });
    expect(await requests('turn/start')).toEqual([]);
  });

  it('withdraws every open request through the owner as the session closes', async () => {
    const { session, raised, events } = await start({ mode: 'read-only' });
    await session.send({ id: 'm1', text: 'run the tests' });
    const prompt = await raisedNth(raised, 1);
    await session.close();
    expect(events).toContainEqual({ type: 'prompt-ended', key: prompt.key, reason: 'withdrawn' });
  });
});

describe('the App Server connection, replaying the real Codex', () => {
  /** Starts a session against a recording (replay.ts), as it was started when recorded. */
  async function replayed(name: Fixture, spec: Partial<SessionSpec<CodexMode>> = {}) {
    const { spawn: replaying, problems, sent } = replay(name);
    const recordedSession = await start(
      { cwd: '/work/smoke/one', model: 'gpt-6-luna', effort: 'low', ...spec },
      {},
      {
        spawn: replaying,
        // Recorded on a ChatGPT login, allowed for good.
        consent: { given: () => Promise.resolve(true), give: () => Promise.resolve() },
        home: '/Users/someone',
      },
    );
    return { ...recordedSession, problems, sent };
  }

  it('a patch and a command: their diffs and output, the replies, the thread remembered', async () => {
    const { turn, events, remembered, problems, session } = await replayed('patch', {
      effort: 'medium',
    });
    expect(events[0]).toMatchObject({
      type: 'started',
      model: 'gpt-6-luna',
      mode: 'auto',
      effort: 'medium',
    });
    await turn(
      'Use apply_patch to create hello.txt containing the line hi, then run `cat hello.txt`. Reply in one short sentence.',
      'm1',
    );
    expect(texts(events)).toEqual([
      'I’ll create the file with `apply_patch`, then read it with `cat`.',
      'Created `hello.txt` and `cat` returned `hi`.',
    ]);
    const tools = events.filter((e) => e.type === 'tool');
    expect(tools.at(-1)).toMatchObject({
      tool: 'exec_command',
      summary: 'cat hello.txt',
      status: 'done',
      detail: { kind: 'output', text: 'hi\n' },
    });
    expect(tools.find((e) => e.tool === 'apply_patch' && e.status === 'done')).toMatchObject({
      summary: 'hello.txt',
      detail: { kind: 'diff', added: 1, removed: 0, lines: [{ kind: 'add', text: 'hi' }] },
    });
    expect(remembered).toEqual(['01a1348d-2ce8-78b1-9629-fd1c7f6a8e4b']);
    // How full the context is, and the plan's limits, as the turn went.
    expect(events.filter((e) => e.type === 'usage').at(-1)).toMatchObject({
      usage: {
        context: { used: 18_246, window: 258_400, compactAt: 244_800 },
        contextTokens: 18_246,
        contextWindow: 258_400,
      },
    });
    await turn('/mcp', 'mcp');
    expect(texts(events).at(-1)).toMatch(/^\*\*MCP servers\*\*/);
    await session.close();
    expect(problems).toEqual([]);
  });

  // The capture has no command exit or terminate response: the replay answers the added cleanup
  // request as unsupported; the real-child tests prove cleanup on a peer that supports it.
  it('a command interrupted while it runs', async () => {
    const { session, heard, ended, events, problems, sent } = await replayed('interrupt', {
      cwd: '/work/smoke/three',
      mode: 'full-access',
    });
    await session.send({ id: 'm1', text: 'Run `sleep 30` in the shell, then say done.' });
    await heard('tool', { tool: 'exec_command', summary: 'sleep 30', status: 'running' });
    await session.interrupt();
    await ended('m1');
    expect(events.at(-1)).toMatchObject({ type: 'end', result: { status: 'cancelled' } });
    expect(sent).toContainEqual({
      method: 'thread/backgroundTerminals/terminate',
      params: { threadId: '01a1348f-e329-74b3-9b25-d78465fdafb2', processId: '22733' },
    });
    expect(
      events.filter((event) => event.type === 'notice' && event.level === 'warning'),
    ).toMatchObject([{ text: expect.stringContaining('22733 may still be running') as string }]);
    expect(problems).toEqual([]);
  });

  it('a pasted image, sent as a data URL', async () => {
    const { turn, events, problems, sent } = await replayed('image', { cwd: '/work/smoke/four' });
    const data =
      'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC';
    await turn('What color is this square? Answer with one word.', 'm1', {
      images: [{ mediaType: 'image/png', data }],
    });
    expect(texts(events)).toEqual(['Red']);
    expect(sent.find((request) => request.method === 'turn/start')?.params).toMatchObject({
      input: [
        { type: 'text', text: 'What color is this square? Answer with one word.' },
        { type: 'image', url: `data:image/png;base64,${data}` },
      ],
    });
    expect(problems).toEqual([]);
  });

  it('a thread resumed with its history, then compacted', async () => {
    const { turn, events, problems } = await replayed('resume', {
      resume: '01a1348d-2ce8-78b1-9629-fd1c7f6a8e4b',
    });
    const history = events.find((e) => e.type === 'history');
    expect(history?.type === 'history' && history.events.map((e) => e.type)).toEqual([
      'user',
      'text',
      'tool',
      'tool',
      'text',
      'end',
    ]);
    // The user's message by the id it was sent with: the transcript shows it once.
    expect(history?.type === 'history' && history.events[0]).toMatchObject({
      type: 'user',
      id: 'm1',
    });
    await turn('/compact', 'c');
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'notice', text: 'Context compacted' }),
    );
    expect(events.at(-1)).toMatchObject({
      type: 'end',
      messages: ['c'],
      result: { status: 'completed' },
    });
    expect(problems).toEqual([]);
  });
});
