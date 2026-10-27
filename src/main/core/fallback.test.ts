import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UsageBackendId } from '../../shared/adapter';
import type { CanvasId } from '../../shared/canvas';
import type { AgentData, AgentNode, CanvasDocument } from '../../shared/model/canvas';
import { engineCatalog } from '../../shared/model/catalog';
import { nodeKey } from '../../shared/model/rows';
import type { TurnResult } from '../../shared/session';
import type { UsageState } from '../../shared/usage';
import { CanvasMemory } from '../memory';
import { CATALOG, DEFAULT_ADAPTER } from '../sessions/adapters';
import { Documents } from './canvas/documents';
import { commitDocument } from './canvas/test-documents';
import { MessageStore, MessageTable } from './delivery/messages';
import { Engine } from './engine/engine';
import { expectRestorable, liveRunOf } from './engine/run/test-restore';
import { fakeBackend } from './engine/test-backend';
import { FallbackService } from './fallback';
import type { FallbackDeps, FallbackRuntime } from './fallback';
import { openTestStore, refuseWrites } from './store/test-store';
import type { Store } from './store/store';

/*
 * B11a's fallback service (core/fallback.ts) over a canvas's real engine, document and messages,
 * its sessions' manager and usage the test's: admission, the walk, the lane (C4) with a fault at
 * every await, what a restart decides from what is durable, the return (C8), the preview of a
 * simulated reading, and the senders told.
 */

afterEach(expectRestorable);

const CANVAS = '7a1b2c3d-4e5f-4061-8a9b-0c1d2e3f4a5c' as CanvasId;
const NOW = Date.UTC(2026, 9, 27, 12);
const HOUR = 60 * 60_000;
const CODEX = { adapter: 'codex', connection: 'codex.app-server' };
const CLAUDE = { adapter: 'claude-code', connection: 'claude-code.terminal' };
const SDK = { adapter: 'claude-code', connection: 'claude-code.sdk' };
const LIMIT: TurnResult = {
  status: 'failed',
  reason: 'usage-limit',
  message: 'Usage limit.',
  resetsAt: NOW + HOUR,
};

/** Lets the engine's promises and microtasks settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const worker = (data: Partial<AgentData> & { unchained?: true } = {}): AgentNode => {
  const { unchained, ...rest } = data;
  const node: AgentNode = {
    id: 'worker',
    type: 'agent',
    position: { x: 0, y: 0 },
    data: {
      label: 'Worker',
      ...CODEX,
      queue: [
        { id: 'hello', message: 'Say hello' },
        { id: 'again', message: 'Say it again' },
      ],
      fallback: { to: [CLAUDE, SDK] },
      ...rest,
    },
  };
  if (unchained) delete node.data.fallback;
  return node;
};
const canvasOf = (...nodes: AgentNode[]): CanvasDocument => ({
  id: CANVAS,
  arrange: false,
  nodes,
  links: [],
});

let profile: string;
let store: Store;

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-fallback-'));
  store = await openTestStore(profile);
});
afterEach(async () => {
  await store.close();
  await rm(profile, { recursive: true, force: true });
});

/**
 * A canvas's runtime over the profile's store: its document (loaded from its rows, as a restart
 * reads them), its messages, an engine whose run is restored from `checkpoint` if given, and the
 * fallback service, its usage, sessions' manager and barrier the test's.
 */
async function world(initial?: CanvasDocument, checkpoint?: ReturnType<Engine['checkpoint']>) {
  let now = NOW;
  const memory = new CanvasMemory(store);
  const documents = new Documents({
    store,
    memory,
    catalog: CATALOG,
    defaultAdapter: DEFAULT_ADAPTER,
  });
  if (initial !== undefined) await commitDocument(documents, CANVAS, initial);
  else await documents.load(CANVAS);
  const messages = new MessageStore(CANVAS, new MessageTable(store, memory), () => now);
  await messages.load();
  // B8's holds, as UsageReadings keeps them: `durable` once a write holding them is on disk.
  const holds = new Map<UsageBackendId, { until: number; durable: boolean }>();
  let state: UsageState = { readings: [], rules: {} };
  const usage = {
    state: () => state,
    exhausted: (backend: UsageBackendId, at = now) => {
      const hold = holds.get(backend);
      return hold !== undefined && hold.until > at ? hold.until : undefined;
    },
    durably: (backend: UsageBackendId, at = now) => {
      const hold = holds.get(backend);
      return hold?.durable === true && hold.until > at ? hold.until : undefined;
    },
  };
  const sessions = {
    close: vi.fn<FallbackDeps['sessions']['close']>(() => Promise.resolve()),
    closing: vi.fn<FallbackDeps['sessions']['closing']>(() => false),
    closed: vi.fn<FallbackDeps['sessions']['closed']>(() => Promise.resolve()),
    fresh: vi.fn<FallbackDeps['sessions']['fresh']>(() => Promise.resolve()),
    availability: vi.fn<FallbackDeps['sessions']['availability']>(() =>
      Promise.resolve({ ready: true }),
    ),
  };
  let stopping = false;
  const fake = fakeBackend();
  const catalog = engineCatalog(CATALOG, DEFAULT_ADAPTER);
  const changed = vi.fn<FallbackDeps['changed']>(() => {
    engine.update(documents.live(CANVAS).document.nodes);
  });
  const delivery = { schedule: vi.fn() };
  const runtime: FallbackRuntime = {
    get document() {
      return documents.live(CANVAS).document;
    },
    get engine() {
      return engine;
    },
    messages,
    delivery,
  };
  const service: FallbackService = new FallbackService({
    catalog: CATALOG,
    defaultAdapter: DEFAULT_ADAPTER,
    canvas: (canvas) => (canvas === CANVAS ? runtime : undefined),
    documents,
    sessions,
    usage,
    changed,
    stopping: () => stopping,
    now: () => now,
    locale: 'en-US',
  });
  const engine: Engine = new Engine({
    catalog,
    backend: fake.backend,
    later: (run, ms) => {
      const timer = setTimeout(run, ms);
      return () => {
        clearTimeout(timer);
      };
    },
    now: () => now,
    usage: () => state,
    connect: () => undefined,
    admit: (agent, work) => service.admit(CANVAS, agent, work),
    limitNote: (agent) => service.limitNote(CANVAS, agent),
  });
  liveRunOf(engine.run, catalog, () => now);
  engine.update(documents.live(CANVAS).document.nodes);
  if (checkpoint !== undefined) engine.restore(checkpoint);
  /** The agent's data as the live document has it. */
  const data = (agent = 'worker') =>
    (documents.live(CANVAS).document.nodes.find((one) => one.id === agent) as AgentNode).data;
  /** What its sessions were sent, by connection, in order. */
  const sent = () => {
    const { start, send } = fake.backend;
    return send.mock.calls.map(([agent, message], i) => {
      const order = send.mock.invocationCallOrder[i] ?? 0;
      const began = start.mock.calls.findLast(
        ([to], j) => to === agent && (start.mock.invocationCallOrder[j] ?? 0) < order,
      );
      return [agent, began?.[1].connection, message.text];
    });
  };
  /** Ends agent `agent`'s last turn as its CLI would, on `connection`. */
  const end = (result: TurnResult, agent = 'worker', connection = 'codex.app-server') => {
    const [, message] = fake.backend.send.mock.calls.findLast(([to]) => to === agent) ?? [];
    if (message === undefined) throw new Error(`Nothing was sent to ${agent}.`);
    fake.emit(agent, connection, { type: 'user', id: message.id, text: message.text });
    fake.emit(agent, connection, { type: 'end', messages: [message.id], seconds: 1, result });
  };
  /** The last revision of the canvas's document, as on disk. */
  const revision = () =>
    store
      .prepare('SELECT op, by_party FROM revision WHERE canvas_id = ? ORDER BY rev DESC LIMIT 1')
      .get(CANVAS);
  const notices = (agent = 'worker') =>
    engine.sessions
      .of(agent)
      .entries.flatMap((entry) => (entry.kind === 'notice' ? [entry.text] : []));
  return {
    documents,
    messages,
    engine,
    service,
    sessions,
    fake,
    changed,
    delivery,
    data,
    sent,
    end,
    revision,
    notices,
    /** B8 holds `backend` until `until`, on disk unless said. */
    exhaust: (backend: UsageBackendId, until = NOW + HOUR, durable = true) => {
      holds.set(backend, { until, durable });
    },
    usage: (next: UsageState) => {
      state = next;
      engine.run.usageChanged();
    },
    stop: () => {
      stopping = true;
    },
    tick: (ms: number) => {
      now += ms;
    },
  };
}

/**
 * Runs the worker's first task, which fails on Codex's limit, held on disk (as Engines.#ended
 * holds it before the end reaches the run): the switch is admitted.
 */
async function limited(at: Awaited<ReturnType<typeof world>>, wait = true) {
  at.engine.run.start();
  await settle();
  at.exhaust('codex');
  at.end(LIMIT);
  if (wait) await quiet(at);
  else await settle();
}

/** Waits until no switch goes on (its writes on disk), then lets what follows settle. */
async function quiet(at: Awaited<ReturnType<typeof world>>) {
  await settle();
  await vi.waitFor(() => {
    expect(at.service.switching(CANVAS, 'worker')).toBe(false);
  });
  await settle();
}

describe('a run’s task that fails on its usage limit (§12.5)', () => {
  it('switches to the next step as corrallm and continues as one new attempt there', async () => {
    const at = await world(canvasOf(worker()));
    await limited(at);
    // The document follows the chain, committed by corrallm through Documents.change.
    expect(at.data()).toMatchObject({
      ...CLAUDE,
      fallback: {
        to: [CLAUDE, SDK],
        on: { step: 0, from: CODEX, why: 'usage-limit', at: NOW },
      },
    });
    expect(at.revision()).toEqual({ op: 'fallback.switch', by_party: 'corrallm' });
    expect(at.documents.live(CANVAS).bys.get(nodeKey('worker'))).toBe('corrallm');
    // Its session closed, its target's conversation forgotten, nothing native carried.
    expect(at.sessions.close).toHaveBeenCalledWith(CANVAS, 'worker');
    expect(at.sessions.fresh).toHaveBeenCalledExactlyOnceWith(CANVAS, 'worker', 'claude-code');
    // The task, once more, as a new attempt on Claude Code: the failed one stays failed.
    expect(at.sent()).toEqual([
      ['worker', 'codex.app-server', 'Say hello'],
      ['worker', 'claude-code.terminal', 'Say hello'],
    ]);
    const attempts = at.engine.run.snapshot().agents.worker?.attempts?.hello ?? [];
    expect(attempts).toMatchObject([
      { status: 'failed', reason: 'usage-limit' },
      { status: 'running', retryOf: attempts[0]?.id },
    ]);
    expect(at.notices()).toContainEqual(
      expect.stringMatching(
        /^Worker carries on with Claude Code · Terminal: Codex’s usage ran out until .+\. It starts a new conversation there; nothing already sent is sent again\.$/,
      ),
    );
    expect(at.service.switching(CANVAS, 'worker')).toBe(false);
  });

  it('switches nothing on a limit with no known reset, saying the chain didn’t act', async () => {
    const at = await world(canvasOf(worker()));
    at.engine.run.start();
    await settle();
    // Nothing holds Codex: its CLI said no reset, and no reading shows it used up (F1, F2).
    at.end({ status: 'failed', reason: 'usage-limit', message: 'Usage limit.' });
    await settle();
    expect(at.data()).toMatchObject(CODEX);
    expect(at.sessions.fresh).not.toHaveBeenCalled();
    expect(at.engine.run.snapshot().agents.worker?.problem).toMatchObject({
      reason: 'usage-limit',
      text: 'Usage limit. Its fallback chain didn’t act: corrallm can’t tell when this limit ends.',
    });
    expect(at.sent()).toHaveLength(1);
  });

  it('switches nothing on a hold corrallm couldn’t keep on disk', async () => {
    const at = await world(canvasOf(worker()));
    at.engine.run.start();
    await settle();
    at.exhaust('codex', NOW + HOUR, false);
    at.end(LIMIT);
    await settle();
    expect(at.data()).toMatchObject(CODEX);
    expect(at.engine.run.snapshot().agents.worker?.problem?.text).toMatch(
      /couldn’t keep this limit on disk/,
    );
  });

  it('passes a step held exhausted by, saying so', async () => {
    const at = await world(canvasOf(worker()));
    at.exhaust('claude-code', NOW + 2 * HOUR);
    await limited(at);
    // Claude Code's Terminal passed by, held; the SDK spends no backend: it is the step.
    expect(at.data()).toMatchObject(SDK);
    expect(at.notices()).toContainEqual(
      expect.stringMatching(
        /^Worker carries on with Claude Code · Agent SDK: .+ It passed by Claude Code · Terminal \(out of usage until .+\)\./,
      ),
    );
  });

  it('holds it for you as today where no step is left, saying when each can take work', async () => {
    const at = await world(canvasOf(worker({ fallback: { to: [CLAUDE] } })));
    at.exhaust('claude-code', NOW + 2 * HOUR);
    await limited(at);
    expect(at.data()).toMatchObject(CODEX);
    expect(at.sessions.close).not.toHaveBeenCalled();
    expect(at.engine.run.snapshot().agents.worker?.problem?.text).toMatch(
      /^Usage limit\. No backend in its fallback chain can take work now: Claude Code · Terminal \(out of usage until .+\)\.$/,
    );
  });

  it('never switches an agent with no chain: its task is held for you, as today', async () => {
    const at = await world(canvasOf(worker({ unchained: true })));
    await limited(at);
    expect(at.data()).toMatchObject(CODEX);
    expect(at.engine.run.snapshot().agents.worker?.problem?.text).toBe('Usage limit.');
    expect(at.sessions.close).not.toHaveBeenCalled();
  });
});

describe('a fault at every await of the switch (C4), and what a restart decides', () => {
  /**
   * The worker's task held on its limit, the switch admitted but stopped where `fault` stops it;
   * then, from what is on disk (its document as its rows are, its run as journaled), a new
   * runtime after a crash, its run resumed: what admission decides then.
   */
  async function restarted(at: Awaited<ReturnType<typeof world>>) {
    const checkpoint = at.engine.checkpoint();
    at.service.close();
    at.engine.reset();
    const again = await world(undefined, checkpoint);
    // B8's hold was on disk: it is still.
    again.exhaust('codex');
    again.engine.run.resume();
    await quiet(again);
    return again;
  }

  it('waiting for its turn to end: a pause abandons it, nothing done; resumed, it switches', async () => {
    const at = await world(canvasOf(worker()));
    at.engine.run.start();
    await settle();
    // Your own message, typed as its task goes, goes as you typed it (admission never holds
    // yours): its turn goes on as Codex's limit holds the task.
    at.engine.sessions.send('worker', 'codex', 'Mine');
    at.exhaust('codex');
    at.end(LIMIT);
    await settle();
    expect(at.engine.sessions.of('worker').status).not.toBe('idle');
    expect(at.service.switching(CANVAS, 'worker')).toBe(true);
    at.engine.run.pauseAgent('worker');
    await settle();
    expect(at.service.switching(CANVAS, 'worker')).toBe(false);
    expect(at.sessions.availability).not.toHaveBeenCalled();
    expect(at.sessions.close).not.toHaveBeenCalled();
    expect(at.data()).toMatchObject(CODEX);
    // Crashed here: nothing was done. The run resumed, your pause still holds it; released, the
    // hold on disk switches it.
    const again = await restarted(at);
    expect(again.data()).toMatchObject(CODEX);
    again.engine.run.resumeAgent('worker');
    await quiet(again);
    expect(again.data()).toMatchObject(CLAUDE);
  });

  it('checking its workspace: one held abandons it, said; a restart switches it once ready', async () => {
    const at = await world(canvasOf(worker()));
    at.sessions.availability.mockResolvedValue({
      ready: false,
      reason: 'setup',
      sentence: 'Its worktree waits for its setup.',
    });
    await limited(at);
    expect(at.data()).toMatchObject(CODEX);
    expect(at.sessions.close).not.toHaveBeenCalled();
    expect(at.notices()).toContain('Its worktree waits for its setup.');
    // It waits for a change: the run moving again tries nothing.
    at.engine.run.admissionChanged();
    await settle();
    expect(at.sessions.availability).toHaveBeenCalledOnce();
    // Its workspace ready: admission decides again.
    at.sessions.availability.mockResolvedValue({ ready: true });
    at.service.availabilityChanged(CANVAS);
    at.engine.run.admissionChanged();
    await quiet(at);
    expect(at.data()).toMatchObject(CLAUDE);
  });

  it('checking its workspace: crashed while it was held, a restart switches it once ready', async () => {
    const at = await world(canvasOf(worker()));
    at.sessions.availability.mockResolvedValue({
      ready: false,
      reason: 'setup',
      sentence: 'Its worktree waits for its setup.',
    });
    await limited(at);
    expect(at.data()).toMatchObject(CODEX);
    // What it held it for is in memory, never on disk: a new core decides again.
    const again = await restarted(at);
    expect(again.data()).toMatchObject(CLAUDE);
  });

  it('checking its workspace: a check that fails abandons it, said, never tried again in a loop', async () => {
    const at = await world(canvasOf(worker()));
    at.sessions.availability.mockRejectedValue(new Error('The resolver is gone'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await limited(at);
      at.engine.run.admissionChanged();
      await quiet(at);
    } finally {
      errors.mockRestore();
    }
    expect(at.sessions.availability).toHaveBeenCalledOnce();
    expect(at.data()).toMatchObject(CODEX);
    expect(at.notices()).toContainEqual(
      'corrallm couldn’t switch it to Claude Code · Terminal: The resolver is gone',
    );
  });

  it('closing its session: a close that hasn’t finished keeps the switch waiting, never forced', async () => {
    const at = await world(canvasOf(worker()));
    const closed = Promise.withResolvers<undefined>();
    at.sessions.closing.mockReturnValue(true);
    at.sessions.closed.mockReturnValue(closed.promise);
    await limited(at, false);
    await vi.waitFor(() => {
      expect(at.sessions.closed).toHaveBeenCalled();
    });
    expect(at.sessions.close).toHaveBeenCalled();
    expect(at.sessions.fresh).not.toHaveBeenCalled();
    expect(at.service.switching(CANVAS, 'worker')).toBe(true);
    // Crashed while waiting: nothing committed, so a restart switches it.
    const again = await restarted(at);
    expect(again.data()).toMatchObject(CLAUDE);
  });

  it('closing its session: once the close ends, the switch goes on', async () => {
    const at = await world(canvasOf(worker()));
    let closing = true;
    const closed = Promise.withResolvers<undefined>();
    at.sessions.closing.mockImplementation(() => closing);
    at.sessions.closed.mockReturnValue(closed.promise);
    await limited(at, false);
    await vi.waitFor(() => {
      expect(at.sessions.closed).toHaveBeenCalled();
    });
    expect(at.data()).toMatchObject(CODEX);
    closing = false;
    closed.resolve(undefined);
    await quiet(at);
    expect(at.data()).toMatchObject(CLAUDE);
    expect(at.sent().at(-1)).toEqual(['worker', 'claude-code.terminal', 'Say hello']);
  });

  it('closing its session: the engine’s close failing changes nothing; the core’s failing abandons it', async () => {
    const at = await world(canvasOf(worker()));
    at.fake.backend.close.mockRejectedValueOnce(new Error('Already gone'));
    await limited(at);
    // The engine's own close lets its driver go, whatever its backend said.
    expect(at.data()).toMatchObject(CLAUDE);
    at.service.close();
    at.engine.reset();
    const other = await world(canvasOf(worker()));
    other.sessions.close.mockRejectedValueOnce(new Error('The process table is full'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await limited(other);
    } finally {
      errors.mockRestore();
    }
    expect(other.sessions.fresh).not.toHaveBeenCalled();
    expect(other.notices()).toContain(
      'corrallm couldn’t switch it to Claude Code · Terminal: The process table is full',
    );
    // Nothing switched: a restart decides again.
    const again = await restarted(other);
    expect(again.data()).toMatchObject(CLAUDE);
  });

  it('forgetting its target’s conversation: a failure abandons it, said, its session closed', async () => {
    const at = await world(canvasOf(worker()));
    at.sessions.fresh.mockRejectedValueOnce(new Error('The disk is full'));
    await limited(at);
    expect(at.sessions.close).toHaveBeenCalled();
    expect(at.data()).toMatchObject(CODEX);
    expect(at.notices()).toContainEqual(
      'corrallm couldn’t start Claude Code · Terminal afresh: The disk is full',
    );
    expect(at.engine.run.snapshot().agents.worker).toMatchObject({ status: 'asking' });
    // A closed session and a conversation not forgotten are harmless: a restart switches it.
    const again = await restarted(at);
    expect(again.data()).toMatchObject(CLAUDE);
  });

  it('committing: a write that fails switches nothing, said; a restart switches it', async () => {
    const at = await world(canvasOf(worker()));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const allow = refuseWrites(profile, 'revision', 'The disk is full', CANVAS);
    try {
      await limited(at);
    } finally {
      allow();
      errors.mockRestore();
    }
    expect(at.data()).toMatchObject(CODEX);
    expect(at.notices()).toContainEqual(
      'corrallm couldn’t save its switch to Claude Code · Terminal, so it stays on Codex · App Server.',
    );
    expect(at.sent()).toHaveLength(1);
    const again = await restarted(at);
    expect(again.data()).toMatchObject(CLAUDE);
    expect(again.revision()).toEqual({ op: 'fallback.switch', by_party: 'corrallm' });
  });

  it('committing: the barrier refuses it, abandoned; decided again as the core starts', async () => {
    const at = await world(canvasOf(worker()));
    at.sessions.fresh.mockImplementationOnce(() => {
      at.stop();
      return Promise.resolve();
    });
    await limited(at);
    expect(at.data()).toMatchObject(CODEX);
    const again = await restarted(at);
    expect(again.data()).toMatchObject(CLAUDE);
  });

  it('after the commit: a crash before the task goes leaves it for your Retry, never sent again', async () => {
    const at = await world(canvasOf(worker()));
    let checkpoint: ReturnType<Engine['checkpoint']> | undefined;
    at.changed.mockImplementationOnce(() => {
      // The commit is on disk; the core dies before anything else happens.
      checkpoint = at.engine.checkpoint();
      throw new Error('crashed');
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await limited(at).finally(() => {
      errors.mockRestore();
    });
    at.service.close();
    at.engine.reset();
    const again = await world(undefined, checkpoint);
    again.exhaust('codex');
    again.engine.run.resume();
    await settle();
    // Switched: its document says so. The held task waits for you; admission switches nothing.
    expect(again.data()).toMatchObject({ ...CLAUDE, fallback: { on: { step: 0 } } });
    expect(again.engine.run.snapshot().agents.worker).toMatchObject({
      status: 'asking',
      problem: { reason: 'usage-limit' },
    });
    expect(again.sessions.fresh).not.toHaveBeenCalled();
    expect(again.sent()).toEqual([]);
  });

  it('after any await: you changing the agent abandons it; admission decides again from that', async () => {
    const at = await world(canvasOf(worker()));
    at.sessions.fresh.mockImplementationOnce(async () => {
      // You rename it as its conversation is forgotten: its revision moves.
      await commitDocument(
        at.documents,
        CANVAS,
        canvasOf(worker({ label: 'Builder', fallback: { to: [CLAUDE, SDK] } })),
      );
      at.changed(CANVAS);
    });
    await limited(at);
    // The first switch was abandoned; the next admission's committed, from the new revision.
    expect(at.sessions.fresh).toHaveBeenCalledTimes(2);
    expect(at.data()).toMatchObject({ label: 'Builder', ...CLAUDE });
  });

  it('after any await: its target used up meanwhile, the walk goes on to the next step', async () => {
    const at = await world(canvasOf(worker()));
    at.sessions.fresh.mockImplementationOnce(() => {
      at.exhaust('claude-code');
      return Promise.resolve();
    });
    await limited(at);
    expect(at.data()).toMatchObject(SDK);
    expect(at.sessions.fresh.mock.calls.map(([, , adapter]) => adapter)).toEqual([
      'claude-code',
      'claude-code',
    ]);
  });
});

describe('a usage rule that carries on with the next backend (C3)', () => {
  const RULE = { window: 'fiveHour', percent: 80, action: 'fallback' } as const;
  const reading = (simulated: boolean): UsageState => ({
    readings: [
      {
        backend: 'codex',
        windows: { fiveHour: { usedPercent: 90, resetsAt: NOW + HOUR } },
        at: NOW,
        ...(simulated ? { simulated: true as const } : {}),
      },
    ],
    rules: { codex: RULE },
  });

  it('switches between tasks on a real reading over its share: the next task goes there first', async () => {
    const at = await world(canvasOf(worker()));
    at.engine.run.start();
    await settle();
    at.usage(reading(false));
    at.end({ status: 'completed', reason: 'completed' });
    await quiet(at);
    expect(at.data()).toMatchObject({ ...CLAUDE, fallback: { on: { step: 0, why: 'rule' } } });
    // No attempt failed: the next task's first attempt went to the new endpoint.
    expect(at.sent()).toEqual([
      ['worker', 'codex.app-server', 'Say hello'],
      ['worker', 'claude-code.terminal', 'Say it again'],
    ]);
    expect(at.engine.run.snapshot().agents.worker?.attempts?.again).toHaveLength(1);
  });

  it('only previews a switch on a simulated reading, once a window, and the task goes', async () => {
    const at = await world(canvasOf(worker()));
    at.usage(reading(true));
    at.engine.run.start();
    await settle();
    expect(at.data()).toMatchObject(CODEX);
    expect(at.sent()).toEqual([['worker', 'codex.app-server', 'Say hello']]);
    at.end({ status: 'completed', reason: 'completed' });
    await settle();
    expect(at.notices().filter((text) => text.startsWith('Simulated:'))).toEqual([
      'Simulated: Worker would carry on with Claude Code · Terminal.',
    ]);
  });

  it('asks as ask does, with no chain, or no step left, saying why', async () => {
    const at = await world(canvasOf(worker({ fallback: { to: [CLAUDE] } })));
    at.exhaust('claude-code');
    at.usage(reading(false));
    at.engine.run.start();
    await settle();
    expect(at.engine.run.snapshot().agents.worker).toMatchObject({
      status: 'asking',
      usage: { backend: 'codex', used: 90 },
    });
    expect(at.notices()).toContainEqual(
      expect.stringMatching(
        /^No backend in its fallback chain can take work now: Claude Code · Terminal \(out of usage until .+\)\.$/,
      ),
    );
    expect(at.sent()).toEqual([]);
  });
});

describe('switching back at the reset (C8)', () => {
  const ON = {
    to: [CLAUDE],
    back: 'return' as const,
    on: { step: 0, from: CODEX, why: 'usage-limit' as const, at: NOW - HOUR },
  };

  it('returns at the next task once its own backend can take work, as corrallm', async () => {
    const at = await world(canvasOf(worker({ ...CLAUDE, fallback: ON })));
    at.engine.run.start();
    await quiet(at);
    expect(at.revision()).toEqual({ op: 'fallback.return', by_party: 'corrallm' });
    expect(at.data()).toMatchObject({ ...CODEX, fallback: { to: [CLAUDE], back: 'return' } });
    expect(at.data().fallback).not.toHaveProperty('on');
    expect(at.sessions.fresh).toHaveBeenCalledWith(CANVAS, 'worker', 'codex');
    expect(at.sent()).toEqual([['worker', 'codex.app-server', 'Say hello']]);
    expect(at.notices()).toContainEqual(
      expect.stringMatching(/^Worker is back on Codex · App Server: Codex can take work again\./),
    );
  });

  it('stays while its own backend is held, and never returns a held task or with Stay', async () => {
    const held = await world(canvasOf(worker({ ...CLAUDE, fallback: ON })));
    held.exhaust('codex');
    held.engine.run.start();
    await settle();
    expect(held.data()).toMatchObject(CLAUDE);
    expect(held.sent()).toEqual([['worker', 'claude-code.terminal', 'Say hello']]);
    held.service.close();
    held.engine.reset();
    const stay = await world(
      canvasOf(worker({ ...CLAUDE, fallback: { to: [CLAUDE], on: ON.on } })),
    );
    stay.engine.run.start();
    await settle();
    expect(stay.data()).toMatchObject(CLAUDE);
  });
});

describe('the senders of messages that failed on the limit (C5)', () => {
  it('are told once that it carries on elsewhere, their message not sent again', async () => {
    const at = await world(canvasOf(worker()));
    const original = at.messages.add({
      from: 'outside:orchestrator',
      to: 'agent:worker',
      kind: 'text',
      origin: 'party',
      body: 'Review this',
      state: 'replied',
    });
    at.messages.add({
      from: 'agent:worker',
      to: 'outside:orchestrator',
      kind: 'text',
      origin: 'party',
      body: '',
      replyTo: original.id,
      turn: { status: 'failed', reason: 'usage-limit', resetsAt: NOW + HOUR },
      state: 'delivered',
    });
    await limited(at);
    const told = at.messages
      .all()
      .filter((message) => message.kind === 'notice' && message.replyTo === original.id);
    expect(told).toMatchObject([
      {
        from: 'corrallm',
        to: 'outside:orchestrator',
        body: 'Worker carries on with Claude Code · Terminal; your message wasn’t sent again.',
      },
    ]);
  });
});
