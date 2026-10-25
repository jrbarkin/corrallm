import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { ConnectionId } from '../../shared/adapter';
import { MAX_MESSAGE_BYTES } from '../../shared/api/limits';
import { decodeSubmissions } from '../../shared/engine/delivery/submission-state';
import { Engine, RETRY_CHECK_MS } from '../../shared/engine/engine';
import { holdGeneration } from '../../shared/engine/needs';
import { fakeBackend } from '../../shared/engine/test-backend';
import { TEST_ENGINE } from '../../shared/engine/test-engine';
import type { Message } from '../../shared/model/messages';
import type { RunCheckpoint, RunRestore } from '../../shared/run';
import type { SessionEvent, SessionMode, UserMessage } from '../../shared/session';
import type { Connector, SessionHost } from '../sessions/connector';
import { SessionManager, STALLED_INTERRUPT_MS } from '../sessions/manager';
import { createCore } from './core';
import type { Core, CoreConfig } from './core';
import { STALL_MS, WATCH_EVERY_MS } from './stalled';
import { journaledRun, keepCanvases } from './store/test-store';
import { CALLERS, CANVAS, NO_DESKTOP } from './test-registry';

let profile: string;
let core: Core;
let config: CoreConfig;
let now: number;
let tick: (() => void) | undefined;
let host: SessionHost;
let hosts: Map<string, SessionHost>;
let active: string[];
let sent: UserMessage[];
let interrupt: ReturnType<typeof vi.fn<() => Promise<void>>>;

function end(status: 'completed' | 'cancelled' = 'cancelled'): void {
  const messages = active;
  active = [];
  host.emit({
    type: 'end',
    messages,
    seconds: 1,
    result: { status, reason: status === 'completed' ? 'completed' : 'interrupted' },
  });
}

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-resend-'));
  const project = path.join(profile, 'project');
  await mkdir(project);
  const file = path.join(profile, 'canvas.corral');
  await writeFile(
    file,
    JSON.stringify({
      format: 'corrallm',
      version: 2,
      id: CANVAS,
      nodes: [
        {
          id: 'a',
          kind: 'agent',
          label: 'Agent',
          adapter: 'codex',
          connection: 'codex.app-server',
          position: { x: 0, y: 0 },
          queue: [{ id: 'task', message: 'Queue work' }],
        },
        {
          id: 'b',
          kind: 'agent',
          label: 'Peer',
          adapter: 'codex',
          connection: 'codex.app-server',
          position: { x: 200, y: 0 },
        },
      ],
      links: [{ agents: ['a', 'b'] }],
    }),
  );
  await keepCanvases(profile, { [CANVAS]: { file, project } });
  now = Date.now();
  active = [];
  sent = [];
  hosts = new Map();
  interrupt = vi.fn(() => Promise.resolve()); // Ending the turn is separate from the RPC's ack.
  const connector: Connector<SessionMode> = {
    start: (spec, given) => {
      hosts.set(spec.agentId, given);
      if (spec.agentId === 'a') host = given;
      given.emit({ type: 'started', model: null, mode: 'auto', models: [] });
      return Promise.resolve({
        send: (message) => {
          if (spec.agentId === 'a') {
            sent.push(message);
            active.push(message.id);
          }
          given.emit({ type: 'user', id: message.id, text: message.text });
          given.emit({ type: 'status', status: 'working' });
          return Promise.resolve();
        },
        interrupt,
        answer: () => Promise.resolve(),
        close: () => Promise.resolve(),
        setMode: () => Promise.resolve(),
        setModel: () => Promise.resolve(),
      });
    },
  };
  config = {
    profile,
    app: { name: 'corrallm', version: '1.0.0' },
    check: true,
    distribution: 'local',
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
      connectors: { 'codex.app-server': connector },
      environment: () => Promise.resolve({}),
    },
    watchFolder: () => ({ close: () => undefined }),
  };
  core = await createCore(config, NO_DESKTOP);
  await core.engines.open(CANVAS);
});
afterEach(async () => {
  await core.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
  await rm(profile, { recursive: true, force: true });
});

async function call(
  name: 'reply' | 'message' | 'run.pause' | 'run.unpause' | 'withdraw' | 'canvas.move',
  args: object,
  caller = CALLERS.you,
) {
  return core.call(name, { canvas: CANVAS, ...args }, caller);
}
/**
 * The run on disk is `saved`, its submissions as the engine restores them (your messages now:
 * delivery/submissions.ts).
 */
function expectJournaled(saved: RunCheckpoint): void {
  const journaled = journaledRun(profile, CANVAS);
  expect(journaled).toMatchObject({ version: 2, state: saved.state, updatedAt: saved.updatedAt });
  expect(decodeSubmissions(journaled?.messages ?? '')).toEqual(decodeSubmissions(saved.messages));
}
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Expected a recorded value');
  return value;
}

async function send(caller = CALLERS['outside-write']): Promise<Message> {
  const result = await call('message', { to: 'a', body: 'Party work' }, caller);
  expect(result.ok).toBe(true);
  if (!result.ok || !('id' in result.value)) throw new Error('No message');
  await vi.waitFor(() => {
    expect(sent).toHaveLength(1);
  });
  return required((await core.engines.messagesOf(CANVAS)).get(String(result.value.id)));
}
async function stall(): Promise<void> {
  for (let i = 0; i < STALL_MS / WATCH_EVERY_MS; i++) {
    now += WATCH_EVERY_MS;
    tick?.();
  }
  await vi.waitFor(async () => {
    expect(await core.call('needs', { canvas: CANVAS }, CALLERS.you)).toMatchObject({
      ok: true,
      value: { items: [expect.objectContaining({ id: 'stalled/a' })] },
    });
  });
}
const choose = () => call('reply', { to: 'stalled/a', answer: { choice: 'resend' } });
const texts = async () =>
  (await core.engines.messagesOf(CANVAS))
    .all()
    .filter((m) => m.kind === 'text' && m.to === 'agent:a');
const needIds = async () => {
  const needs = await core.call('needs', { canvas: CANVAS }, CALLERS.you);
  if (!needs.ok) throw new Error('No needs');
  return (needs.value as { items: { id: string }[] }).items.map(({ id }) => id);
};

/** `promise`, and whether it has settled yet (`done`), however it settles. */
function settles<T>(promise: Promise<T>): { promise: Promise<T>; done: boolean } {
  const watched = { promise, done: false };
  promise.then(
    () => {
      watched.done = true;
    },
    () => {
      watched.done = true;
    },
  );
  return watched;
}

/**
 * From here the test moves setTimeout: whatever a held resend's checks would do on a later re-check
 * happens before the guard's assertion, never after it by chance. Timers still follow real time,
 * so nothing else waits forever.
 */
function controlTimers(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
}

/**
 * A guard that nothing was sent: once a resend's hold is seen, past several of its re-checks and
 * every journal write they made, so a send that went anyway has been decided and handed over.
 */
async function settled(): Promise<void> {
  await vi.advanceTimersByTimeAsync(RETRY_CHECK_MS * 4);
  await core.flush();
}

/** The resend waits on a hold, worded `why` to its sender, through its re-checks: none sent. */
async function heldResend(origin: 'party' | 'manual' | 'run', why: string): Promise<void> {
  const engine = required(core.engines.canvas(CANVAS)).engine;
  await vi.waitFor(async () => {
    if (origin === 'run') {
      // Its reserved retry waits behind the cancelled attempt; nothing has decided a new one.
      expect(engine.run.snapshot().agents.a?.problem?.kind).toBe('cancelled');
      expect(await needIds()).toContain(
        `hold/a/${holdGeneration(engine.run.snapshot().agents.a)}/task`,
      );
      return;
    }
    const resent = (await texts())[1];
    expect(resent?.state).toBe('pending');
    expect((await core.engines.messagesOf(CANVAS)).all()).toContainEqual(
      expect.objectContaining({
        kind: 'notice',
        to: resent?.from,
        replyTo: resent?.id,
        body: expect.stringContaining(why) as string,
      }),
    );
  });
  await settled();
  expect(sent).toHaveLength(1);
  if (origin === 'run') {
    expect(engine.run.snapshot().agents.a).toMatchObject({ problem: { kind: 'cancelled' } });
    expect(engine.run.snapshot().agents.a?.attempts?.task).toMatchObject([{ status: 'cancelled' }]);
  } else {
    expect((await texts())[1]?.state).toBe('pending');
  }
}

it('offers the user Interrupt and resend, and refuses a token', async () => {
  await send();
  await stall();
  expect(await core.call('needs', { canvas: CANVAS }, CALLERS.you)).toMatchObject({
    ok: true,
    value: {
      items: [
        expect.objectContaining({
          choices: [
            { value: 'interrupt', label: 'Interrupt' },
            { value: 'resend', label: 'Interrupt and resend' },
          ],
        }),
      ],
    },
  });
  expect(
    await call(
      'reply',
      { to: 'stalled/a', answer: { choice: 'resend' } },
      CALLERS['outside-write'],
    ),
  ).toMatchObject({ ok: false });
  expect(interrupt).not.toHaveBeenCalled();
});

it('resends a party message only after cancellation, with a new id, link and one sender notice', async () => {
  const original = await send();
  await stall();
  expect(await choose()).toMatchObject({ ok: true });
  expect(interrupt).toHaveBeenCalledOnce();
  expect(sent).toHaveLength(1);
  end();
  await vi.waitFor(() => {
    expect(sent).toHaveLength(2);
  });
  const records = await texts();
  expect(records).toHaveLength(2);
  const resent = required(records[1]);
  expect(resent).toMatchObject({
    from: original.from,
    to: original.to,
    body: original.body,
    resendOf: original.id,
  });
  // A resend is no reply to its original: what reads replies never takes it for one.
  expect(resent.replyTo).toBeUndefined();
  expect(resent.id).not.toBe(original.id);
  const messages = await core.engines.messagesOf(CANVAS);
  expect(messages.originOf(resent.id)).toBe('resend');
  expect(messages.get(original.id)).toMatchObject({ state: 'replied' });
  const notice = messages.all().filter((m) => m.kind === 'notice' && m.body.includes('resent'));
  expect(notice).toHaveLength(1);
  expect(notice[0]).toMatchObject({
    replyTo: original.id,
    to: original.from,
    body: expect.stringContaining(resent.id) as string,
  });
  expect(notice[0]?.body).toContain('the user');
  host.emit({ type: 'text', id: 'new-reply', text: 'New reply' });
  end('completed');
  await vi.waitFor(() => {
    expect(messages.all()).toContainEqual(
      expect.objectContaining({ replyTo: resent.id, to: original.from, body: 'New reply' }),
    );
  });
  expect(messages.all()).toContainEqual(
    expect.objectContaining({
      replyTo: original.id,
      turn: { status: 'cancelled', reason: 'interrupted' },
    }),
  );
});

it('a repeated choice neither interrupts twice nor resends twice', async () => {
  await send();
  await stall();
  const args = { to: 'stalled/a', answer: { choice: 'resend' }, request: crypto.randomUUID() };
  const first = await call('reply', args);
  expect(await call('reply', args)).toEqual(first);
  await choose();
  expect(interrupt).toHaveBeenCalledOnce();
  end();
  await vi.waitFor(() => {
    expect(sent).toHaveLength(2);
  });
  await choose();
  expect(await call('reply', args)).toEqual(first);
  expect(await texts()).toHaveLength(2);
});

it('keeps the resent message waiting on a pause until it is released', async () => {
  await send();
  await stall();
  await call('run.pause', { target: { agent: 'a' } });
  await choose();
  end();
  await vi.waitFor(async () => {
    expect(await texts()).toHaveLength(2);
  });
  expect((await texts())[1]).toMatchObject({ state: 'pending' });
  expect(sent).toHaveLength(1);
  await call('run.unpause', { target: { agent: 'a' } });
  await vi.waitFor(() => {
    expect(sent).toHaveLength(2);
  });
});

it('does not resend a message withdrawn while the interrupt awaits its end', async () => {
  const original = await send();
  await stall();
  await choose();
  const withdrawal = call('withdraw', { id: original.id }, CALLERS['outside-write']);
  end();
  await withdrawal;
  expect(await texts()).toHaveLength(1);
});

it('does not resend a turn that completed before its interrupt took effect', async () => {
  await send();
  await stall();
  await choose();
  end('completed');
  await vi.waitFor(async () => {
    expect((await texts())[0]?.state).toBe('replied');
  });
  expect(await texts()).toHaveLength(1);
});

it('resends a manual submission with a new id and preserves the cancelled original', async () => {
  const engine = await core.engines.open(CANVAS);
  engine.sessions.send('a', 'codex', 'Manual work', undefined, [
    { mediaType: 'image/png', data: 'aGk=' },
  ]);
  await vi.waitFor(() => {
    expect(sent).toHaveLength(1);
  });
  const original = required(sent[0]);
  await stall();
  await choose();
  end();
  await vi.waitFor(() => {
    expect(sent).toHaveLength(2);
  });
  expect(sent[1]).toMatchObject({ text: original.text, images: original.images });
  expect(sent[1]?.id).not.toBe(original.id);
  expect(engine.sessions.of('a').submissions).toContainEqual(
    expect.objectContaining({ id: original.id, status: 'cancelled' }),
  );
  expect(engine.sessions.of('a').submissions).toContainEqual(
    expect.objectContaining({ id: sent[1]?.id, status: 'running' }),
  );
});

it('resends a long manual submission whole, though its message holds it cut', async () => {
  const engine = await core.engines.open(CANVAS);
  const text = 'é'.repeat(MAX_MESSAGE_BYTES);
  engine.sessions.send('a', 'codex', text);
  await vi.waitFor(() => {
    expect(sent).toHaveLength(1);
  });
  // Journaled, it is your message (run-journal.ts).
  await vi.waitFor(async () => {
    expect(await texts()).toHaveLength(1);
  });
  await stall();
  await choose();
  end();
  await vi.waitFor(() => {
    expect(sent).toHaveLength(2);
  });
  expect(sent[1]?.text).toBe(text);
});

it('retries a run task as its own new attempt, whose reply advances the queue', async () => {
  const engine = await core.engines.open(CANVAS);
  engine.run.start();
  await vi.waitFor(() => {
    expect(sent).toHaveLength(1);
  });
  const first = engine.run.snapshot().agents.a?.attempts?.task?.[0];
  await stall();
  await choose();
  end();
  await vi.waitFor(() => {
    expect(sent).toHaveLength(2);
  });
  const attempts = engine.run.snapshot().agents.a?.attempts?.task;
  expect(attempts).toMatchObject([
    { id: first?.id, status: 'cancelled' },
    { status: 'running', retryOf: first?.id },
  ]);
  // Its retry belongs to the run: each attempt its own message, never a detached manual send.
  const store = await core.engines.messagesOf(CANVAS);
  const rows = await texts();
  expect(rows.map((m) => store.originOf(m.id))).toEqual(['run', 'run']);
  expect(rows.map((m) => m.task?.attempt)).toEqual(attempts?.map(({ id }) => id));
  expect(rows.map((m) => m.id)).toEqual(attempts?.map(({ messageId }) => messageId));
  end('completed');
  await vi.waitFor(() => {
    expect(engine.run.snapshot().agents.a).toMatchObject({
      status: 'done',
      outcomes: { task: 'succeeded' },
    });
  });
});

it('reserves a run’s retry once, in the core alone: no retry-task event reaches its engine or a window', async () => {
  const engine = await core.engines.open(CANVAS);
  // The window shows the canvas the core runs: it hears the canvas's session events.
  await core.channels.call(7, 'run:get', []);
  const events: SessionEvent[] = [];
  const off = core.channels.listen(7, (name, args) => {
    if (name === 'session:event') events.push((args as [string, ConnectionId, SessionEvent])[2]);
  });
  const retried = vi.spyOn(core.engines, 'retryAttempt');
  try {
    engine.run.start();
    await vi.waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    const first = required(engine.run.snapshot().agents.a?.attempts?.task?.[0]);
    await stall();
    expect(await choose()).toMatchObject({ ok: true });
    // Chosen again: there is no stalled turn to answer any more, and nothing more is reserved.
    expect(await choose()).toMatchObject({ ok: false });
    expect(interrupt).toHaveBeenCalledOnce();
    end();
    await vi.waitFor(() => {
      expect(sent).toHaveLength(2);
    });
    expect(retried.mock.calls).toEqual([[CANVAS, { agent: 'a', item: 'task', attempt: first.id }]]);
    expect(retried.mock.results).toEqual([{ type: 'return', value: true }]);
    // The retry's own turn is cancelled too: nothing reserved it, so nothing retries it.
    end();
    await vi.waitFor(() => {
      expect(engine.run.snapshot().agents.a?.problem?.kind).toBe('cancelled');
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(sent).toHaveLength(2);
    expect(engine.run.snapshot().agents.a?.attempts?.task).toHaveLength(2);
    expect(events.filter((event) => event.type === 'retry-task')).toEqual([]);
  } finally {
    off();
  }
});

it('retries only an attempt its owner holds cancelled, once', async () => {
  const engine = await core.engines.open(CANVAS);
  engine.run.start();
  await vi.waitFor(() => {
    expect(sent).toHaveLength(1);
  });
  const first = required(engine.run.snapshot().agents.a?.attempts?.task?.[0]);
  const attempt = { agent: 'a', item: 'task', attempt: first.id };
  // Running still: no retry of it.
  expect(core.engines.retryAttempt(CANVAS, attempt)).toBe(false);
  expect(core.engines.retryAttempt(CANVAS, { ...attempt, attempt: 'another' })).toBe(false);
  end();
  await vi.waitFor(() => {
    expect(engine.run.snapshot().agents.a?.problem?.kind).toBe('cancelled');
  });
  expect(core.engines.retryAttempt(CANVAS, attempt)).toBe(true);
  await vi.waitFor(() => {
    expect(sent).toHaveLength(2);
  });
  // Retried, it is no longer the held attempt.
  expect(core.engines.retryAttempt(CANVAS, attempt)).toBe(false);
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(sent).toHaveLength(2);
  // A canvas the core doesn't run has no attempts to retry.
  await core.engines.closeCanvas(CANVAS);
  expect(core.engines.retryAttempt(CANVAS, attempt)).toBe(false);
});

it('a Kill after choosing resend cancels the reserved run retry', async () => {
  const engine = await core.engines.open(CANVAS);
  engine.run.start();
  await vi.waitFor(() => {
    expect(sent).toHaveLength(1);
  });
  await stall();
  expect(await choose()).toMatchObject({ ok: true });
  engine.run.killAgent('a');
  end();
  await vi.waitFor(() => {
    expect(engine.run.snapshot().agents.a?.problem?.kind).toBe('cancelled');
  });
  controlTimers();
  await call('run.unpause', { target: { agent: 'a' } });
  // Unpaused, the Kill's cancelled attempt waits for you; no reserved retry is left to take it.
  await vi.waitFor(async () => {
    expect(await needIds()).toContain(
      `hold/a/${holdGeneration(engine.run.snapshot().agents.a)}/task`,
    );
  });
  await settled();
  expect(sent).toHaveLength(1);
  expect(engine.run.snapshot().agents.a).toMatchObject({ problem: { kind: 'cancelled' } });
  expect(engine.run.snapshot().agents.a?.attempts?.task).toHaveLength(1);
});

it.each(['party', 'manual', 'run'] as const)(
  'an interrupted %s resend waits for a newly unasking mode',
  async (origin) => {
    const engine = await core.engines.open(CANVAS);
    if (origin === 'party') await send();
    else if (origin === 'manual') engine.sessions.send('a', 'codex', 'Manual work');
    else engine.run.start();
    await vi.waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    await stall();
    host.emit({ type: 'mode', mode: 'full-access' });
    // Activity would clear the Need, so make this turn silent in its new mode again.
    await stall();
    await choose();
    expect(interrupt).toHaveBeenCalledOnce();
    controlTimers();
    end();
    await heldResend(origin, 'never asks before it acts');
    host.emit({ type: 'mode', mode: 'auto' });
    await vi.waitFor(() => {
      expect(sent).toHaveLength(2);
    });
  },
);

it('a run retry stays held on a pause, then uses Retry when unpaused', async () => {
  const engine = await core.engines.open(CANVAS);
  engine.run.start();
  await vi.waitFor(() => {
    expect(sent).toHaveLength(1);
  });
  await stall();
  await call('run.pause', { target: { agent: 'a' } });
  await choose();
  end();
  await vi.waitFor(() => {
    expect(engine.run.snapshot().agents.a?.problem?.kind).toBe('cancelled');
  });
  expect(sent).toHaveLength(1);
  await call('run.unpause', { target: { agent: 'a' } });
  await vi.waitFor(() => {
    expect(sent).toHaveLength(2);
  });
});

async function windowTurn(queue = false): Promise<void> {
  await core.engines.closeCanvas(CANVAS);
  await core.channels.call(7, 'session:start', [
    'a',
    { connection: 'codex.app-server', mode: null, model: null },
  ]);
  await core.channels.call(7, 'session:send', [
    'a',
    {
      id: 'native-entry',
      text: 'From a window',
      ...(queue ? { origin: 'queue', task: { agent: 'a', item: 'task', attempt: 'attempt' } } : {}),
    },
  ]);
  await vi.waitFor(() => {
    expect(sent).toHaveLength(1);
  });
  await stall();
}

async function cancelWindowTurn(): Promise<void> {
  const ended = new Promise<void>((resolve) => {
    const off = core.channels.listen(7, (name, args) => {
      if (name === 'session:event' && args[2]?.type === 'end') {
        off();
        resolve();
      }
    });
  });
  expect(await choose()).toMatchObject({ ok: true });
  end();
  await ended;
  // The cancelled-end continuation was queued before the window received the end.
  // Observe its call to open even if opening itself is still awaiting disk I/O.
  await new Promise<void>((resolve) => setImmediate(resolve));
  await core.flush();
}

it('never opens a second run to resend a window-owned manual message', async () => {
  await windowTurn();
  const open = vi.spyOn(core.engines, 'open');
  await cancelWindowTurn();
  expect(open).not.toHaveBeenCalled();
  expect(core.engines.opened()).toEqual([]);
});

it('hands the manual resend back to the window’s engine, including its images and submission link', async () => {
  const current = required(core.engines.canvas(CANVAS));
  const nodes = current.document.nodes;
  const checkpoint = current.engine.checkpoint();
  await core.engines.closeCanvas(CANVAS);
  const open = vi.spyOn(core.engines, 'open');
  const fake = fakeBackend();
  fake.backend.start.mockImplementation(async (agent, options) => {
    await core.channels.call(7, 'session:start', [agent, options]);
    return null;
  });
  fake.backend.send.mockImplementation(async (agent, message) => {
    await core.channels.call(7, 'session:send', [agent, message]);
    return null;
  });
  const off = core.channels.listen(7, (name, args) => {
    if (name === 'session:event') {
      const [agent, connection, event] = args as [string, ConnectionId, SessionEvent];
      fake.emit(agent, connection, event);
    }
  });
  const owner = new Engine({
    catalog: TEST_ENGINE,
    backend: fake.backend,
    now: Date.now,
    later: (run, ms) => {
      const timer = setTimeout(run, ms);
      return () => {
        clearTimeout(timer);
      };
    },
    connect: () => undefined,
  });
  try {
    owner.update(nodes);
    owner.restore(checkpoint);
    const images = [{ mediaType: 'image/png' as const, data: 'AQ==' }];
    owner.sessions.send('a', 'codex', 'From its owner', undefined, images);
    await vi.waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    const original = required(sent[0]);
    await stall();
    await cancelWindowTurn();
    await vi.waitFor(() => {
      expect(sent).toHaveLength(2);
    });
    expect(sent[1]).toMatchObject({ text: original.text, images });
    expect(owner.sessions.of('a').submissions).toMatchObject([
      { id: original.id, status: 'cancelled' },
      { id: sent[1]?.id, status: 'running', retryOf: original.id },
    ]);
    expect(open).not.toHaveBeenCalled();
    expect(core.engines.opened()).toEqual([]);
    const context = (await core.channels.call(7, 'run:get', [])) as RunRestore;
    const saved = { version: 2 as const, ...owner.checkpoint(), updatedAt: Date.now() };
    await core.channels.call(7, 'run:save', [context.token, saved]);
    await core.flush();
    await core.close();
    expectJournaled(saved);
  } finally {
    off();
    owner.reset();
  }
});

it('keeps the renderer’s checkpoint after manual resend, flush and close', async () => {
  await windowTurn();
  await cancelWindowTurn();
  const restored = (await core.channels.call(7, 'run:get', [])) as RunRestore;
  const checkpoint = {
    ...required(restored.checkpoint ?? undefined),
    messages: JSON.stringify({
      version: 1,
      agents: [
        {
          id: 'a',
          submissions: [
            {
              id: 'later-message',
              text: 'Later work finished in the window',
              status: 'completed',
              result: { status: 'completed', reason: 'completed' },
            },
          ],
        },
      ],
    }),
    updatedAt: Date.now(),
  };
  await core.channels.call(7, 'run:save', [restored.token, checkpoint]);
  await core.flush();
  await core.close();
  expectJournaled(checkpoint);
});

it('still closes window-owned sessions when the window leaves after manual resend', async () => {
  await windowTurn();
  await cancelWindowTurn();
  const close = vi.spyOn(SessionManager.prototype, 'closeCanvas');
  core.channels.gone(7, true);
  await vi.waitFor(() => {
    expect(close).toHaveBeenCalledWith(CANVAS);
  });
});

it('leaves a window-owned queue retry with its owner instead of opening a second run', async () => {
  await windowTurn(true);
  const open = vi.spyOn(core.engines, 'open');
  await cancelWindowTurn();
  expect(open).not.toHaveBeenCalled();
  expect(core.engines.opened()).toEqual([]);
});

it('resends an agent party’s message back to that party under its new id', async () => {
  const original = await send({ kind: 'agent', canvas: CANVAS, agent: 'b', session: 'peer' });
  await stall();
  await choose();
  end();
  await vi.waitFor(() => {
    expect(sent).toHaveLength(2);
  });
  const resent = required((await texts())[1]);
  expect(resent).toMatchObject({ from: 'agent:b', resendOf: original.id });
  expect(resent.replyTo).toBeUndefined();
  host.emit({ type: 'text', id: 'new-answer', text: 'New answer' });
  end('completed');
  const messages = await core.engines.messagesOf(CANVAS);
  await vi.waitFor(() => {
    expect(messages.all()).toContainEqual(
      expect.objectContaining({ replyTo: resent.id, to: 'agent:b', body: 'New answer' }),
    );
  });
});

it('keeps the new pending id, link, sender notice and holds across a restart', async () => {
  const original = await send();
  await stall();
  await call('run.pause', { target: { agent: 'a' } });
  await choose();
  end();
  await vi.waitFor(async () => {
    expect(await texts()).toHaveLength(2);
  });
  const resent = required((await texts())[1]);
  await core.close();
  core = await createCore(config, NO_DESKTOP);
  await core.engines.open(CANVAS);
  expect((await texts())[1]).toMatchObject({
    id: resent.id,
    state: 'pending',
    resendOf: original.id,
  });
  expect((await core.engines.messagesOf(CANVAS)).originOf(resent.id)).toBe('resend');
  await choose();
  expect(await texts()).toHaveLength(2);
  await call('run.unpause', { target: { agent: 'a' } });
  await vi.waitFor(() => {
    expect(sent).toHaveLength(2);
  });
  expect(
    (await core.engines.messagesOf(CANVAS))
      .all()
      .filter((m) => m.kind === 'notice' && m.body.includes('resent')),
  ).toHaveLength(1);
});

it('frees its canvas once an Interrupt is sent, though the CLI never answers it', async () => {
  await send();
  await stall();
  // The CLI's answer to turn/interrupt never comes while the test runs.
  const answer = Promise.withResolvers<undefined>();
  interrupt.mockReturnValueOnce(answer.promise);
  try {
    const replying = settles(call('reply', { to: 'stalled/a', answer: { choice: 'interrupt' } }));
    const moving = settles(
      call('canvas.move', { moves: [{ node: 'a', position: { x: 40, y: 80 } }] }),
    );
    await vi.waitFor(() => {
      expect({ replying: replying.done, moving: moving.done }).toEqual({
        replying: true,
        moving: true,
      });
    });
    expect(await replying.promise).toMatchObject({ ok: true });
    expect(await moving.promise).toMatchObject({ ok: true });
    expect(interrupt).toHaveBeenCalledOnce();
  } finally {
    answer.resolve(undefined);
  }
});

it('gives the Need back when the CLI hasn’t answered its Interrupt in time, with no resend armed', async () => {
  await send();
  await stall();
  interrupt.mockReturnValueOnce(new Promise<void>(() => undefined));
  controlTimers();
  expect(await choose()).toMatchObject({ ok: true });
  expect(await needIds()).not.toContain('stalled/a');
  await vi.advanceTimersByTimeAsync(STALLED_INTERRUPT_MS);
  await vi.waitFor(async () => {
    expect(await needIds()).toContain('stalled/a');
  });
  // Its turn ends after all: what the unanswered interrupt reserved is never resent.
  end();
  await settled();
  expect(sent).toHaveLength(1);
  expect(await texts()).toHaveLength(1);
});

it('a refused interrupt gives the Need back, answerable, with no retry armed', async () => {
  await send();
  await stall();
  interrupt.mockRejectedValueOnce(new Error('interrupt failed'));
  // The reply returns once the interrupt is sent; the CLI's refusal gives the Need back.
  expect(await choose()).toMatchObject({ ok: true });
  await vi.waitFor(async () => {
    expect(await needIds()).toContain('stalled/a');
  });
  expect(await choose()).toMatchObject({ ok: true });
  expect(interrupt).toHaveBeenCalledTimes(2);
  end();
  await vi.waitFor(() => {
    expect(sent).toHaveLength(2);
  });
  expect(await texts()).toHaveLength(2);
});

it.each(['party', 'manual', 'run'] as const)(
  'a %s resend waits on usage, without changing the original result',
  async (origin) => {
    const engine = await core.engines.open(CANVAS);
    if (origin === 'party') await send();
    else if (origin === 'manual') engine.sessions.send('a', 'codex', 'Manual work');
    else engine.run.start();
    await vi.waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    await stall();
    await core.call(
      'usage.setRule',
      { backend: 'codex', rule: { window: 'fiveHour', percent: 50, action: 'waitForReset' } },
      CALLERS.you,
    );
    await core.call(
      'usage.simulate',
      {
        backend: 'codex',
        windows: { fiveHour: { usedPercent: 80, resetsAt: Date.now() + 60_000 } },
      },
      CALLERS.you,
    );
    await choose();
    controlTimers();
    end();
    await heldResend(origin, 'waits until it resets');
    await core.call(
      'usage.simulate',
      {
        backend: 'codex',
        windows: { fiveHour: { usedPercent: 10, resetsAt: Date.now() + 60_000 } },
      },
      CALLERS.you,
    );
    await vi.waitFor(() => {
      expect(sent).toHaveLength(2);
    });
  },
);

it('a run retry waits on a backend’s hard limit and follows its early release', async () => {
  const engine = await core.engines.open(CANVAS);
  engine.run.start();
  await vi.waitFor(() => {
    expect(sent).toHaveLength(1);
  });
  await stall();
  await call('message', { to: 'b', body: 'Read usage' });
  const store = await core.engines.messagesOf(CANVAS);
  await vi.waitFor(() => {
    expect(store.all().find((m) => m.to === 'agent:b')?.state).toBe('delivered');
    expect(hosts.has('b')).toBe(true);
  });
  const native = required(required(store.all().find((m) => m.to === 'agent:b')).delivery).as;
  required(hosts.get('b')).emit({
    type: 'end',
    messages: [native],
    seconds: 1,
    result: { status: 'failed', reason: 'usage-limit', resetsAt: Date.now() + 60_000 },
  });
  await vi.waitFor(async () => {
    expect(await core.call('needs', { canvas: CANVAS }, CALLERS.you)).toMatchObject({
      ok: true,
      value: {
        items: expect.arrayContaining([expect.objectContaining({ id: 'limited/a' })]) as unknown,
      },
    });
  });
  await choose();
  end();
  await vi.waitFor(() => {
    expect(engine.run.snapshot().agents.a?.problem?.kind).toBe('cancelled');
  });
  expect(sent).toHaveLength(1);
  await core.call(
    'usage.simulate',
    { backend: 'codex', windows: { fiveHour: { usedPercent: 10, resetsAt: Date.now() + 60_000 } } },
    CALLERS.you,
  );
  await vi.waitFor(() => {
    expect(sent).toHaveLength(2);
  });
});

it('a pending image resend becomes unresolved after restart, never a text-only turn', async () => {
  const engine = await core.engines.open(CANVAS);
  engine.sessions.send('a', 'codex', 'Look at this', undefined, [
    { mediaType: 'image/png', data: 'aGk=' },
  ]);
  await vi.waitFor(() => {
    expect(sent).toHaveLength(1);
  });
  await stall();
  await call('run.pause', { target: { agent: 'a' } });
  await choose();
  end();
  await vi.waitFor(async () => {
    expect((await texts()).filter((m) => m.state === 'pending')).toHaveLength(1);
  });
  const pending = required((await texts()).find((m) => m.state === 'pending'));
  await core.close();
  core = await createCore(config, NO_DESKTOP);
  await core.engines.open(CANVAS);
  await call('run.unpause', { target: { agent: 'a' } });
  await vi.waitFor(async () => {
    expect((await texts()).find((m) => m.id === pending.id)?.state).toBe('unresolved');
  });
  expect(sent).toHaveLength(1);
  expect((await core.engines.messagesOf(CANVAS)).all()).toContainEqual(
    expect.objectContaining({
      replyTo: pending.id,
      kind: 'notice',
      body: expect.stringContaining('images were not retained') as string,
    }),
  );
});

it('keeps live images when the resent manual turn itself stalls again', async () => {
  const engine = await core.engines.open(CANVAS);
  const images = [{ mediaType: 'image/png' as const, data: 'aGk=' }];
  engine.sessions.send('a', 'codex', 'Look', undefined, images);
  await vi.waitFor(() => {
    expect(sent).toHaveLength(1);
  });
  await stall();
  await choose();
  end();
  await vi.waitFor(() => {
    expect(sent).toHaveLength(2);
  });
  await stall();
  await choose();
  end();
  await vi.waitFor(() => {
    expect(sent).toHaveLength(3);
  });
  expect(sent[2]?.images).toEqual(images);
});
