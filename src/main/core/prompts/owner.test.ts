import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CanvasId } from '../../../shared/canvas';
import { MAX_SESSION_PROMPTS } from '../../../shared/api/limits';
import type { NodeLike } from '../../../shared/model/canvas';
import type { Message } from '../../../shared/model/messages';
import type { PromptAnswer } from '../../../shared/model/prompts';
import { MADE_UP } from '../../../shared/test-made-up';
import { CanvasMemory } from '../../memory';
import type { PromptAnswers } from '../../sessions/connector';
import type { PromptOrigin } from '../../sessions/manager';
import { OpFailure } from '../call';
import type { OpContext } from '../call';
import { recoverDecisions } from '../decisions';
import { MessageStore, MessageTable } from '../delivery/messages';
import { openTestStore } from '../store/test-store';
import type { Store } from '../store/store';
import { PromptOwner } from './owner';
import type { PromptLimits } from './owner';

/*
 * B13 C3, the core's prompt owner: each canvas's live index of what its agents' sessions raise,
 * admitted whole within its budgets or declined, classified once as it is raised, and answered
 * once, through the session handle captured as it was raised, after a durable record of who is
 * answering, never sent again after a crash.
 */

const CANVAS = '7f3e4d5c-6b7a-4c8d-9e0f-1a2b3c4d5e6f' as CanvasId;
const OTHER = '8a4f5e6d-7c8b-4d9e-8f10-2b3c4d5e6f70' as CanvasId;
const NODES: NodeLike[] = [
  { id: 'b', type: 'agent', data: { label: 'Reviewer' } },
  { id: 'c', type: 'agent', data: { label: 'Checker' } },
  { id: 'a/b', type: 'agent', data: { label: 'Slashed' } },
];
const KEY = '0f6b1e2a-3c4d-4e5f-8a9b-0c1d2e3f4a5b';
const KEY2 = '1a7c2f3b-4d5e-4f60-9b1c-2d3e4f5a6b7c';

const yes = { value: 'yes', label: 'Yes', hint: 'allow_once', effects: {} };
const no = { value: 'no', label: 'No', hint: 'reject_once', effects: {} };
const tell = {
  value: 'tell',
  label: 'No, and say what to do',
  hint: 'reject_once',
  effects: {},
  feedback: 'required',
};
const COMMAND = 'rm -rf build && echo private-command-text';
const approval = {
  kind: 'approval',
  title: 'Run rm -rf build?',
  summary: 'It clears the build folder',
  subject: { type: 'command', command: COMMAND, cwd: '/work/app' },
  answerIn: 'api',
  choices: [yes, no, tell],
};
const question = {
  kind: 'question',
  title: 'Which colour?',
  answerIn: 'api',
  questions: [
    {
      id: 'q1',
      header: 'Colour',
      text: 'Which colour?',
      options: [{ label: 'Red' }, { label: 'Blue' }],
      multiple: false,
      other: true,
    },
  ],
};

let profile: string;
let database: Store;
let messages: MessageStore;
let generations: Map<string, number>;
let notices: { agent: string; text: string }[];
let changes: number;
let owner: PromptOwner;

interface Handle extends PromptAnswers {
  answered: [string, PromptAnswer][];
  declined: [string, string][];
  dismissed: string[];
  /** What answering does: by default takes it; a test may make it refuse, or end it first. */
  onAnswer?: (key: string) => void;
}

function handle(): Handle {
  const made: Handle = {
    answered: [],
    declined: [],
    dismissed: [],
    answer: (key, answer) => {
      made.onAnswer?.(key);
      made.answered.push([key, answer]);
    },
    decline: (key, why) => {
      made.declined.push([key, why]);
    },
    dismiss: (key) => {
      made.dismissed.push(key);
    },
  };
  return made;
}

function origin(
  generation: number,
  answers: PromptAnswers,
  more: Partial<PromptOrigin> = {},
): PromptOrigin {
  return {
    canvas: CANVAS,
    agent: 'b',
    connection: 'zed.acp',
    generation,
    live: true,
    startMode: 'plan',
    answers,
    ...more,
  };
}

function make(limits?: Partial<PromptLimits>): PromptOwner {
  return new PromptOwner({
    catalog: MADE_UP,
    canvas: (canvas) =>
      canvas === CANVAS || canvas === OTHER ? { messages, nodes: NODES } : undefined,
    generationOf: (_canvas, agent) => generations.get(agent),
    changed: () => {
      changes += 1;
    },
    notice: (_canvas, agent, _connection, text) => {
      notices.push({ agent, text });
    },
    ...(limits === undefined ? {} : { limits }),
  });
}

async function loadMessages(): Promise<MessageStore> {
  const store = new MessageStore(
    CANVAS,
    new MessageTable(database, new CanvasMemory(database)),
    () => 1000,
  );
  await store.load();
  return store;
}

function context(more: Partial<OpContext> = {}): OpContext {
  return {
    by: 'you',
    caller: { kind: 'human', window: 'host' },
    signal: new AbortController().signal,
    noReturn: vi.fn(),
    ...more,
  } as unknown as OpContext;
}

/** Raises `prompt` by `key` from `at`: the item it waits as, if admitted. */
function raise(at: PromptOrigin, prompt: object, key = KEY) {
  owner.raised(at, { type: 'prompt', key, prompt });
  return owner.items(at.canvas).at(-1);
}

/** The id of the one item waiting, which a test expects is there. */
function only(): string {
  const items = owner.items(CANVAS);
  expect(items).toHaveLength(1);
  const [item] = items;
  if (item === undefined) throw new Error('nothing waits');
  return item.id;
}

async function answer(to: string, given: unknown, ctx = context()) {
  try {
    return await owner.answer(CANVAS, to, given, ctx);
  } catch (error) {
    if (error instanceof OpFailure) return { code: error.code, sentence: error.message };
    throw error;
  }
}

/** A read may refuse edits or return a separate copy; neither changes the admitted prompt. */
function editRead(edit: () => void): void {
  try {
    edit();
  } catch {
    // A read that refuses the edit still has to preserve every later read and answer.
  }
}

const settledRecords = (): Message[] =>
  messages.all().filter((message) => message.kind === 'settled');

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-prompts-'));
  database = await openTestStore(profile);
  messages = await loadMessages();
  generations = new Map([
    ['b', 7],
    ['c', 9],
  ]);
  notices = [];
  changes = 0;
  owner = make();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await database.close();
  await rm(profile, { recursive: true, force: true });
});

describe('admission', () => {
  it('mints a fresh prompt id for every raise, keeps the key private, and waits as yours', () => {
    const one = handle();
    const first = raise(origin(7, one), approval);
    expect(first).toMatchObject({
      canvas: CANVAS,
      agent: 'b',
      kind: 'prompt',
      for: 'you',
      by: ['you'],
      title: 'Run rm -rf build?',
      answerIn: 'api',
      choices: [
        { value: 'yes', label: 'Yes' },
        { value: 'no', label: 'No' },
        { value: 'tell', label: 'No, and say what to do' },
      ],
    });
    expect(first?.id).toMatch(
      /^prompt\/b\/7\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(changes).toBeGreaterThan(0);
    // The same request raised again (under a new key, as every raise is) is another prompt.
    const second = raise(origin(7, one), approval, KEY2);
    expect(second?.id).not.toBe(first?.id);
    const seen = JSON.stringify([owner.items(CANVAS), owner.prompts(CANVAS)]);
    expect(seen).not.toContain(KEY);
    expect(seen).not.toContain(KEY2);
    expect(one.declined).toEqual([]);
    // An agent's id with a slash in it is escaped in the id, which names it.
    generations.set('a/b', 3);
    const slashed = raise(
      origin(3, one, { agent: 'a/b' }),
      approval,
      '2b8d3a4c-5e6f-4a71-8c2d-3e4f5a6b7c8d',
    );
    expect(slashed?.id).toMatch(/^prompt\/a%2Fb\/3\//);
  });

  it.each(['tool', 'mcpTool', '_extension'])(
    'admission keeps its own copy of a %s subject and its choices',
    async (type) => {
      const one = handle();
      const input = { query: { terms: ['alpha'], limit: 2 } };
      const subject =
        type === 'tool'
          ? { type, tool: 'search', input }
          : type === 'mcpTool'
            ? { type, server: 'catalog', tool: 'search', input }
            : { type, input };
      const choices = [{ ...yes }, { ...no }];
      raise(origin(7, one), { ...approval, subject, choices });
      const id = only();
      const admitted = structuredClone(owner.prompts(CANVAS));
      const published = structuredClone(owner.items(CANVAS));

      input.query.terms.push('beta');
      input.query.limit = 4;
      const [choice] = choices;
      if (choice === undefined) throw new Error('missing choice');
      choice.value = 'later';
      choice.label = 'Later';

      expect(owner.prompts(CANVAS)).toEqual(admitted);
      expect(owner.items(CANVAS)).toEqual(published);
      expect(owner.current(CANVAS, id)).toEqual(published[0]);
      expect(await answer(id, { choice: 'later' })).toMatchObject({ code: 'invalid' });
      expect(one.answered).toEqual([]);
      expect(await answer(id, { choice: 'yes' })).toMatchObject({ outcome: 'answered' });
      expect(one.answered).toEqual([[KEY, { kind: 'choice', value: 'yes' }]]);
    },
  );

  it('a prompt read preserves the admitted choices for later readers and answers', async () => {
    const one = handle();
    raise(origin(7, one), approval);
    const id = only();
    const admitted = structuredClone(owner.prompts(CANVAS));
    const published = structuredClone(owner.items(CANVAS));
    const [read] = owner.prompts(CANVAS);
    if (read?.kind !== 'approval') throw new Error('missing approval');
    const [choice] = read.choices;
    if (choice === undefined) throw new Error('missing choice');
    editRead(() => {
      choice.value = 'later';
      choice.label = 'Later';
    });

    expect(owner.prompts(CANVAS)).toEqual(admitted);
    expect(owner.items(CANVAS)).toEqual(published);
    expect(await answer(id, { choice: 'later' })).toMatchObject({ code: 'invalid' });
    expect(one.answered).toEqual([]);
    expect(await answer(id, { choice: 'yes' })).toMatchObject({ outcome: 'answered' });
    expect(one.answered).toEqual([[KEY, { kind: 'choice', value: 'yes' }]]);
  });

  it('admission keeps its own copy of form fields across adapter edits and Needs reads', async () => {
    const one = handle();
    const schema = {
      type: 'object',
      properties: { name: { type: 'string', title: 'Name', minLength: 2 } },
      required: ['name'],
      additionalProperties: false,
    };
    raise(origin(7, one), {
      kind: 'form',
      title: 'Name',
      answerIn: 'api',
      form: { schema },
    });
    const id = only();
    const admitted = structuredClone(owner.prompts(CANVAS));
    const published = structuredClone(owner.items(CANVAS));
    schema.properties.name.title = 'Optional name';
    schema.properties.name.minLength = 0;
    schema.required.length = 0;
    expect(owner.prompts(CANVAS)).toEqual(admitted);
    expect(owner.items(CANVAS)).toEqual(published);

    const [read] = owner.items(CANVAS);
    if (read?.form === undefined || !('schema' in read.form)) throw new Error('missing form');
    const fields = read.form.schema as typeof schema;
    editRead(() => {
      fields.properties.name.minLength = 0;
    });
    editRead(() => {
      fields.required.length = 0;
    });
    expect(owner.prompts(CANVAS)).toEqual(admitted);
    expect(owner.items(CANVAS)).toEqual(published);
    expect(owner.current(CANVAS, id)).toEqual(published[0]);
    for (const values of [{}, { name: 'A' }]) {
      expect(await answer(id, { form: { action: 'accept', values } })).toMatchObject({
        code: 'invalid',
      });
      expect(one.answered).toEqual([]);
    }
    expect(await answer(id, { form: { action: 'accept', values: { name: 'Ada' } } })).toMatchObject(
      { outcome: 'answered' },
    );
    expect(one.answered).toEqual([
      [KEY, { kind: 'form', action: 'accept', values: { name: 'Ada' } }],
    ]);
  });

  it('declines what it can’t admit whole, saying why, and admits nothing', () => {
    const cases: [string, object][] = [
      [
        'too many choices',
        {
          ...approval,
          choices: [
            ...Array.from({ length: 16 }, (_, i) => ({ ...yes, value: `v${String(i)}` })),
            no,
          ],
        },
      ],
      ['no rejection', { ...approval, choices: [yes] }],
      ['an uncut title', { ...approval, title: 'x'.repeat(4001) }],
      [
        'a repeated question id',
        { ...question, questions: [question.questions[0], question.questions[0]] },
      ],
      [
        'a link not opened',
        {
          kind: 'form',
          title: 'Sign in',
          answerIn: 'api',
          form: { url: 'http://example.test/sign-in' },
        },
      ],
      [
        'a script link',
        { kind: 'form', title: 'Sign in', answerIn: 'api', form: { url: 'javascript:alert(1)' } },
      ],
      ['an unknown kind', { kind: 'dialog', title: 'Hm', answerIn: 'api' }],
    ];
    for (const [what, prompt] of cases) {
      const one = handle();
      notices = [];
      owner.raised(origin(7, one), { type: 'prompt', key: KEY, prompt });
      expect.soft(one.declined, what).toEqual([[KEY, expect.any(String)]]);
      expect.soft(notices, what).toEqual([{ agent: 'b', text: expect.any(String) as string }]);
      expect.soft(owner.items(CANVAS), what).toEqual([]);
    }
    // A notice says why in the core's words, never the prompt's.
    expect(JSON.stringify(notices)).not.toContain('example.test');
    // A key that isn't a key is declined by what it is: the session finds it, or nothing.
    const odd = handle();
    owner.raised(origin(7, odd), { type: 'prompt', key: 'not-a-uuid', prompt: approval });
    expect(odd.declined).toEqual([['not-a-uuid', expect.any(String)]]);
    expect(owner.items(CANVAS)).toEqual([]);
  });

  it('never declines a terminal observation: one too large waits as the core words it, cut', () => {
    const one = handle();
    const item = raise(origin(7, one), {
      kind: 'approval',
      title: 'y'.repeat(5000),
      answerIn: 'terminal',
      choices: [],
    });
    expect(one.declined).toEqual([]);
    expect(item).toMatchObject({ answerIn: 'terminal', choices: [] });
    expect(item?.title).not.toContain('yyyy');
    expect(owner.prompts(CANVAS)).toEqual([expect.objectContaining({ cut: true })]);
    // It still ends by its key.
    owner.ended(origin(7, one), { type: 'prompt-ended', key: KEY, reason: 'answered-natively' });
    expect(owner.items(CANVAS)).toEqual([]);
  });

  it('declines a duplicate live key, and withdraws the prompt that key named', () => {
    const one = handle();
    raise(origin(7, one), approval);
    owner.raised(origin(7, one), { type: 'prompt', key: KEY, prompt: question });
    expect(one.declined).toEqual([[KEY, expect.any(String)]]);
    expect(owner.items(CANVAS)).toEqual([]);
    expect(notices).toHaveLength(1);
    // The same key in another generation is another request.
    generations.set('b', 8);
    raise(origin(8, handle()), approval);
    expect(owner.items(CANVAS)).toHaveLength(1);
  });

  it('declines past each budget: a generation’s, a canvas’s and the core’s', () => {
    owner = make({ session: 2, canvas: 3, bytes: 4000 });
    const one = handle();
    const keys = Array.from({ length: 4 }, () => crypto.randomUUID());
    for (const key of keys.slice(0, 3)) raise(origin(7, one), approval, key);
    expect(owner.items(CANVAS)).toHaveLength(2);
    expect(one.declined).toEqual([[keys[2], expect.any(String)]]);
    // Another agent's generation on the canvas: the canvas's budget.
    const two = handle();
    raise(origin(9, two, { agent: 'c' }), approval, keys[3]);
    raise(origin(9, two, { agent: 'c' }), approval, crypto.randomUUID());
    expect(owner.items(CANVAS)).toHaveLength(3);
    expect(two.declined).toHaveLength(1);
    // The core's bytes, across canvases.
    const three = handle();
    const plan = {
      kind: 'plan',
      title: 'Plan',
      plan: 'p'.repeat(3000),
      answerIn: 'api',
      choices: [yes, no],
    };
    raise(origin(4, three, { canvas: OTHER }), plan, crypto.randomUUID());
    expect(owner.items(OTHER)).toEqual([]);
    expect(three.declined).toHaveLength(1);
    // A terminal observation past a budget isn't declined: it isn't kept, and its transcript says so.
    const four = handle();
    notices = [];
    raise(
      origin(7, four),
      { kind: 'approval', title: 'Waiting', answerIn: 'terminal', choices: [] },
      crypto.randomUUID(),
    );
    expect(four.declined).toEqual([]);
    expect(notices).toHaveLength(1);
  });

  it('holds at most MAX_SESSION_PROMPTS open for one generation', () => {
    const one = handle();
    for (let i = 0; i <= MAX_SESSION_PROMPTS; i += 1)
      raise(origin(7, one), approval, crypto.randomUUID());
    expect(owner.items(CANVAS)).toHaveLength(MAX_SESSION_PROMPTS);
    expect(one.declined).toHaveLength(1);
  });

  it('declines a raise from a generation no longer heard, telling no one', () => {
    const one = handle();
    raise(origin(6, one, { live: false }), approval);
    expect(one.declined).toEqual([[KEY, expect.any(String)]]);
    expect(notices).toEqual([]);
    expect(owner.items(CANVAS)).toEqual([]);
  });

  it('classifies as it raises, with the generation’s start mode, and never again', () => {
    const into = (mode: string) => ({
      value: mode,
      label: `Go on in ${mode}`,
      hint: 'allow_once',
      effects: { mode },
    });
    const plan = {
      kind: 'plan',
      title: 'Approve the plan?',
      plan: '# Plan',
      answerIn: 'api',
      choices: [into('plan'), into('auto'), no],
    };
    const known = raise(origin(7, handle(), { startMode: 'plan' }), plan);
    expect(known?.choices).toEqual([
      { value: 'plan', label: 'Go on in plan' },
      { value: 'auto', label: 'Go on in auto', humanOnly: expect.any(String) as string },
      { value: 'no', label: 'No' },
    ]);
    // Its start mode unknown: every mode choice is yours.
    const unknown = raise(origin(7, handle(), { startMode: null }), plan, KEY2);
    expect(unknown?.choices.map(({ humanOnly }) => typeof humanOnly)).toEqual([
      'string',
      'string',
      'undefined',
    ]);
    // A whole prompt only you may answer: each of its choices says so.
    const consent = raise(
      origin(7, handle()),
      { ...approval, subject: { type: 'consent', key: 'plan', text: 'Spend your plan?' } },
      crypto.randomUUID(),
    );
    expect(consent?.choices.every(({ humanOnly }) => typeof humanOnly === 'string')).toBe(true);
    const prompt = owner.prompts(CANVAS).at(-1);
    expect(prompt?.humanOnly).toEqual(expect.any(String));
    expect(prompt).not.toHaveProperty('signals');
  });

  it('says in its own words that a choice the CLI offers was left out', () => {
    raise(origin(7, handle()), { ...approval, reason: 'Its CLI asks.', omitted: true });
    const [prompt] = owner.prompts(CANVAS);
    expect(prompt?.reason).toMatch(/^Its CLI asks\.\n.+/);
    expect(prompt).not.toHaveProperty('omitted');
  });

  it('shows a form by the core’s title, with no detail, and a plan by its first lines', () => {
    const form = raise(origin(7, handle()), {
      kind: 'form',
      title: 'Sign in at https://example.test/private',
      answerIn: 'api',
      form: { url: 'https://example.test/private' },
    });
    expect(form).toMatchObject({ form: { url: 'https://example.test/private' }, choices: [] });
    expect(form?.title).not.toContain('example.test');
    expect(form).not.toHaveProperty('detail');
    const plan = raise(
      origin(7, handle()),
      {
        kind: 'plan',
        title: 'Approve the plan?',
        plan: Array.from({ length: 20 }, (_, i) => `Step ${String(i + 1)}`).join('\n'),
        answerIn: 'api',
        choices: [yes, no],
      },
      KEY2,
    );
    expect(plan?.detail?.split('\n')).toHaveLength(13);
    expect(plan?.detail).toMatch(/^Step 1\n[\s\S]*Step 12\n… 8 more lines$/);
    const asked = raise(origin(7, handle()), question, crypto.randomUUID());
    expect(asked?.questions).toEqual([
      {
        id: 'q1',
        header: 'Colour',
        text: 'Which colour?',
        options: [{ label: 'Red' }, { label: 'Blue' }],
        multiple: false,
        other: true,
      },
    ]);
  });

  it('names the MCP server that asks for a form, where its adapter says which, never its words', () => {
    const form = raise(origin(7, handle()), {
      kind: 'form',
      title: 'Sign in at https://example.test/private',
      server: 'tracker',
      answerIn: 'api',
      form: { url: 'https://example.test/private' },
    });
    expect(form?.title).toBe('MCP server “tracker” asks you to open a link');
  });
});

describe('prompts its session also shows as the events B13 replaces (until X10)', () => {
  it('lists none in Needs, where the old event’s item stands for it, yet finds it by its key', async () => {
    const answers = handle();
    owner.raised(origin(7, answers, { mirrored: true }), {
      type: 'prompt',
      key: KEY,
      prompt: approval,
    });
    expect(owner.items(CANVAS)).toEqual([]);
    const need = owner.keyed(CANVAS, 'b', 7, KEY);
    expect(need).toMatch(/^prompt\/b\/7\/[0-9a-f-]{36}$/);
    // Not another generation's, nor another agent's, nor another key's.
    expect(owner.keyed(CANVAS, 'b', 8, KEY)).toBeUndefined();
    expect(owner.keyed(CANVAS, 'c', 7, KEY)).toBeUndefined();
    expect(owner.keyed(CANVAS, 'b', 7, KEY2)).toBeUndefined();
    // Answered through the owner as any other: by its NeedId, on the handle captured at raise.
    if (need === undefined) throw new Error('not found');
    expect(await answer(need, { choice: 'yes' })).toMatchObject({ outcome: 'answered' });
    expect(answers.answered).toEqual([[KEY, { kind: 'choice', value: 'yes' }]]);
    expect(owner.keyed(CANVAS, 'b', 7, KEY)).toBeUndefined();
  });
});

describe('Not waiting (B13 C7)', () => {
  /** What a terminal's CLI waits on, raised from its report alone: in its words, nothing more. */
  const waiting = {
    kind: 'approval',
    title: 'Claude Code is waiting for you.',
    answerIn: 'terminal',
    choices: [],
  };
  const waitingQuestion = {
    kind: 'question',
    title: 'answer: Which region?',
    answerIn: 'terminal',
    questions: [],
  };
  const screenWait = {
    ...waiting,
    title: 'Codex needs you: see its terminal.',
    detail: { kind: 'output', text: '  Would you like to run the following command?\n› 1. Yes' },
  };
  /** What a hook described, the trust screen, and what is answered through corrallm. */
  const described = {
    kind: 'approval',
    title: 'Claude wants to use Bash',
    subject: { type: 'tool', tool: 'Bash', input: { command: 'ls' } },
    answerIn: 'terminal',
    choices: [],
  };
  const trust = {
    kind: 'approval',
    title: 'Claude Code asks whether you trust the project folder.',
    subject: { type: 'trust' },
    answerIn: 'terminal',
    choices: [],
  };
  const plan = {
    kind: 'plan',
    title: 'Approve Claude’s plan?',
    plan: '## Plan',
    answerIn: 'terminal',
    choices: [],
  };
  const NOT_WAITING = {
    value: 'not-waiting',
    label: 'Not waiting',
    humanOnly: expect.any(String) as string,
  };

  it('is offered, yours alone, only on a terminal wait raised from an undescribed report', () => {
    const one = handle();
    for (const wait of [waiting, waitingQuestion, screenWait]) {
      const item = raise(origin(7, one), wait, crypto.randomUUID());
      expect(item?.choices, wait.title).toEqual([NOT_WAITING]);
    }
    const oversized = { ...waiting, title: 'y'.repeat(5000) };
    for (const wait of [described, trust, plan, { ...question, answerIn: 'terminal' }, approval]) {
      const item = raise(origin(7, one), wait, crypto.randomUUID());
      expect(
        item?.choices.map(({ value }) => value),
        wait.title,
      ).not.toContain('not-waiting');
    }
    // Nor on the core's own stand-in for an observation it can't show whole: a hook may have
    // described it.
    const standIn = raise(origin(7, one), oversized, crypto.randomUUID());
    expect(standIn?.choices).toEqual([]);
  });

  it('settles a wait dismissed by you: no record, the session told to stop raising it, a later reply told so', async () => {
    const one = handle();
    raise(origin(7, one), waiting);
    const id = only();
    expect(owner.fits(CANVAS, id, { choice: 'not-waiting' })).toBeUndefined();
    const noReturn = vi.fn();
    expect(await answer(id, { choice: 'not-waiting' }, context({ noReturn }))).toEqual({
      outcome: 'dismissed',
    });
    expect(noReturn).toHaveBeenCalled();
    expect(one.dismissed).toEqual([KEY]);
    expect(one.answered).toEqual([]);
    expect(one.declined).toEqual([]);
    expect(messages.all()).toEqual([]);
    expect(owner.items(CANVAS)).toEqual([]);
    expect(owner.current(CANVAS, id)).toBeUndefined();
    // Settled: a later reply is told so; a late end of its key ends nothing.
    owner.ended(origin(7, one), { type: 'prompt-ended', key: KEY, reason: 'answered-natively' });
    expect(await answer(id, { choice: 'not-waiting' })).toMatchObject({
      code: 'conflict',
      sentence: expect.stringMatching(/isn’t waiting/) as string,
    });
    expect(one.dismissed).toEqual([KEY]);
    // A question in its report's words, and one with its screen's last rows, likewise.
    raise(origin(7, one), waitingQuestion, KEY2);
    expect(await answer(only(), { choice: 'not-waiting' })).toEqual({ outcome: 'dismissed' });
    expect(one.dismissed).toEqual([KEY, KEY2]);
  });

  it('is refused to any other party, with words, or where it isn’t offered, invoking nothing', async () => {
    const one = handle();
    raise(origin(7, one), waiting);
    const id = only();
    const token = context({
      by: 'outside:orchestrator',
      caller: {
        kind: 'outside',
        token: 't',
        name: 'orchestrator',
        access: 'write',
        merge: true,
        canvases: [CANVAS],
      },
    });
    expect(await answer(id, { choice: 'not-waiting' }, token)).toMatchObject({
      code: 'refused',
    });
    for (const given of [
      { choice: 'not-waiting', feedback: 'it isn’t' },
      { choice: 'not-waiting', text: 'it isn’t' },
      { choice: 'yes' },
    ]) {
      expect.soft(owner.fits(CANVAS, id, given), JSON.stringify(given)).toEqual(expect.any(String));
      expect
        .soft(await answer(id, given), JSON.stringify(given))
        .toMatchObject({ code: 'invalid' });
    }
    for (const [wait, key] of [
      [described, KEY2],
      [trust, crypto.randomUUID()],
      [approval, crypto.randomUUID()],
    ] as const) {
      raise(origin(7, one), wait, key);
      const other = owner.items(CANVAS).at(-1)?.id ?? '';
      expect(owner.fits(CANVAS, other, { choice: 'not-waiting' })).toEqual(expect.any(String));
      expect(await answer(other, { choice: 'not-waiting' })).toMatchObject({ code: 'invalid' });
    }
    expect(one.dismissed).toEqual([]);
    expect(one.answered).toEqual([]);
    expect(owner.items(CANVAS)).toHaveLength(4);
  });
});

describe('ends', () => {
  it('ends a prompt by its key, and ignores an unknown or settled key: a late end never ends a replacement', async () => {
    const one = handle();
    raise(origin(7, one), approval);
    const first = only();
    owner.ended(origin(7, one), { type: 'prompt-ended', key: KEY, reason: 'withdrawn' });
    expect(owner.items(CANVAS)).toEqual([]);
    // The same native item asks again: a new key, a new prompt.
    raise(origin(7, one), approval, KEY2);
    const second = only();
    owner.ended(origin(7, one), { type: 'prompt-ended', key: KEY, reason: 'withdrawn' });
    owner.ended(origin(7, one), {
      type: 'prompt-ended',
      key: crypto.randomUUID(),
      reason: 'withdrawn',
    });
    owner.ended(origin(8, one), { type: 'prompt-ended', key: KEY2, reason: 'withdrawn' });
    expect(only()).toBe(second);
    // A late answer to the first answers nothing: how it ended.
    expect(await answer(first, { choice: 'yes' })).toMatchObject({
      code: 'conflict',
      sentence: expect.stringMatching(/withdrawn/) as string,
    });
    expect(one.answered).toEqual([]);
    expect(owner.current(CANVAS, first)).toBeUndefined();
    expect(owner.settled(CANVAS, first)).toBeInstanceOf(OpFailure);
    await answer(second, { choice: 'yes' });
    owner.ended(origin(7, one), { type: 'prompt-ended', key: KEY2, reason: 'withdrawn' });
    expect(owner.settled(CANVAS, second)?.message).toMatch(/You allowed/);
  });

  it('withdraws every prompt of a generation that ended, and only those', async () => {
    raise(origin(7, handle()), approval);
    const reviewer = only();
    raise(origin(9, handle(), { agent: 'c' }), approval, KEY2);
    owner.gone(CANVAS, 'b', 7);
    expect(owner.items(CANVAS).map(({ agent }) => agent)).toEqual(['c']);
    expect(await answer(reviewer, { choice: 'yes' })).toMatchObject({ code: 'conflict' });
  });

  it('says how an answered-in-terminal prompt ended', async () => {
    const one = handle();
    raise(origin(7, one), approval);
    const id = only();
    owner.ended(origin(7, one), { type: 'prompt-ended', key: KEY, reason: 'answered-natively' });
    expect(await answer(id, { choice: 'yes' })).toMatchObject({
      code: 'conflict',
      sentence: expect.stringMatching(/terminal/) as string,
    });
  });
});

describe('answers', () => {
  it('hands the answer to the session that raised it, by its key, once its record is on disk; the record holds no value', async () => {
    const one = handle();
    raise(origin(7, one), approval);
    const id = only();
    const write = vi.spyOn(messages, 'durable');
    let onDisk: Message | undefined;
    one.onAnswer = () => {
      // Recorded as being made, and on disk, before the CLI is told.
      expect(write).toHaveBeenCalled();
      onDisk = settledRecords()[0];
    };
    const noReturn = vi.fn();
    const ctx = context({ noReturn });
    const result = await answer(id, { choice: 'tell', feedback: 'Use the clean script' }, ctx);
    expect(onDisk).toMatchObject({ state: 'delivering', by: 'you' });
    expect(noReturn).toHaveBeenCalledOnce();
    expect(one.answered).toEqual([
      [KEY, { kind: 'choice', value: 'tell', feedback: 'Use the clean script' }],
    ]);
    const [record] = settledRecords();
    expect(result).toEqual({ id: record?.id, outcome: 'answered' });
    expect(record).toMatchObject({ from: 'corrallm', to: 'you', by: 'you', state: 'delivered' });
    expect(record?.body).toBe('You refused Reviewer’s command.');
    for (const secret of ['rm -rf', 'private-command-text', 'clean script', 'Run rm']) {
      expect(JSON.stringify(messages.all())).not.toContain(secret);
    }
    expect(owner.items(CANVAS)).toEqual([]);
    // Once: a second answer is told who settled it.
    expect(await answer(id, { choice: 'yes' })).toMatchObject({
      code: 'conflict',
      sentence: expect.stringMatching(/You refused Reviewer’s command/) as string,
    });
    expect(one.answered).toHaveLength(1);
  });

  it('answers on the handle captured at raise, never a later generation’s', async () => {
    const first = handle();
    raise(origin(7, first), approval);
    const old = only();
    owner.gone(CANVAS, 'b', 7);
    generations.set('b', 8);
    const second = handle();
    raise(origin(8, second), approval, KEY);
    const now = only();
    expect(await answer(old, { choice: 'yes' })).toMatchObject({ code: 'conflict' });
    expect(second.answered).toEqual([]);
    await answer(now, { choice: 'yes' });
    expect(second.answered).toEqual([[KEY, { kind: 'choice', value: 'yes' }]]);
    expect(first.answered).toEqual([]);
    // A forged id naming the prompt with another agent or generation names nothing.
    const [, , , promptId] = now.split('/');
    raise(origin(8, second), approval, KEY2);
    const live = only();
    const [, , , liveId] = live.split('/');
    for (const forged of [`prompt/c/8/${String(liveId)}`, `prompt/b/7/${String(liveId)}`]) {
      expect(owner.current(CANVAS, forged)).toBeUndefined();
      expect(await answer(forged, { choice: 'yes' })).toMatchObject({ code: 'not-found' });
    }
    expect(promptId).toBeDefined();
  });

  it('reserves before any await: a second reply meanwhile is a conflict naming who answers', async () => {
    const one = handle();
    raise(origin(7, one), approval);
    const id = only();
    const first = answer(id, { choice: 'yes' });
    const second = await answer(id, { choice: 'no' });
    expect(second).toMatchObject({
      code: 'conflict',
      sentence: expect.stringMatching(/the user is answering/) as string,
    });
    expect(await first).toMatchObject({ outcome: 'answered' });
    expect(one.answered).toEqual([[KEY, { kind: 'choice', value: 'yes' }]]);
  });

  it('gives nothing when its record can’t be written, and stays open', async () => {
    const one = handle();
    raise(origin(7, one), approval);
    const id = only();
    vi.spyOn(messages, 'durable').mockRejectedValueOnce(new Error('disk full'));
    expect(await answer(id, { choice: 'yes' })).toMatchObject({ code: 'unavailable' });
    expect(one.answered).toEqual([]);
    expect(settledRecords()).toEqual([expect.objectContaining({ state: 'withdrawn' })]);
    expect(only()).toBe(id);
    vi.restoreAllMocks();
    expect(await answer(id, { choice: 'yes' })).toMatchObject({ outcome: 'answered' });
  });

  it('lets an end while its record is written win: the record is withdrawn, the reply says how it ended', async () => {
    for (const end of ['withdrawn', 'answered-natively', 'gone'] as const) {
      const one = handle();
      const key = crypto.randomUUID();
      raise(origin(7, one), approval, key);
      const id = only();
      const durable = messages.durable.bind(messages);
      vi.spyOn(messages, 'durable').mockImplementationOnce(async () => {
        await durable();
        if (end === 'gone') owner.gone(CANVAS, 'b', 7);
        else owner.ended(origin(7, one), { type: 'prompt-ended', key, reason: end });
      });
      expect.soft(await answer(id, { choice: 'yes' }), end).toMatchObject({
        code: 'conflict',
        sentence: expect.stringMatching(
          end === 'answered-natively' ? /terminal/ : /withdrawn/,
        ) as string,
      });
      expect.soft(one.answered, end).toEqual([]);
      expect.soft(settledRecords().at(-1)?.state, end).toBe('withdrawn');
      expect.soft(owner.items(CANVAS), end).toEqual([]);
      vi.restoreAllMocks();
    }
  });

  it('checks the generation again after the record is on disk', async () => {
    const one = handle();
    raise(origin(7, one), approval);
    const id = only();
    const durable = messages.durable.bind(messages);
    vi.spyOn(messages, 'durable').mockImplementationOnce(async () => {
      await durable();
      // Another session started for the agent, before the manager told the owner the old one went.
      generations.set('b', 8);
    });
    expect(await answer(id, { choice: 'yes' })).toMatchObject({ code: 'conflict' });
    expect(one.answered).toEqual([]);
  });

  it('keeps a prompt its CLI refused open, its record withdrawn; one ended as it refused is ended', async () => {
    const one = handle();
    raise(origin(7, one), approval);
    const id = only();
    one.onAnswer = () => {
      throw new Error('The CLI is busy.');
    };
    expect(await answer(id, { choice: 'yes' })).toMatchObject({
      code: 'unavailable',
      sentence: expect.stringMatching(/The CLI is busy/) as string,
    });
    expect(only()).toBe(id);
    expect(settledRecords().at(-1)).toMatchObject({
      state: 'withdrawn',
      body: expect.stringMatching(/^Reviewer’s CLI didn’t take this answer/) as string,
    });
    one.onAnswer = (key) => {
      owner.ended(origin(7, one), { type: 'prompt-ended', key, reason: 'withdrawn' });
      throw new Error('Gone.');
    };
    expect(await answer(id, { choice: 'yes' })).toMatchObject({ code: 'unavailable' });
    expect(owner.items(CANVAS)).toEqual([]);
  });

  it('ignores an end once the answer is handed off', async () => {
    const one = handle();
    raise(origin(7, one), approval);
    const id = only();
    one.onAnswer = (key) => {
      owner.ended(origin(7, one), { type: 'prompt-ended', key, reason: 'answered-natively' });
    };
    expect(await answer(id, { choice: 'yes' })).toMatchObject({ outcome: 'answered' });
    owner.ended(origin(7, one), { type: 'prompt-ended', key: KEY, reason: 'withdrawn' });
    expect(owner.settled(CANVAS, id)?.message).toMatch(/You allowed Reviewer’s command once/);
  });

  it('withdraws its record and gives nothing when the call can no longer act', async () => {
    const one = handle();
    raise(origin(7, one), approval);
    const id = only();
    const cancelled = context({
      noReturn: () => {
        throw new OpFailure('unavailable', 'The call was cancelled.');
      },
    });
    expect(await answer(id, { choice: 'yes' }, cancelled)).toMatchObject({
      code: 'unavailable',
      sentence: 'The call was cancelled.',
    });
    expect(one.answered).toEqual([]);
    expect(settledRecords().at(-1)?.state).toBe('withdrawn');
    expect(only()).toBe(id);
  });

  it('takes only an answer the prompt takes, invoking nothing otherwise', async () => {
    const one = handle();
    raise(origin(7, one), approval);
    const id = only();
    for (const given of [
      { choice: 'maybe' },
      { choice: 'yes', feedback: 'no feedback here' },
      { choice: 'tell' },
      { choice: 'yes', text: 'words' },
      { text: 'words' },
      { permission: 'once' },
      { answers: { q1: { picked: ['Red'] } } },
    ]) {
      expect.soft(owner.fits(CANVAS, id, given), JSON.stringify(given)).toEqual(expect.any(String));
      expect
        .soft(await answer(id, given), JSON.stringify(given))
        .toMatchObject({ code: 'invalid' });
    }
    raise(origin(7, one), question, KEY2);
    const asked = owner.items(CANVAS).at(-1)?.id ?? '';
    for (const given of [
      { answers: { q2: { picked: ['Red'] } } },
      { answers: { q1: { picked: ['Green'] } } },
      { answers: { q1: 'Red' } },
      { answers: { q1: { picked: ['Red'], text: 'and' } } },
    ]) {
      expect
        .soft(await answer(asked, given), JSON.stringify(given))
        .toMatchObject({ code: 'invalid' });
    }
    const terminal = crypto.randomUUID();
    raise(origin(7, one), { ...approval, answerIn: 'terminal' }, terminal);
    const there = owner.items(CANVAS).at(-1)?.id ?? '';
    expect(await answer(there, { choice: 'yes' })).toMatchObject({
      code: 'invalid',
      sentence: expect.stringMatching(/terminal/) as string,
    });
    expect(one.answered).toEqual([]);
    expect(settledRecords()).toEqual([]);
    await answer(asked, { answers: { q1: { text: 'Teal, mostly' } } });
    expect(one.answered).toEqual([
      [KEY2, { kind: 'questions', answers: { q1: { text: 'Teal, mostly' } } }],
    ]);
    expect(JSON.stringify(messages.all())).not.toContain('Teal');
  });

  it('is yours alone: no other party answers it', async () => {
    const one = handle();
    raise(origin(7, one), approval);
    const id = only();
    const token = context({
      by: 'outside:orchestrator',
      caller: {
        kind: 'outside',
        token: 't',
        name: 'orchestrator',
        access: 'write',
        merge: true,
        canvases: [CANVAS],
      },
    });
    expect(await answer(id, { choice: 'no' }, token)).toMatchObject({ code: 'refused' });
    expect(one.answered).toEqual([]);
    expect(settledRecords()).toEqual([]);
  });

  it('leaves an answer a crash cut off unresolved as the canvas loads again, never given again', async () => {
    const one = handle();
    raise(origin(7, one), approval);
    const id = only();
    const durable = messages.durable.bind(messages);
    // The record of who is answering reaches the disk; corrallm stops before anything after it does.
    vi.spyOn(messages, 'durable')
      .mockImplementationOnce(() => durable())
      .mockImplementation(() => new Promise<void>(() => undefined));
    void answer(id, { choice: 'yes' });
    await vi.waitFor(() => {
      expect(one.answered).toHaveLength(1);
    });
    vi.restoreAllMocks();
    await database.close();
    database = await openTestStore(profile);
    messages = await loadMessages();
    expect(recoverDecisions(messages)).toBe(true);
    expect(settledRecords()).toEqual([
      expect.objectContaining({
        state: 'unresolved',
        by: 'you',
        body: expect.stringMatching(/may not have reached/) as string,
      }),
    ]);
    // A core started again holds no open prompt to answer: the old id is settled, never resent.
    owner = make();
    expect(owner.items(CANVAS)).toEqual([]);
    expect(owner.settled(CANVAS, id)).toMatchObject({ code: 'conflict' });
    expect(await answer(id, { choice: 'yes' })).toMatchObject({ code: 'conflict' });
    expect(one.answered).toHaveLength(1);
  });
});
