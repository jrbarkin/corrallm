import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OpResult } from '../../shared/api/errors';
import type { OpName } from '../../shared/api/surface';
import type { CanvasId } from '../../shared/canvas';
import type { Run } from '../../shared/engine/run/runner';
import type { QueueItem } from '../../shared/model/queue';
import type { SessionMode, UserMessage } from '../../shared/session';
import type { Connector, SessionHost } from '../sessions/connector';
import { FakeConnector } from '../sessions/fake';
import type { Caller, OutsideCaller } from './caller';
import { createCore } from './core';
import type { Core } from './core';
import { STORE_FILE } from './store/open';
import { journaledRun, keepCanvases, refuseWrites } from './store/test-store';
import { CALLERS, NO_DESKTOP } from './test-registry';

/*
 * The whole run's controls as the core serves them (B11 Design §6, Core Server §4 F): run.start
 * (Run, and Run again), run.resume, run.stop and run.goOn, through core.call, as you and as an
 * outside token, with R9 (a token never resumes or starts afresh past what is yours) and R3 (a
 * usage rule's Go on is yours alone).
 */

const CANVAS = '5c2a7d3f-9e4b-4f60-8b1c-8d7e6f5a4b3c' as CanvasId;
const ORCHESTRATOR: OutsideCaller = {
  kind: 'outside',
  token: 'write-token',
  name: 'orchestrator',
  access: 'write',
  canvases: [CANVAS],
};
const YOU = CALLERS.you;
const HOUR = { seconds: 3600 };

let profile: string;
let project: string;
const cores: Core[] = [];

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-run-control-'));
  project = path.join(profile, 'project');
  await mkdir(project);
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const core of cores.splice(0)) await core.close().catch(() => undefined);
  await rm(profile, { recursive: true, force: true });
});

/** Keeps a canvas of agents `queues` names (each with its queue), on Codex's app server. */
async function keep(queues: Readonly<Record<string, QueueItem[]>>): Promise<void> {
  const file = path.join(profile, 'canvas.corral');
  await writeFile(
    file,
    JSON.stringify({
      format: 'corrallm',
      version: 2,
      id: CANVAS,
      nodes: Object.entries(queues).map(([id, queue], i) => ({
        id,
        kind: 'agent',
        label: `${id.charAt(0).toUpperCase()}${id.slice(1)}`,
        position: { x: 0, y: i * 100 },
        adapter: 'codex',
        connection: 'codex.app-server',
        queue,
      })),
      links: [],
    }),
  );
  await keepCanvases(profile, { [CANVAS]: { file, project } });
}

/** A core over the profile (or `at`), its canvas open and delivering. */
async function start(codex: Connector<SessionMode>, at = profile): Promise<Core> {
  const core = await createCore(
    {
      profile: at,
      app: { name: 'corrallm', version: '9.8.7' },
      check: true,
      distribution: 'local',
      sessions: {
        connectors: { 'codex.app-server': codex },
        environment: () => Promise.resolve({}),
      },
      watchFolder: () => ({ close: () => undefined }),
    },
    NO_DESKTOP,
  );
  cores.push(core);
  return core;
}

/**
 * A connector whose agents take each message and work on it until the test ends its turn, or an
 * interrupt does (cancelled). `starting`: a session start that doesn't finish until `release()`
 * fails it.
 */
function controlled({ starting = false }: { starting?: boolean } = {}) {
  const codex = new FakeConnector({ adapter: 'codex' });
  const hung: ((error: Error) => void)[] = [];
  const release = () => {
    for (const fail of hung.splice(0)) fail(new Error('The test let go of it.'));
  };
  const sent: (UserMessage & { agent: string })[] = [];
  const hosts = new Map<string, SessionHost>();
  const going = new Map<string, string[]>();
  const end = (agent: string, status: 'completed' | 'cancelled' = 'completed') => {
    const host = hosts.get(agent);
    const ids = going.get(agent) ?? [];
    going.set(agent, []);
    host?.emit({ type: 'text', id: `reply-${ids.join('-')}`, text: 'Hello' });
    host?.emit({
      type: 'end',
      messages: ids,
      seconds: 1,
      result: { status, reason: status === 'completed' ? 'completed' : 'interrupted' },
    });
  };
  const connector: Connector<SessionMode> = {
    start: async (spec, host) => {
      if (starting) {
        return new Promise((_resolve, reject) => {
          hung.push(reject);
        });
      }
      const agent = spec.agentId;
      hosts.set(agent, host);
      const session = await codex.start(spec, host);
      session.send = (message) => {
        sent.push({ ...message, agent });
        going.set(agent, [...(going.get(agent) ?? []), message.id]);
        host.emit({ type: 'user', id: message.id, text: message.text });
        host.emit({ type: 'status', status: 'working' });
        return Promise.resolve();
      };
      session.interrupt = () => {
        if ((going.get(agent) ?? []).length > 0) end(agent, 'cancelled');
        return Promise.resolve();
      };
      return session;
    },
  };
  return { connector, sent, end, release };
}

/** What a call answered, refused unless it went. */
function ok<T>(result: OpResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.sentence}`);
  return result.value;
}

/** The canvas's run as the core runs it now. */
function runOf(core: Core): Run {
  const open = core.engines.canvas(CANVAS);
  if (!open) throw new Error('The canvas isn’t open');
  return open.engine.run.snapshot();
}

/** The canvas's run as journaled on disk. */
function runOnDisk(at = profile): Run | undefined {
  const saved = journaledRun(at, CANVAS);
  return saved === undefined ? undefined : (JSON.parse(saved.state) as { run: Run }).run;
}

let requests = 0;
/** A fresh request id. */
const request = () => `6d7e8f90-a1b2-4c3d-8e4f-${String((requests += 1)).padStart(12, '0')}`;

const call = (core: Core, name: OpName, args: object, caller: Caller = YOU) =>
  core.call(name, { canvas: CANVAS, request: request(), ...args }, caller);

describe('run.start', () => {
  it('runs every queue from the top, each send on disk before it goes, and returns once the start is', async () => {
    await keep({
      worker: [{ id: 'hello', message: 'Say hello' }],
      napper: [{ id: 'nap', delay: HOUR }],
    });
    const { connector, sent } = controlled();
    let atSend: Run | undefined;
    const watched: Connector<SessionMode> = {
      start: async (spec, host) => {
        const session = await connector.start(spec, host);
        const send = session.send.bind(session);
        session.send = (message) => {
          atSend = runOnDisk();
          return send(message);
        };
        return session;
      },
    };
    const core = await start(watched);
    await core.engines.open(CANVAS);
    const result = ok(await call(core, 'run.start', {}));
    // The start itself is on disk once it returns: the napper's delay too, which sends nothing.
    expect(runOnDisk()).toMatchObject({ running: true, agents: { napper: { status: 'waiting' } } });
    expect(result).toHaveProperty(['revs', `run:${CANVAS}`]);
    await vi.waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    // The attempt the message is, and its link, were on disk before the session got it.
    const attempt = runOf(core).agents.worker?.attempts?.hello?.[0];
    expect(atSend?.agents.worker?.attempts?.hello).toEqual([
      expect.objectContaining({ id: attempt?.id, status: 'running', messageId: sent[0]?.id }),
    ]);
  });

  it('is Run again on a run going or stopped: what it sent is taken back, every queue begins afresh, pauses kept', async () => {
    await keep({
      worker: [{ id: 'hello', message: 'Say hello' }],
      other: [{ id: 'other', message: 'Other work' }],
    });
    const { connector, sent } = controlled();
    const core = await start(connector);
    await core.engines.open(CANVAS);
    ok(await call(core, 'run.start', {}));
    await vi.waitFor(() => {
      expect(sent).toHaveLength(2);
    });
    const first = runOf(core).agents.worker?.attempts?.hello?.[0]?.id;
    const firstSent = sent.find(({ agent }) => agent === 'worker')?.id ?? '';
    ok(await call(core, 'run.pause', { target: { agent: 'other' } }));
    ok(await call(core, 'run.start', {}));
    const messages = await core.engines.messagesOf(CANVAS);
    await vi.waitFor(() => {
      expect(sent.filter(({ agent }) => agent === 'worker')).toHaveLength(2);
    });
    // The first send was taken back; the worker's queue began again, with a new attempt.
    expect(messages.get(firstSent)).toMatchObject({ state: 'withdrawn' });
    const again = runOf(core).agents.worker?.attempts?.hello ?? [];
    expect(again).toEqual([expect.objectContaining({ status: 'running' })]);
    expect(again[0]?.id).not.toBe(first);
    // Your pause of the other agent holds still: its queue starts again but sends nothing.
    expect(runOf(core).agents.other).toMatchObject({ paused: true });
    expect(sent.filter(({ agent }) => agent === 'other')).toHaveLength(1);
    // Run again from stopped, too.
    ok(await call(core, 'run.stop', {}));
    ok(await call(core, 'run.start', {}));
    expect(runOf(core)).toMatchObject({ running: true });
    expect(runOf(core)).not.toHaveProperty('paused', true);
  });

  it('never sends twice or loses the start when the core crashes between the journal and the send', async () => {
    await keep({ worker: [{ id: 'hello', message: 'Say hello' }] });
    // The agent's session never finishes starting: the message is recorded, and never sent.
    const stuck = controlled({ starting: true });
    const core = await start(stuck.connector);
    await core.engines.open(CANVAS);
    ok(await call(core, 'run.start', {}));
    const messages = await core.engines.messagesOf(CANVAS);
    await vi.waitFor(() => {
      expect(runOnDisk()?.agents.worker?.attempts?.hello).toEqual([
        expect.objectContaining({ status: 'running', messageId: expect.any(String) as string }),
      ]);
    });
    const [message] = messages.all();
    expect(message).toMatchObject({ state: 'delivering' });
    expect(messages.originOf(message?.id ?? '')).toBe('run');
    // The crash: the store as it is on disk now, opened by another core.
    const crashed = await mkdtemp(path.join(tmpdir(), 'corrallm-run-control-crashed-'));
    try {
      for (const file of await readdir(profile)) {
        if (file.startsWith(STORE_FILE)) {
          await copyFile(path.join(profile, file), path.join(crashed, file));
        }
      }
      const again = controlled();
      const restarted = await start(again.connector, crashed);
      await restarted.engines.initialize();
      const restored = restarted.engines.canvas(CANVAS);
      // The start is kept: the run restored paused, by the restart, its attempt uncertain.
      expect(restored?.engine.run.snapshot()).toMatchObject({
        running: false,
        paused: true,
        pausedBy: 'corrallm',
        agents: { worker: { status: 'asking', problem: { kind: 'uncertain' } } },
      });
      expect(restored?.messages.get(message?.id ?? '')).toMatchObject({ state: 'unresolved' });
      // A token may resume what a restart paused; nothing cut off is sent again.
      ok(await restarted.call('run.resume', { canvas: CANVAS, request: request() }, ORCHESTRATOR));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(again.sent).toEqual([]);
      expect(stuck.sent).toEqual([]);
    } finally {
      stuck.release();
      await rm(crashed, { recursive: true, force: true });
    }
  });

  it('fails closed when its start can’t be saved: nothing is sent, and it says so', async () => {
    await keep({ worker: [{ id: 'hello', message: 'Say hello' }] });
    const { connector, sent } = controlled();
    const core = await start(connector);
    await core.engines.open(CANVAS);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const allow = refuseWrites(profile, 'run', 'The disk is full', CANVAS);
    try {
      expect(await call(core, 'run.start', {})).toMatchObject({
        ok: false,
        error: {
          code: 'unavailable',
          sentence: expect.stringMatching(/could not be saved/) as string,
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(sent).toEqual([]);
    } finally {
      allow();
      errors.mockRestore();
    }
  });
});

describe('run.resume', () => {
  it('goes on from where the run stopped: nothing finished restarts, nothing cut off is sent again', async () => {
    await keep({
      worker: [
        { id: 'one', message: 'One' },
        { id: 'two', message: 'Two' },
        { id: 'three', message: 'Three' },
      ],
    });
    const { connector, sent, end } = controlled();
    const core = await start(connector);
    await core.engines.open(CANVAS);
    ok(await call(core, 'run.start', {}));
    await vi.waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    end('worker');
    await vi.waitFor(() => {
      expect(sent).toHaveLength(2);
    });
    ok(await call(core, 'run.stop', {}));
    expect(runOf(core).agents.worker).toMatchObject({
      outcomes: { one: 'succeeded' },
      status: 'asking',
      problem: { kind: 'cancelled' },
    });
    ok(await call(core, 'run.resume', {}));
    expect(runOf(core)).toMatchObject({ running: true, paused: false });
    await new Promise((resolve) => setTimeout(resolve, 50));
    // One stays done, two waits for your decision, and three hasn't begun.
    expect(sent.map(({ text }) => text)).toEqual(['One', 'Two']);
    expect(runOf(core).agents.worker).toMatchObject({
      current: 'two',
      status: 'asking',
      outcomes: { one: 'succeeded' },
    });
  });

  it('changes nothing on a run going, and refuses one with nothing to resume', async () => {
    await keep({ napper: [{ id: 'nap', delay: HOUR }] });
    const { connector } = controlled();
    const core = await start(connector);
    await core.engines.open(CANVAS);
    expect(await call(core, 'run.resume', {})).toMatchObject({
      ok: false,
      error: { code: 'refused', sentence: expect.stringMatching(/nothing to resume/) as string },
    });
    ok(await call(core, 'run.start', {}));
    const going = runOf(core);
    const resumed = ok(await call(core, 'run.resume', {}));
    expect(runOf(core)).toBe(going);
    expect(resumed).toEqual({ revs: {} });
  });
});

describe('run.stop', () => {
  it('holds only the run’s own sends: what it sent is taken back, and a party’s message still goes', async () => {
    await keep({ worker: [{ id: 'hello', message: 'Say hello' }] });
    const { connector, sent } = controlled();
    const core = await start(connector);
    await core.engines.open(CANVAS);
    ok(await call(core, 'run.start', {}));
    await vi.waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    ok(await call(core, 'run.stop', {}, ORCHESTRATOR));
    const messages = await core.engines.messagesOf(CANVAS);
    expect(messages.get(sent[0]?.id ?? '')).toMatchObject({ state: 'withdrawn' });
    expect(runOf(core)).toMatchObject({
      running: false,
      paused: true,
      pausedBy: 'outside:orchestrator',
    });
    expect(runOnDisk()).toMatchObject({ paused: true, pausedBy: 'outside:orchestrator' });
    // A party's message reaches the idle agent while the run stays stopped.
    const party = ok(
      await call(core, 'message', { to: 'worker', body: 'Party work' }, ORCHESTRATOR),
    );
    await vi.waitFor(() => {
      expect(sent).toHaveLength(2);
    });
    expect(sent[1]?.text).toContain('Party work');
    expect(messages.get((party as { id: string }).id)?.state).toBe('delivered');
    expect(runOf(core)).toMatchObject({ running: false, paused: true });
  });
});

describe('R9: a token never undoes your stop or your decisions', () => {
  it('lets a token resume its own stop, or a restart’s, never yours', async () => {
    await keep({ napper: [{ id: 'nap', delay: HOUR }] });
    const core = await start(controlled().connector);
    await core.engines.open(CANVAS);
    ok(await call(core, 'run.start', {}, ORCHESTRATOR));
    ok(await call(core, 'run.stop', {}, ORCHESTRATOR));
    ok(await call(core, 'run.resume', {}, ORCHESTRATOR));
    ok(await call(core, 'run.stop', {}));
    // A token's stop of what you stopped leaves it yours.
    ok(await call(core, 'run.stop', {}, ORCHESTRATOR));
    expect(await call(core, 'run.resume', {}, ORCHESTRATOR)).toMatchObject({
      ok: false,
      error: {
        code: 'refused',
        sentence:
          'The run stays stopped by the user: only the party that stopped it, or the user, resumes it.',
      },
    });
    expect(await call(core, 'run.start', {}, ORCHESTRATOR)).toMatchObject({
      ok: false,
      error: {
        code: 'refused',
        sentence: expect.stringMatching(/^The run is stopped by the user/) as string,
      },
    });
    expect(runOf(core)).toMatchObject({ running: false, paused: true, pausedBy: 'you' });
    ok(await call(core, 'run.resume', {}));
    expect(runOf(core)).toMatchObject({ running: true });
  });

  it('lets a token start afresh only a run no one else decided in, nor waits for you', async () => {
    await keep({
      worker: [
        { id: 'ok', approve: 'The plan' },
        { id: 'nap', delay: HOUR },
      ],
    });
    const core = await start(controlled().connector);
    await core.engines.open(CANVAS);
    ok(await call(core, 'run.start', {}, ORCHESTRATOR));
    // The OK waits for you: starting afresh would discard it.
    expect(await call(core, 'run.start', {}, ORCHESTRATOR)).toMatchObject({
      ok: false,
      error: {
        code: 'refused',
        sentence:
          'Worker waits for the user to decide, and starting the run afresh would discard that: only the user starts it afresh now.',
      },
    });
    const needs = ok(await core.call('needs', { canvas: CANVAS }, YOU)) as {
      items: { id: string; agent?: string }[];
    };
    const hold = needs.items.find((item) => item.agent === 'worker')?.id ?? '';
    ok(await call(core, 'reply', { to: hold, answer: { choice: 'approve' } }));
    expect(runOf(core).decided).toEqual(['you']);
    // You approved it: starting afresh would undo that.
    expect(await call(core, 'run.start', {}, ORCHESTRATOR)).toMatchObject({
      ok: false,
      error: {
        code: 'refused',
        sentence:
          'The user decided in this run, and starting it afresh would undo that: only the user starts it afresh now.',
      },
    });
    // Yours starts it afresh, forgetting who decided.
    ok(await call(core, 'run.start', {}));
    expect(runOf(core)).not.toHaveProperty('decided');
    ok(await call(core, 'run.stop', {}));
    ok(await call(core, 'run.start', {}));
    expect(runOf(core).agents.worker).toMatchObject({ status: 'asking', current: 'ok' });
  });

  it('lets a token Run again its own run when nothing is yours', async () => {
    await keep({ napper: [{ id: 'nap', delay: HOUR }] });
    const core = await start(controlled().connector);
    await core.engines.open(CANVAS);
    ok(await call(core, 'run.start', {}, ORCHESTRATOR));
    ok(await call(core, 'run.start', {}, ORCHESTRATOR));
    ok(await call(core, 'run.stop', {}, ORCHESTRATOR));
    ok(await call(core, 'run.start', {}, ORCHESTRATOR));
    expect(runOf(core)).toMatchObject({ running: true, agents: { napper: { status: 'waiting' } } });
  });
});

describe('run.goOn', () => {
  it('ends the delay an agent is held at now, once, and refuses what isn’t its hold now', async () => {
    await keep({
      worker: [
        { id: 'nap', delay: HOUR },
        { id: 'hello', message: 'Say hello' },
      ],
    });
    const { connector, sent } = controlled();
    const core = await start(connector);
    await core.engines.open(CANVAS);
    // The run isn't going: nothing holds it.
    expect(await call(core, 'run.goOn', { agent: 'worker', item: 'nap' })).toMatchObject({
      ok: false,
      error: { code: 'refused' },
    });
    ok(await call(core, 'run.start', {}));
    const until = runOf(core).agents.worker?.until;
    expect(until).toEqual(expect.any(Number));
    expect(await call(core, 'run.goOn', { agent: 'worker', item: 'missing' })).toMatchObject({
      ok: false,
      error: { code: 'not-found', sentence: 'Worker’s queue has no item missing.' },
    });
    expect(await call(core, 'run.goOn', { agent: 'worker', item: 'hello' })).toMatchObject({
      ok: false,
      error: { code: 'conflict' },
    });
    // A deadline other than the one it is held until: another hold than the caller saw.
    expect(
      await call(core, 'run.goOn', { agent: 'worker', item: 'nap', until: (until ?? 0) + 1 }),
    ).toMatchObject({ ok: false, error: { code: 'conflict' } });
    expect(sent).toEqual([]);
    const result = ok(
      await call(core, 'run.goOn', { agent: 'worker', item: 'nap', until }, ORCHESTRATOR),
    );
    expect(result).toHaveProperty(['revs', `run:${CANVAS}`]);
    await vi.waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(runOf(core).agents.worker).toMatchObject({ outcomes: { nap: 'succeeded' } });
    expect(runOf(core).decided).toEqual(['outside:orchestrator']);
    // Stale now: it is past that hold, and a second Go on is refused, not a silent success.
    expect(await call(core, 'run.goOn', { agent: 'worker', item: 'nap' })).toMatchObject({
      ok: false,
      error: {
        code: 'conflict',
        sentence: expect.stringMatching(/isn’t held at nap now/) as string,
      },
    });
  });

  it('refuses while the run is stopped or the agent is paused, saying who holds it', async () => {
    await keep({ worker: [{ id: 'nap', delay: HOUR }] });
    const core = await start(controlled().connector);
    await core.engines.open(CANVAS);
    ok(await call(core, 'run.start', {}));
    ok(await call(core, 'run.pause', { target: { agent: 'worker' } }));
    expect(
      await call(core, 'run.goOn', { agent: 'worker', item: 'nap' }, ORCHESTRATOR),
    ).toMatchObject({
      ok: false,
      error: {
        code: 'refused',
        sentence: expect.stringMatching(/^Worker is paused by the user/) as string,
      },
    });
    ok(await call(core, 'run.unpause', { target: { agent: 'worker' } }));
    ok(await call(core, 'run.stop', {}));
    expect(await call(core, 'run.goOn', { agent: 'worker', item: 'nap' })).toMatchObject({
      ok: false,
      error: { code: 'refused', sentence: expect.stringMatching(/^The run is stopped/) as string },
    });
  });

  it('ends a wait for another agent as timed out', async () => {
    await keep({
      worker: [{ id: 'wait', waitFor: [{ agent: 'other', item: 'work' }] }],
      other: [
        { id: 'nap', delay: HOUR },
        { id: 'work', message: 'Work' },
      ],
    });
    const core = await start(controlled().connector);
    await core.engines.open(CANVAS);
    ok(await call(core, 'run.start', {}));
    expect(runOf(core).agents.worker).toMatchObject({ status: 'waiting', current: 'wait' });
    ok(await call(core, 'run.goOn', { agent: 'worker', item: 'wait' }));
    expect(runOf(core).agents.worker).toMatchObject({ outcomes: { wait: 'timedOut' } });
  });

  it('leaves a usage rule’s hold to you alone (R3), and ends it for you', async () => {
    await keep({ worker: [{ id: 'hello', message: 'Say hello' }] });
    const { connector, sent } = controlled();
    const core = await start(connector);
    await core.engines.open(CANVAS);
    ok(
      await core.call(
        'usage.setRule',
        { backend: 'codex', rule: { window: 'fiveHour', percent: 50, action: 'waitForReset' } },
        YOU,
      ),
    );
    ok(
      await core.call(
        'usage.simulate',
        {
          backend: 'codex',
          windows: { fiveHour: { usedPercent: 90, resetsAt: Date.now() + 3_600_000 } },
        },
        YOU,
      ),
    );
    ok(await call(core, 'run.start', {}));
    expect(runOf(core).agents.worker).toMatchObject({
      status: 'waiting',
      current: 'hello',
      usage: { backend: 'codex' },
    });
    expect(
      await call(core, 'run.goOn', { agent: 'worker', item: 'hello' }, ORCHESTRATOR),
    ).toMatchObject({
      ok: false,
      error: {
        code: 'refused',
        sentence: expect.stringMatching(
          /^Only the user goes on past a usage rule: Worker waits/,
        ) as string,
      },
    });
    expect(sent).toEqual([]);
    ok(await call(core, 'run.goOn', { agent: 'worker', item: 'hello' }));
    await vi.waitFor(() => {
      expect(sent).toHaveLength(1);
    });
  });
});
