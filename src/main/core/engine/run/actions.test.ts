import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Catalog } from '../../../../shared/adapter';
import type { AgentNode } from '../../../../shared/model/canvas';
import type { CanvasId } from '../../../../shared/canvas';
import { engineCatalog } from '../../../../shared/model/catalog';
import { needs, withoutChoices } from '../../../../shared/model/needs-selectors';
import type { QueueItem, QueueStep } from '../../../../shared/model/queue';
import { heldAsks } from '../../../../shared/model/run-words';
import { MADE_UP } from '../../../../shared/test-made-up';
import { SessionStore } from '../delivery/mailbox';
import { fakeBackend } from '../test-backend';
import type { RunIO, TurnEnd } from './runner';
import { expectRestorable, liveRun } from './test-restore';

afterEach(expectRestorable);

const zed = MADE_UP.adapters[0];
if (!zed) throw new Error('The made-up catalog needs its Zed adapter');
const catalog: Catalog = {
  ...MADE_UP,
  adapters: [
    { ...zed, actions: [...zed.actions, { name: '/zed-only', description: '' }] },
    {
      ...zed,
      id: 'quill',
      name: 'Quill',
      actions: [{ name: 'execute', description: '', job: 'shell' }],
      connections: zed.connections.map((one) => ({ ...one, id: one.id.replace('zed', 'quill') })),
    },
  ],
};
const engine = engineCatalog(catalog, 'zed');
const step: QueueStep = { id: 'step', action: '/zed-only', instruction: 'Inspect the result' };
const node = (queue: QueueItem[], adapter = 'quill', id = 'a'): AgentNode => ({
  id,
  type: 'agent',
  position: { x: 0, y: 0 },
  data: { label: id, adapter, queue },
});

function setup(nodes: AgentNode[], overrides: Partial<RunIO> = {}) {
  const sent: { to: string; text: string; done: (turn: TurnEnd) => void }[] = [];
  const record = vi.fn(({ text }: { text: string }) => ({ id: crypto.randomUUID(), text }));
  const settle = vi.fn();
  const run = liveRun(engine, {
    send: (to, text, done) => {
      sent.push({ to: to.id, text, done });
      return () => undefined;
    },
    tell: () => undefined,
    later: () => () => undefined,
    now: () => 1,
    mailbox: { record, settle },
    ...overrides,
  });
  run.update(nodes);
  return { run, sent, record, settle };
}

/** The same runner/session seam used by Engine; each run remains checked by expectRestorable. */
const sessionSend =
  (sessions: SessionStore): RunIO['send'] =>
  (to, text, done, images, refused, origin, displayText, task, id, resolvedStep) =>
    sessions.send(
      to.id,
      to.data.adapter ?? engine.defaultAdapter,
      text,
      (failed, reply, result) => {
        done({ failed, reply, result });
      },
      images && [...images],
      refused,
      origin === 'user' ? 'run' : 'queue',
      displayText,
      {
        ...(task ? { task } : {}),
        ...(id ? { id } : {}),
        ...(resolvedStep ? { resolvedStep } : {}),
      },
    );

describe('step action admission', () => {
  it.each(['ordinary', 'If', 'Repeat'] as const)(
    'holds an unknown %s step unsent, with Skip and Stop here in Needs',
    (where) => {
      const queue: QueueItem[] =
        where === 'If'
          ? [{ id: 'if', if: { kind: 'succeeded' }, then: [step] }]
          : where === 'Repeat'
            ? [
                {
                  id: 'repeat',
                  repeat: [step],
                  until: { kind: 'succeeded' },
                  rounds: 2,
                  otherwise: 'ask',
                },
              ]
            : [step];
      // The If follows a completed message so its condition can hold.
      if (where === 'If') queue.unshift({ id: 'before', message: 'Before' });
      const nodes = [node(queue)];
      const { run, sent, record } = setup(nodes);
      run.start();
      if (where === 'If') sent.shift()?.done({ failed: false, reply: '' });
      expect(sent).toEqual([]);
      expect(record).toHaveBeenCalledTimes(where === 'If' ? 1 : 0);
      expect(run.snapshot().agents.a).toMatchObject({
        current: 'step',
        status: 'asking',
        refused: { kind: 'unknown-action', agent: 'a', connection: 'quill.acp' },
      });
      expect(run.snapshot().agents.a?.attempts?.step).toBeUndefined();
      const [ask] = heldAsks(nodes, run.snapshot(), engine);
      expect(ask?.text).toContain('/zed-only');
      expect(ask?.text).toContain('Quill');
      expect(ask?.choices.map(({ key, label }) => [key, label])).toEqual([
        ['skip', 'Skip'],
        ['stop', 'Stop here'],
      ]);
      const [need] = needs({
        canvas: '7f3e2d1c-0b9a-4876-8543-210fedcba987' as CanvasId,
        nodes,
        run: run.snapshot(),
        sessions: {},
        catalog: engine,
      });
      expect(need).toMatchObject({
        by: ['you'],
        answerIn: 'api',
        choices: [{ value: 'skip' }, { value: 'stop' }],
      });
      expect(need && withoutChoices(need).choices).toEqual([]);
      for (const choice of ['retry', 'goOn', 'continue', 'switch'])
        run.decide('a', 'step', { choice });
      run.decide('a', 'step', { reply: 'Try anyway' });
      expect(sent).toEqual([]);
      expect(run.snapshot().agents.a?.refused).toBeDefined();
    },
  );

  it.each(['skip', 'stop'] as const)('answers an unknown step with %s once', (choice) => {
    const nodes = [node([step, { id: 'after', message: 'After' }])];
    const { run, sent } = setup(nodes);
    run.start();
    run.decide('a', 'step', { choice });
    run.decide('a', 'step', { choice });
    expect(run.snapshot().agents.a?.outcomes.step).toBe(choice === 'skip' ? 'skipped' : 'stopped');
    expect(sent.map(({ text }) => text)).toEqual(choice === 'skip' ? ['After'] : []);
    expect(run.snapshot().agents.a?.refused).toBeUndefined();
  });

  it('rechecks edits on the same connection and resolves an equivalent job for this send only', () => {
    const original = node([step]);
    const { run, sent } = setup([original]);
    run.start();
    run.update([{ ...original, data: { ...original.data, label: 'Renamed' } }]);
    expect(sent).toEqual([]);
    const edited = node([{ ...step, action: 'shell' }]);
    run.update([edited]);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain('Use the execute tool');
    expect(sent[0]?.text).not.toContain('Use the shell tool');
    expect(edited.data.queue).toEqual([{ ...step, action: 'shell' }]);
    sent[0]?.done({ failed: false, reply: 'SUCCEEDED' });
    expect(run.snapshot().agents.a?.outcomes.step).toBe('succeeded');
  });

  it('rechecks an unknown action after the agent changes adapter', () => {
    const { run, sent } = setup([node([step])]);
    run.start();
    expect(sent).toEqual([]);
    run.update([node([step], 'zed')]);
    expect(sent.map(({ text }) => text)).toEqual(['/zed-only Inspect the result']);
  });

  it('resolves a retried step against its current adapter, holding it without another send', () => {
    const { run, sent } = setup([node([step], 'zed')]);
    run.start();
    sent[0]?.done({ failed: true, reply: '', result: { status: 'failed', reason: 'error' } });
    run.update([node([step])]);
    run.decide('a', 'step', { choice: 'retry' });
    expect(sent).toHaveLength(1);
    expect(run.snapshot().agents.a?.refused).toMatchObject({ kind: 'unknown-action' });
    expect(run.snapshot().agents.a?.attempts?.step).toHaveLength(1);
  });

  it('resolves a retried equivalent action and keeps its attempt link', () => {
    const shell = { ...step, action: 'shell' };
    const { run, sent } = setup([node([shell], 'zed')]);
    run.start();
    sent[0]?.done({ failed: true, reply: '', result: { status: 'failed', reason: 'error' } });
    const first = run.snapshot().agents.a?.attempts?.step?.[0]?.id;
    run.update([node([shell])]);
    run.decide('a', 'step', { choice: 'retry' });
    expect(sent).toHaveLength(2);
    expect(sent[1]?.text).toContain('Use the execute tool');
    expect(run.snapshot().agents.a?.attempts?.step?.[1]?.retryOf).toBe(first);
  });

  it('resolves a restored in-flight step only after its explicit Retry', () => {
    const first = setup([node([step], 'zed')]);
    first.run.start();
    first.run.pause();
    const second = setup([node([step])]);
    second.run.restore(first.run.checkpoint());
    second.run.resume();
    expect(second.sent).toEqual([]);
    expect(second.run.snapshot().agents.a?.problem?.kind).toBe('uncertain');
    second.run.decide('a', 'step', { choice: 'retry' });
    expect(second.sent).toEqual([]);
    expect(second.run.snapshot().agents.a?.refused).toMatchObject({ kind: 'unknown-action' });
  });

  it('restores the unsent refusal and resolves it against edits made before Resume', () => {
    const first = setup([node([step])]);
    first.run.start();
    first.run.pause();
    const second = setup([node([step])]);
    second.run.restore(first.run.checkpoint());
    expect(second.run.snapshot()).toEqual(first.run.snapshot());
    second.run.update([node([step], 'zed')]);
    expect(second.sent).toEqual([]);
    second.run.resume();
    expect(second.sent.map(({ text }) => text)).toEqual(['/zed-only Inspect the result']);
  });

  it.each(['/zed-only', 'shell'])(
    'holds %s if its resolved adapter changed while its record was being saved',
    async (action) => {
      let release: (() => void) | undefined;
      const beforeSend = () =>
        new Promise<void>((resolve) => {
          release = resolve;
        });
      const task = { ...step, action };
      const { run, sent, settle } = setup([node([task], 'zed')], { beforeSend });
      run.start();
      await Promise.resolve();
      run.update([node([task])]);
      release?.();
      await vi.waitFor(() => {
        expect(run.snapshot().agents.a?.refused).toMatchObject({ kind: 'unknown-action' });
      });
      expect(sent).toEqual([]);
      expect(settle).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ state: 'withdrawn' }),
      );
      run.pause();
      const restored = setup([node([task])]);
      restored.run.restore(run.checkpoint());
      expect(restored.run.snapshot().agents.a?.problem).toBeUndefined();
      restored.run.resume();
      if (action === 'shell') expect(restored.sent[0]?.text).toContain('Use the execute tool');
      else expect(restored.sent).toEqual([]);
    },
  );

  it('resolves the executing agent’s action when a step names another agent’s work', () => {
    const task = { ...step, action: 'shell', target: 'b' };
    const { run, sent } = setup([node([task]), node([], 'zed', 'b')]);
    run.start();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe('a');
    expect(sent[0]?.text).toContain('Use the execute tool');
    expect(sent[0]?.text).toContain('on the work of b (another agent)');
  });

  it('does not interpret a queue message addressed to another adapter as an action', () => {
    const { run, sent } = setup([
      node([{ id: 'message', message: '/zed-only chat', target: 'b' }], 'zed'),
      node([], 'quill', 'b'),
    ]);
    run.start();
    expect(sent).toMatchObject([{ to: 'b', text: '/zed-only chat' }]);
    expect(run.snapshot().agents.a?.refused).toBeUndefined();
  });

  it('holds a resolved step still queued in its session when the recipient changes adapter', async () => {
    const fake = fakeBackend();
    const sessions = new SessionStore(engine, fake.backend);
    sessions.sync([{ id: 'a', connection: 'zed.acp' }]);
    sessions.holdQueue('a', true);
    const { run } = setup([node([step], 'zed')], { send: sessionSend(sessions) });
    try {
      run.start();
      expect(sessions.of('a').queued).toHaveLength(1);
      sessions.sync([{ id: 'a', connection: 'quill.acp' }]);
      run.update([node([step])]);
      sessions.holdQueue('a', false);
      await vi.waitFor(() => {
        expect(run.snapshot().agents.a?.refused).toMatchObject({ kind: 'unknown-action' });
      });
      expect(fake.backend.send).not.toHaveBeenCalled();
      expect(sessions.of('a').queued).toEqual([]);
    } finally {
      run.stop();
      sessions.reset();
    }
  });

  it('takes back the stale step without stranding another queue’s message to its recipient', async () => {
    const fake = fakeBackend();
    const sessions = new SessionStore(engine, fake.backend);
    sessions.sync([{ id: 'a', connection: 'zed.acp' }]);
    sessions.holdQueue('a', true);
    const { run } = setup([node([step], 'zed')], { send: sessionSend(sessions) });
    try {
      run.start();
      sessions.send(
        'a',
        'zed',
        'A message from another queue',
        undefined,
        undefined,
        undefined,
        'queue',
      );
      sessions.sync([{ id: 'a', connection: 'quill.acp' }]);
      run.update([node([step])]);
      sessions.holdQueue('a', false);
      await vi.waitFor(() => {
        expect(fake.backend.send.mock.calls.map(([, message]) => message.text)).toEqual([
          'A message from another queue',
        ]);
      });
      expect(run.snapshot().agents.a?.refused).toMatchObject({ kind: 'unknown-action' });
    } finally {
      run.stop();
      sessions.reset();
    }
  });

  it.each(['quill.acp', 'zed.free'])(
    'checks a step awaiting native startup when switched to %s',
    async (connection) => {
      const fake = fakeBackend();
      let release: (() => void) | undefined;
      fake.backend.start.mockImplementationOnce(
        () =>
          new Promise<null>((resolve) => {
            release = () => {
              resolve(null);
            };
          }),
      );
      const sessions = new SessionStore(engine, fake.backend);
      sessions.sync([{ id: 'a', connection: 'zed.acp' }]);
      const { run } = setup([node([step], 'zed')], { send: sessionSend(sessions) });
      try {
        run.start();
        expect(fake.backend.start).toHaveBeenCalledOnce();
        expect(fake.backend.send).not.toHaveBeenCalled();
        sessions.sync([{ id: 'a', connection }]);
        const current = node([step], connection === 'zed.free' ? 'zed' : 'quill');
        run.update([{ ...current, data: { ...current.data, connection } }]);
        release?.();
        if (connection === 'quill.acp') {
          await vi.waitFor(() => {
            expect(run.snapshot().agents.a?.refused).toMatchObject({ kind: 'unknown-action' });
          });
          expect(fake.backend.send).not.toHaveBeenCalled();
          expect(fake.backend.start).toHaveBeenCalledOnce();
          expect(sessions.of('a').queued).toEqual([]);
        } else {
          await vi.waitFor(() => {
            expect(fake.backend.send).toHaveBeenCalledOnce();
          });
          expect(fake.backend.send.mock.calls[0]?.[1].text).toBe('/zed-only Inspect the result');
          fake.emit('a', connection, {
            type: 'end',
            messages: [fake.sent()],
            seconds: 1,
            result: { status: 'completed', reason: 'completed' },
          });
          expect(run.snapshot().agents.a?.outcomes.step).toBe('succeeded');
        }
      } finally {
        release?.();
        run.stop();
        sessions.reset();
      }
    },
  );
});
