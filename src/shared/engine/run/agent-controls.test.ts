import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentNode } from '../../model/canvas';
import type { QueueItem, QueueMessage, QueueStep } from '../../model/queue';
import { expectRestorable, liveRun } from './test-restore';
import type { RunIO, TurnEnd } from './runner';
import { TEST_ENGINE } from '../test-engine';

afterEach(expectRestorable);

/** The run's catalog, as the app gives it. */
const engine = TEST_ENGINE;

const node = (id: string, queue: QueueItem[]): AgentNode => ({
  id,
  type: 'agent',
  position: { x: 0, y: 0 },
  data: { label: id, queue, connection: 'claude-code.sdk' },
});
const task = (id: string): QueueStep => ({ id, action: 'Read' });
const message = (id: string): QueueMessage => ({ id, message: id });

function setup(nodes: AgentNode[], extra: Partial<RunIO> = {}) {
  const sent: {
    agent: string;
    text: string;
    done?: (turn: TurnEnd) => void;
    withdrawn: boolean;
  }[] = [];
  const events: string[] = [];
  const timers = new Set<() => void>();
  const store = liveRun(engine, {
    send: (to, text, done) => {
      const entry = { agent: to.id, text, done, withdrawn: false };
      sent.push(entry);
      return () => {
        events.push(`withdraw:${to.id}`);
        entry.withdrawn = true;
      };
    },
    hold: (id, held) => {
      events.push(`hold:${id}:${String(held)}`);
    },
    tell: () => undefined,
    connect: () => undefined,
    later: (callback) => {
      timers.add(callback);
      return () => {
        timers.delete(callback);
      };
    },
    now: () => 1234,
    ...extra,
  });
  store.update(nodes);
  return {
    store,
    sent,
    events,
    pendingTimers: () => timers.size,
    texts: () => sent.map(({ agent, text }) => [agent, text]),
    reply: (agent: string, reply = 'SUCCEEDED') => {
      const entry = sent.find((entry) => entry.agent === agent && entry.done);
      if (!entry?.done) throw new Error(`No turn for ${agent}`);
      const done = entry.done;
      delete entry.done;
      done({ failed: false, reply });
    },
    tick: () => {
      const due = [...timers];
      timers.clear();
      for (const timer of due) timer();
    },
  };
}

describe('per-agent run controls', () => {
  it('keeps each party’s pause apart: a party releases its own, you release any', () => {
    const { store, texts } = setup([node('a', [message('one')]), node('b', [message('two')])]);
    store.pauseAgent('a', 'outside:orchestrator');
    store.pauseAgent('a');
    expect(store.pausedBy({ agent: 'a' })).toEqual(['outside:orchestrator', 'you']);
    store.resumeAgent('a', 'outside:orchestrator');
    expect(store.pausedBy({ agent: 'a' })).toEqual(['you']);
    expect(store.snapshot().agents.a?.paused).toBe(true);
    store.pauseAgent('b', 'outside:orchestrator');
    store.start();
    expect(texts()).toEqual([]);
    // Yours releases every party's.
    store.resumeAgent('b');
    store.resumeAgent('a');
    expect(store.pausedBy({ agent: 'a' })).toEqual([]);
    expect(texts()).toEqual([
      ['b', 'two'],
      ['a', 'one'],
    ]);
  });

  it('accepts a native correction of a killed Message while keeping its next task paused', () => {
    const { store, sent } = setup([node('a', [message('one'), message('next')])]);
    store.start();
    store.killAgent('a');
    expect(store.observeSubmission('a', 'manual', 'Correct the same request')).toEqual({
      agent: 'a',
      item: 'one',
    });
    store.observeEnd('a', 'manual', 'Corrected.', { status: 'completed', reason: 'completed' });
    expect(store.snapshot().agents.a).toMatchObject({
      paused: true,
      outcomes: { one: 'succeeded' },
    });
    expect(store.snapshot().agents.a?.attempts?.one?.map(({ status }) => status)).toEqual([
      'cancelled',
      'succeeded',
    ]);
    expect(store.snapshot().agents.a?.problem).toBeUndefined();
    expect(sent).toHaveLength(1);
    store.resumeAgent('a');
    expect(sent.at(-1)?.text).toBe('next');
  });

  it('withdraws only the killed agent’s native turn and lets an unrelated callback finish', () => {
    const { store, sent, reply, pendingTimers } = setup([
      node('a', [task('one')]),
      node('b', [task('other')]),
    ]);
    store.start();
    expect(pendingTimers()).toBe(0);
    store.killAgent('a');
    expect(sent.map(({ withdrawn }) => withdrawn)).toEqual([true, false]);
    reply('b');
    expect(store.snapshot().agents.a?.problem?.kind).toBe('cancelled');
    expect(store.snapshot().agents.b?.outcomes.other).toBe('succeeded');
  });

  it('ignores stale OK and delay controls while their agent is paused', () => {
    const approval = setup([node('a', [{ id: 'ok', approve: 'the release' }, message('next')])]);
    approval.store.start();
    approval.store.pauseAgent('a');
    approval.store.decide('a', 'ok', { choice: 'approve' });
    approval.store.decide('a', 'ok', { reply: 'Change it' });
    expect(approval.sent).toHaveLength(0);
    approval.store.resumeAgent('a');
    expect(approval.store.snapshot().agents.a?.status).toBe('asking');
    const delay = setup([node('a', [{ id: 'wait', delay: { seconds: 10 } }, message('next')])]);
    delay.store.start();
    delay.store.pauseAgent('a');
    delay.store.goOn('a', 'wait');
    expect(delay.sent).toHaveLength(0);
    expect(delay.store.snapshot().agents.a?.outcomes.wait).toBeUndefined();
    delay.store.resumeAgent('a');
    expect(delay.sent).toHaveLength(0);
    delay.store.goOn('a', 'wait');
    expect(delay.sent.at(-1)?.text).toBe('next');
  });

  it('records a manual correction while agent-paused and releases only dependents with a known result', () => {
    const { store, sent, reply } = setup([
      node('a', [task('one'), message('next')]),
      node('b', [{ id: 'wait', waitFor: [{ agent: 'a', item: 'one' }] }, message('dependent')]),
    ]);
    store.start();
    reply('a', 'FAILED');
    store.pauseAgent('a');
    expect(store.observeSubmission('a', 'manual', 'Correct the result')).toEqual({
      agent: 'a',
      item: 'one',
    });
    store.observeEnd('a', 'manual', 'SUCCEEDED', { status: 'completed', reason: 'completed' });
    expect(store.snapshot().agents.a).toMatchObject({
      paused: true,
      outcomes: { one: 'succeeded' },
    });
    expect(sent.map(({ text }) => text).slice(1)).toEqual(['dependent']);
    store.resumeAgent('a');
    expect(sent.at(-1)?.text).toBe('next');
  });

  it('resumes an agent flag without resuming the globally paused run', () => {
    const graph = [node('a', [task('one'), message('next')])];
    const first = setup(graph);
    first.store.start();
    first.store.pauseAgent('a');
    const second = setup(graph);
    second.store.restore(first.store.checkpoint());
    second.store.resumeAgent('a');
    expect(second.store.snapshot()).toMatchObject({ running: false, paused: true });
    expect(second.sent).toHaveLength(0);
    second.store.observeSubmission('a', 'manual', 'Correct it');
    second.store.observeEnd('a', 'manual', 'SUCCEEDED', {
      status: 'completed',
      reason: 'completed',
    });
    expect(second.sent).toHaveLength(0);
    second.store.resume();
    expect(second.sent.at(-1)?.text).toBe('next');
  });

  it('releases removed agent holds so a later agent with the same ID gets a fresh hold', () => {
    const graph = [node('a', [message('one')])];
    const { store, events } = setup(graph);
    store.pauseAgent('a');
    store.update([]);
    expect(events.at(-1)).toBe('hold:a:false');
    store.update(graph);
    store.pauseAgent('a');
    expect(events.at(-1)).toBe('hold:a:true');
  });
  it('finishes the paused agent’s current task, while other queues continue and waits for all remain held', () => {
    const { store, sent, reply, texts } = setup([
      node('a', [task('one'), message('two')]),
      node('b', [message('other'), message('more')]),
      node('c', [{ id: 'wait', waitFor: [{ agent: 'a' }] }, message('dependent')]),
    ]);
    store.start();
    store.pauseAgent('a');
    expect(sent.every(({ withdrawn }) => !withdrawn)).toBe(true);
    reply('a');
    expect(store.snapshot().agents.a).toMatchObject({
      paused: true,
      outcomes: { one: 'succeeded' },
    });
    expect(store.snapshot().agents.a?.current).toBeUndefined();
    expect(store.snapshot().agents.c?.status).toBe('waiting');
    reply('b');
    expect(texts().at(-1)).toEqual(['b', 'more']);
    expect(sent.filter(({ agent }) => agent === 'a')).toHaveLength(1);
    store.resumeAgent('a');
    expect(texts().at(-1)).toEqual(['a', 'two']);
    reply('a');
    expect(texts().at(-1)).toEqual(['c', 'dependent']);
  });

  it('keeps an idle agent paused across Run, and clears its hold on reset', () => {
    const { store, sent, events } = setup([node('a', [message('one')])]);
    store.pauseAgent('a');
    expect(store.snapshot().running).toBe(false);
    expect(store.snapshot().agents.a?.paused).toBe(true);
    store.start();
    expect(sent).toHaveLength(0);
    store.resumeAgent('a');
    expect(sent.map(({ text }) => text)).toEqual(['one']);
    store.pauseAgent('a');
    store.reset();
    expect(events.at(-1)).toBe('hold:a:false');
    expect(store.snapshot()).toEqual({ running: false, agents: {} });
  });

  it('kills only its own task and timers, holding before withdrawing and never taking If failed for cancellation', () => {
    const { store, sent, events, reply } = setup([
      node('a', [
        task('one'),
        { id: 'failed', if: { kind: 'failed' }, then: [message('wrong')] },
        message('next'),
      ]),
      node('b', [message('other'), message('more')]),
      node('c', [task('parallel')]),
    ]);
    store.start();
    store.killAgent('a');
    expect(events.slice(0, 2)).toEqual(['hold:a:true', 'withdraw:a']);
    expect(sent.map(({ withdrawn }) => withdrawn)).toEqual([true, false, false]);
    expect(store.snapshot().agents.a).toMatchObject({
      paused: true,
      problem: { kind: 'cancelled' },
      outcomes: {},
    });
    reply('a'); // Its late end is ignored.
    reply('b');
    reply('c');
    expect(store.snapshot().agents.c?.outcomes.parallel).toBe('succeeded');
    expect(sent.at(-1)?.text).toBe('more');
    store.resumeAgent('a');
    expect(sent.some(({ text }) => text === 'wrong')).toBe(false);
    store.decide('a', 'one', { choice: 'continue' });
    expect(store.snapshot().agents.a?.outcomes).toMatchObject({
      one: 'cancelled',
      failed: 'skipped',
    });
    expect(sent.at(-1)?.text).toBe('next');
  });

  it('keeps future handoffs to a paused recipient waiting until that recipient resumes', () => {
    const { store, sent, reply } = setup([
      node('a', [{ id: 'handoff', message: 'Review it', target: 'b' }, message('next')]),
      node('b', []),
      node('c', [message('other')]),
    ]);
    store.pauseAgent('b');
    store.start();
    expect(sent.map(({ text }) => text)).toEqual(['other']);
    expect(store.snapshot().agents.a?.status).toBe('waiting');
    expect(store.snapshot().agents.a?.attempts?.handoff).toBeUndefined();
    store.resumeAgent('b');
    expect(sent.at(-1)).toMatchObject({ agent: 'b', text: 'Review it' });
    reply('b');
    expect(sent.at(-1)).toMatchObject({ agent: 'a', text: 'next' });
  });

  it('kills both owned and incoming work for a recipient, leaving unrelated work alone', () => {
    const { store, sent, events } = setup([
      node('a', [{ id: 'handoff', message: 'Review it', target: 'b' }]),
      node('b', [task('own')]),
      node('c', [message('other')]),
    ]);
    store.start();
    store.killAgent('b');
    expect(events[0]).toBe('hold:b:true');
    expect(sent.map(({ withdrawn }) => withdrawn)).toEqual([true, true, false]);
    expect(store.snapshot().agents.a?.problem).toMatchObject({ kind: 'cancelled', agent: 'b' });
    expect(store.snapshot().agents.b).toMatchObject({
      paused: true,
      problem: { kind: 'cancelled' },
    });
    expect(store.snapshot().agents.c?.status).toBe('running');
  });

  it.each(['pause', 'kill'] as const)(
    'does not dispatch an async checkpointed prompt after %s',
    async (control) => {
      let release: (() => void) | undefined;
      let saved = false;
      const { store, sent } = setup([node('a', [task('one')])], {
        beforeSend: async () => {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          saved = true;
        },
      });
      store.start();
      await Promise.resolve();
      if (control === 'pause') store.pauseAgent('a');
      else store.killAgent('a');
      release?.();
      await vi.waitFor(() => {
        expect(saved).toBe(true);
      });
      expect(sent).toHaveLength(0);
      store.resumeAgent('a');
      await vi.waitFor(() => {
        expect(sent).toHaveLength(control === 'pause' ? 1 : 0);
      });
      if (control === 'kill') expect(store.snapshot().agents.a?.problem?.kind).toBe('cancelled');
    },
  );

  it('rechecks a recipient pause after its durable checkpoint finishes', async () => {
    let release: (() => void) | undefined;
    let saved = false;
    const { store, sent } = setup(
      [node('a', [{ id: 'handoff', message: 'Review it', target: 'b' }]), node('b', [])],
      {
        beforeSend: async () => {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          saved = true;
        },
      },
    );
    store.start();
    await Promise.resolve();
    store.pauseAgent('b');
    release?.();
    await vi.waitFor(() => {
      expect(saved).toBe(true);
    });
    expect(sent).toHaveLength(0);
    store.resumeAgent('b');
    await vi.waitFor(() => {
      expect(sent.map(({ text }) => text)).toEqual(['Review it']);
    });
  });

  it('persists a pending finish, restores without replay, and adopts manual recovery while remaining agent-paused', () => {
    const graph = [
      node('a', [task('one'), message('next')]),
      node('b', [{ id: 'wait', waitFor: [{ agent: 'a' }] }, message('dependent')]),
    ];
    const first = setup(graph);
    first.store.start();
    first.store.pauseAgent('a');
    const second = setup(graph);
    second.store.restore(first.store.checkpoint());
    expect(second.store.snapshot().agents.a?.paused).toBe(true);
    expect(second.events).toContain('hold:a:true');
    second.store.resume();
    expect(second.sent).toHaveLength(0);
    expect(second.store.observeSubmission('a', 'manual', 'Inspect the result')).toEqual({
      agent: 'a',
      item: 'one',
    });
    second.store.observeEnd('a', 'manual', 'SUCCEEDED', {
      status: 'completed',
      reason: 'completed',
    });
    expect(second.store.snapshot().agents.a?.outcomes.one).toBe('succeeded');
    expect(second.sent).toHaveLength(0);
    second.store.resumeAgent('a');
    expect(second.sent.map(({ text }) => text)).toEqual(['next']);
  });

  it('lets an active condition query finish while paused without running its branch until Resume', () => {
    const { store, sent, reply } = setup([
      node('a', [
        message('before'),
        { id: 'check', if: { kind: 'freeText', text: 'ready' }, then: [message('branch')] },
      ]),
    ]);
    store.start();
    reply('a', 'Inspected.');
    store.pauseAgent('a');
    reply('a', 'Yes.');
    expect(sent).toHaveLength(2);
    store.resumeAgent('a');
    expect(sent.at(-1)?.text).toBe('branch');
  });

  it('kills an OK feedback turn and retains a cancelled hold instead of advancing it', () => {
    const { store, sent, reply } = setup([
      node('a', [{ id: 'ok', approve: 'the release' }, message('next')]),
    ]);
    store.start();
    store.decide('a', 'ok', { reply: 'Correct the release note' });
    store.killAgent('a');
    expect(sent[0]?.withdrawn).toBe(true);
    reply('a');
    expect(store.snapshot().agents.a).toMatchObject({
      paused: true,
      current: 'ok',
      problem: { kind: 'cancelled' },
    });
    expect(sent).toHaveLength(1);
  });

  it('rejects a non-boolean agent pause flag without changing the run', () => {
    const { store } = setup([node('a', [message('one')])]);
    store.start();
    const saved = JSON.parse(store.checkpoint()) as { run: { agents: { a: { paused: unknown } } } };
    saved.run.agents.a.paused = 'yes';
    const before = store.checkpoint();
    expect(() => {
      store.restore(JSON.stringify(saved));
    }).toThrow('invalid or unsupported');
    expect(store.checkpoint()).toBe(before);
  });
});
