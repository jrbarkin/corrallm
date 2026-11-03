import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import type { HostEvent } from './connector';
import { fakeConnector } from './test-fake';
import { fakeScript } from './fake';
import { PromptEnded, PromptEvent } from '../../shared/model/prompts';
import type { PromptAnswer } from '../../shared/model/prompts';
import type { FakeScript } from './fake';
import { ADAPTERS } from './adapters';

it.each([
  { adapter: 'claude-code', mode: 'manual', effort: undefined },
  { adapter: 'codex', mode: 'auto', effort: 'high' },
])(
  'keeps $adapter’s registered fake defaults, model choices and resumed identity',
  async ({ adapter, mode, effort }) => {
    const fixture = ADAPTERS.find((one) => one.descriptor.id === adapter);
    if (!fixture) throw new Error(`No fake fixture for ${adapter}`);
    const emit = vi.fn();
    const remember = vi.fn();
    const session = await fakeConnector({ adapter }).start(
      {
        agentId: 'a',
        cwd: '/unused',
        env: {},
        model: null,
        mode: null,
        resume: 'kept',
        effort: 'high',
      },
      { emit, remember },
    );
    try {
      const report = emit.mock.calls
        .map(([event]) => event as HostEvent)
        .find((event) => event.type === 'started');
      expect(report).toEqual({
        type: 'started',
        model: 'default',
        mode,
        models: fixture.fakeOptions?.models,
        role: fixture.descriptor.role,
        resume: fixture.descriptor.resume,
        list: fixture.descriptor.list,
        ...(effort === undefined ? {} : { effort }),
      });
      expect(remember).toHaveBeenCalledExactlyOnceWith('kept');
    } finally {
      await session.close();
    }
  },
);

it.each(['claude-code', 'codex'])(
  'keeps %s’s explicit settings and an unreported native default mode',
  async (adapter) => {
    const emit = vi.fn();
    const session = await fakeConnector({ adapter, mode: null, asks: false }).start(
      { agentId: 'a', cwd: '/unused', env: {}, model: 'fast', mode: null, resume: null },
      { emit, remember: vi.fn() },
    );
    try {
      expect(emit).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'started', model: 'fast', mode: null, asks: false }),
      );
      await session.setMode('plan');
      await session.setModel('chosen');
      expect(emit).toHaveBeenCalledWith({ type: 'mode', mode: 'plan' });
      expect(emit).toHaveBeenCalledWith({ type: 'model', model: 'chosen' });
    } finally {
      await session.close();
    }
  },
);

it.each([
  { text: 'Hello', kind: 'approval', answer: { kind: 'choice', value: 'allow' } },
  {
    text: '/question',
    kind: 'question',
    answer: { kind: 'questions', answers: { q1: { picked: ['Yes'] } } },
  },
  { text: '/plan', kind: 'plan', answer: { kind: 'choice', value: 'accept-edits' } },
] satisfies { text: string; kind: string; answer: PromptAnswer }[])(
  'the app fake raises $kind through the owner and accepts its answer once',
  async ({ text, kind, answer }) => {
    const events: HostEvent[] = [];
    const session = await fakeConnector({}).start(
      { agentId: 'a', cwd: '/unused', env: {}, model: null, mode: 'manual', resume: null },
      { emit: (event) => events.push(event), remember: vi.fn() },
    );
    try {
      await session.send({ id: 'message', text });
      await expect.poll(() => events.some((event) => event.type === 'prompt')).toBe(true);
      const raised = PromptEvent.parse(events.find((event) => event.type === 'prompt'));
      expect(raised.prompt.kind).toBe(kind);
      expect(events.some((event) => ['permission', 'question', 'plan'].includes(event.type))).toBe(
        false,
      );
      session.prompts?.answer(raised.key, answer);
      await expect.poll(() => events.some((event) => event.type === 'end')).toBe(true);
      expect(events.filter((event) => event.type === 'end')).toHaveLength(1);
      expect(() => session.prompts?.answer(raised.key, answer)).toThrow();
    } finally {
      await session.close();
    }
  },
);

it('the app fake withdraws its owner occurrence when a waiting turn is interrupted', async () => {
  const events: HostEvent[] = [];
  const session = await fakeConnector({}).start(
    { agentId: 'a', cwd: '/unused', env: {}, model: null, mode: 'manual', resume: null },
    { emit: (event) => events.push(event), remember: vi.fn() },
  );
  try {
    await session.send({ id: 'message', text: '/question' });
    await expect.poll(() => events.some((event) => event.type === 'prompt')).toBe(true);
    const raised = PromptEvent.parse(events.find((event) => event.type === 'prompt'));
    await session.interrupt();
    await expect.poll(() => events.some((event) => event.type === 'end')).toBe(true);
    expect(PromptEnded.parse(events.find((event) => event.type === 'prompt-ended'))).toEqual({
      type: 'prompt-ended',
      key: raised.key,
      reason: 'withdrawn',
    });
    expect(events.some((event) => ['withdrawn'].includes(event.type))).toBe(false);
    expect(() =>
      session.prompts?.answer(raised.key, {
        kind: 'questions',
        answers: { q1: { picked: ['Yes'] } },
      }),
    ).toThrow();
  } finally {
    await session.close();
  }
});

describe('a fake connection that asks a consent (B22a C4, for the app’s e2e)', () => {
  /** The core's consent owner, as settings keep one: kept for good, and its generation. */
  function owner() {
    const kept = { generation: 0, given: false };
    const consent = {
      generation: () => kept.generation,
      given: () => Promise.resolve(kept.given),
      give: vi.fn((at: number) => {
        if (at === kept.generation) kept.given = true;
        return Promise.resolve();
      }),
    };
    /** Taking it back in Settings. */
    const reset = () => {
      kept.given = false;
      kept.generation += 1;
    };
    return { consent, reset };
  }

  async function started(consent?: ReturnType<typeof owner>['consent']) {
    const events: HostEvent[] = [];
    const session = await fakeConnector(
      consent === undefined ? {} : { consent: { key: 'credits', handle: consent } },
    ).start(
      // A mode that never asks to run its command: only the consent asks.
      { agentId: 'a', cwd: '/unused', env: {}, model: null, mode: 'acceptEdits', resume: null },
      { emit: (event) => events.push(event), remember: vi.fn() },
    );
    const consents = () =>
      events.filter(
        (event) =>
          event.type === 'prompt' &&
          event.prompt.kind === 'approval' &&
          event.prompt.subject?.type === 'consent',
      );
    /** Sends `text`, answering its consent question with `answer` if it asks; its turn's end. */
    const turn = async (id: string, text: string, answer?: string) => {
      const before = consents().length;
      await session.send({ id, text });
      if (answer !== undefined) {
        await expect.poll(() => consents().length).toBe(before + 1);
        const raised = PromptEvent.parse(consents().at(-1));
        session.prompts?.answer(raised.key, { kind: 'choice', value: answer });
      }
      await expect
        .poll(() => events.some((event) => event.type === 'end' && event.messages.includes(id)))
        .toBe(true);
    };
    return { events, session, consents, turn };
  }

  it('asks before a /consent turn, no more while it holds, and again once taken back', async () => {
    const { consent, reset } = owner();
    const { session, consents, turn, events } = await started(consent);
    try {
      await turn('m1', '/consent one', 'once');
      expect(PromptEvent.parse(consents()[0]).prompt).toMatchObject({
        subject: { type: 'consent', key: 'credits' },
      });
      await turn('m2', '/consent two');
      await turn('m3', 'Hello');
      expect(consents()).toHaveLength(1);
      reset();
      await turn('m4', '/consent three', 'always');
      expect(consent.give).toHaveBeenCalledExactlyOnceWith(1);
      await turn('m5', '/consent four');
      expect(consents()).toHaveLength(2);
      expect(
        events.filter((event) => event.type === 'end').map((event) => event.result.status),
      ).toEqual(['completed', 'completed', 'completed', 'completed', 'completed']);
    } finally {
      await session.close();
    }
  });

  it('grants nothing by an answer to a question asked before it was taken back: it asks again', async () => {
    const { consent, reset } = owner();
    const { session, consents, events } = await started(consent);
    try {
      await session.send({ id: 'm1', text: '/consent' });
      await expect.poll(() => consents().length).toBe(1);
      reset();
      session.prompts?.answer(PromptEvent.parse(consents()[0]).key, {
        kind: 'choice',
        value: 'always',
      });
      await expect.poll(() => consents().length).toBe(2);
      expect(consent.give).not.toHaveBeenCalled();
      session.prompts?.answer(PromptEvent.parse(consents()[1]).key, {
        kind: 'choice',
        value: 'no',
      });
      await expect.poll(() => events.some((event) => event.type === 'end')).toBe(true);
      expect(events.find((event) => event.type === 'end')).toMatchObject({
        result: { status: 'cancelled' },
      });
    } finally {
      await session.close();
    }
  });

  it('asks nothing where its connection asks no consent', async () => {
    const { session, consents, turn } = await started();
    try {
      await turn('m1', '/consent one');
      expect(consents()).toEqual([]);
    } finally {
      await session.close();
    }
  });
});

it('reports context before a fake turn ends', async () => {
  const events: HostEvent[] = [];
  const session = await fakeConnector().start(
    {
      agentId: 'a',
      cwd: '/unused',
      env: {},
      model: null,
      mode: 'acceptEdits',
      resume: null,
    },
    {
      emit: (event) => {
        events.push(event);
      },
      remember: vi.fn(),
    },
  );
  try {
    await session.send({ id: 'message', text: 'Hello' });
    await expect.poll(() => events.some((event) => event.type === 'end')).toBe(true);
    const beforeEnd = events.slice(
      0,
      events.findIndex((event) => event.type === 'end'),
    );
    expect(beforeEnd.filter((event) => event.type === 'usage').at(-1)).toMatchObject({
      usage: { context: { used: 1000, window: 200000, compactAt: 167000 } },
    });
  } finally {
    await session.close();
  }
});

describe('a scripted fake (CORRALLM_FAKE_SCRIPT, for the README media only)', () => {
  const script: FakeScript = {
    pause: 0,
    turns: [
      {
        when: 'cart endpoint',
        thinking: 'Totals come from the pricing helper.',
        tools: [
          { tool: 'Read', summary: 'src/pricing.ts' },
          {
            tool: 'Edit',
            summary: 'src/cart.ts',
            diff: [
              { kind: 'same', text: 'export const routes = [' },
              { kind: 'add', text: '  cart,' },
            ],
          },
          { tool: 'Bash', summary: 'pnpm test cart', output: '6 passed' },
        ],
        reply: 'Added the **cart** endpoint, with tests.',
      },
      { reply: 'Done.' },
    ],
  };

  async function turn(text: string, given = script) {
    const events: HostEvent[] = [];
    const session = await fakeConnector({ script: given }).start(
      { agentId: 'a', cwd: '/unused', env: {}, model: null, mode: 'manual', resume: null },
      {
        emit: (event) => {
          events.push(event);
        },
        remember: vi.fn(),
      },
    );
    return { events, session, sent: session.send({ id: 'm', text }) };
  }

  const ended = (events: HostEvent[]) => events.some((event) => event.type === 'end');
  const said = (events: HostEvent[], type: 'text' | 'thinking') =>
    events.flatMap((event) => (event.type === type ? [event.text] : [])).join('');

  it('plays the turn whose words the message holds: thinking, tools and a streamed reply', async () => {
    const { events, session, sent } = await turn('Add the cart endpoint, please.');
    await sent;
    await expect.poll(() => ended(events)).toBe(true);
    await session.close();
    expect(said(events, 'thinking')).toBe('Totals come from the pricing helper.');
    expect(said(events, 'text')).toBe('Added the **cart** endpoint, with tests.');
    // Streamed: more than one piece of the reply.
    expect(events.filter((event) => event.type === 'text').length).toBeGreaterThan(1);
    const tools = events.flatMap((event) => (event.type === 'tool' ? [event] : []));
    expect(tools.map(({ tool, status }) => `${tool} ${status}`)).toEqual([
      'Read running',
      'Read done',
      'Edit running',
      'Edit done',
      'Bash running',
      'Bash done',
    ]);
    expect(tools[3]?.detail).toEqual({
      kind: 'diff',
      added: 1,
      removed: 0,
      lines: [
        { kind: 'same', text: 'export const routes = [' },
        { kind: 'add', text: '  cart,' },
      ],
    });
    expect(tools[5]?.detail).toEqual({ kind: 'output', text: '6 passed' });
    // A scripted turn never asks, whatever its mode.
    expect(events.some((event) => ['permission'].includes(event.type))).toBe(false);
    expect(events.find((event) => event.type === 'end')).toMatchObject({
      messages: ['m'],
      result: { status: 'completed' },
    });
  });

  it('streams a list item with its first words, never a bare marker', async () => {
    const { events, session } = await turn('Something', {
      pause: 0,
      turns: [{ reply: 'It now:\n\n- opens from the header\n- closes on Esc\n\n1. and more' }],
    });
    await expect.poll(() => ended(events)).toBe(true);
    await session.close();
    const pieces = events.flatMap((event) => (event.type === 'text' ? [event.text] : []));
    expect(pieces.join('')).toBe(
      'It now:\n\n- opens from the header\n- closes on Esc\n\n1. and more',
    );
    expect(pieces.filter((piece) => /(?:^|\n)\s*(?:[-*]|\d+\.)\s*$/.test(piece))).toEqual([]);
  });

  it('plays the turn with no words for any other message', async () => {
    const { events, session } = await turn('Something unscripted');
    await expect.poll(() => ended(events)).toBe(true);
    await session.close();
    expect(said(events, 'text')).toBe('Done.');
  });

  it('stops at once when interrupted, marking its running tool interrupted', async () => {
    const { events, session } = await turn('Something', {
      pause: 60_000,
      turns: [{ tools: [{ tool: 'Bash', summary: 'pnpm test' }], reply: 'Done.' }],
    });
    await expect.poll(() => events.some((event) => event.type === 'tool')).toBe(true);
    await session.interrupt();
    await expect.poll(() => ended(events)).toBe(true);
    expect(
      events.flatMap((event) => (event.type === 'tool' ? [`${event.tool} ${event.status}`] : [])),
    ).toEqual(['Bash running', 'Bash interrupted']);
    expect(events.find((event) => event.type === 'end')).toMatchObject({
      result: { status: 'cancelled' },
    });
  });
});

describe('fakeScript', () => {
  it('reads no script without the variable', () => {
    expect(fakeScript({})).toBeUndefined();
  });

  it('reads the JSON file the variable names, and refuses a malformed one', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'corrallm-fake-script-'));
    try {
      const good = path.join(dir, 'good.json');
      writeFileSync(good, JSON.stringify({ pause: 5, turns: [{ when: 'x', reply: 'y' }] }));
      expect(fakeScript({ CORRALLM_FAKE_SCRIPT: good })).toEqual({
        pause: 5,
        turns: [{ when: 'x', reply: 'y' }],
      });
      const bad = path.join(dir, 'bad.json');
      writeFileSync(bad, JSON.stringify({ pause: 5, turns: [{ when: 'x' }] }));
      expect(() => fakeScript({ CORRALLM_FAKE_SCRIPT: bad })).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
