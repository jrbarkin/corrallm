import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { NodeLike } from '../../../shared/model/canvas';
import type { PartyId } from '../../../shared/model/messages';
import { CanvasMemory } from '../../memory';
import { checkQuestionAnswers, PromptEvent } from '../../../shared/model/prompts';
import type { NeedsItem } from '../../../shared/model/needs';
import type { PromptOrigin } from '../../sessions/manager';
import { OpFailure } from '../call';
import type { OpContext } from '../call';
import type { Caller } from '../caller';
import { MessageStore, MessageTable } from '../delivery/messages';
import { ReplyRouter } from '../replies';
import { ruleChecks } from '../rules';
import type { Engines } from '../engines';
import { runReplies } from '../run-replies';
import type { Store } from '../store/store';
import { openTestStore } from '../store/test-store';
import { HAND_BACK } from './grants';
import { PromptOwner } from './owner';
import {
  ALL_GRANTS,
  LEAD_CANVAS,
  LEAD_CATALOG,
  leadAgent,
  plan,
  question,
  SIGNALLING,
  QUIET,
} from './test-lead-world';

/*
 * B24 C4's core: one allowance used at every boundary. For generated prompts (kind, choice hints,
 * marks, signals), parties (you, the routed lead, a lead it isn't routed to, a granted outside
 * party, an ungranted one, a stranger) and answers, the Needs selector, R3 (rules.ts), the reply
 * router and the prompt owner accept exactly the same answers.
 */

const CANVAS = LEAD_CANVAS;
const WITH_API = LEAD_CATALOG;
const KEY = '0f6b1e2a-3c4d-4e5f-8a9b-0c1d2e3f4a5b';
const ALL = ALL_GRANTS;

const agent = (id: string, parentId?: string): NodeLike => leadAgent(id, parentId);

const NODES = [agent('top'), agent('mid', 'top'), agent('work', 'mid'), agent('free')];

const choice = (value: string, hint: string, more: object = {}) => ({
  value,
  label: value,
  hint,
  effects: {},
  ...more,
});
const SETS = {
  plain: [choice('yes', 'allow_once'), choice('no', 'reject_once')],
  marked: [
    choice('yes', 'allow_once'),
    choice('no', 'reject_once'),
    choice('always', 'allow_always'),
    choice('never', 'reject_always'),
    { value: 'unknown', label: 'unknown', hint: 'allow_once' },
    choice('tell', 'reject_once', { feedback: 'required' }),
    choice('wide', 'allow_once', {
      effects: { rules: [{ behavior: 'allow', rule: 'x', scope: 'user' }] },
    }),
  ],
  trust: [choice('yes', 'allow_once'), choice('no', 'reject_once')],
} as const;

interface Case {
  name: string;
  prompt: object;
  signals: boolean;
  answers: unknown[];
  parties?: readonly { party: PartyId; caller: Caller }[];
}

const approval = (choices: readonly object[], more: object = {}) => ({
  kind: 'approval',
  title: 'Run it?',
  subject: { type: 'command', command: 'ls', cwd: '/w' },
  answerIn: 'api',
  choices,
  ...more,
});
const choiceAnswers = (values: string[]) => [
  ...values.map((value) => ({ choice: value })),
  { choice: 'tell', feedback: 'why' },
  { choice: HAND_BACK },
];
const CASES: Case[] = [];
for (const signals of [true, false]) {
  CASES.push(
    {
      name: 'plain approval',
      prompt: approval(SETS.plain),
      signals,
      answers: choiceAnswers(['yes', 'no']),
    },
    {
      name: 'marked approval',
      prompt: approval(SETS.marked),
      signals,
      answers: choiceAnswers(['yes', 'no', 'always', 'never', 'unknown', 'wide']),
    },
    {
      name: 'trust approval',
      prompt: approval(SETS.trust, { subject: { type: 'trust' } }),
      signals,
      answers: choiceAnswers(['yes', 'no']),
    },
    {
      name: 'a plan',
      prompt: plan,
      signals,
      answers: choiceAnswers(['go', 'stay']),
    },
    {
      name: 'a question',
      prompt: question,
      signals,
      answers: [
        { answers: { q1: { picked: ['Red'] } } },
        { answers: { q1: { text: 'mine' } } },
        { choice: HAND_BACK },
      ],
    },
  );
}

/** A small seeded generator (mulberry32): the same cases every run, reproducible from the seed. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HINTS = ['allow_once', 'allow_always', 'reject_once', 'reject_always'] as const;
const EFFECTS: (object | undefined)[] = [
  undefined,
  {},
  { rules: [{ behavior: 'allow', rule: 'x', scope: 'user' }] },
  { mode: 'bypass' },
  { directories: ['/elsewhere'] },
  { network: { host: 'example.test', allow: true, scope: 'session' } },
  { network: { host: 'example.test', allow: true, scope: 'turn' } },
  { rules: [], directories: [] },
];
const SIGNAL_MARKS: (object | undefined)[] = [
  undefined,
  undefined,
  { askRule: true },
  { safetyCheck: true },
  { requiresUser: true },
];
const ANSWER_IN = ['api', 'api', 'terminal', 'both'] as const;

/** Generated prompts (a stable few dozen) over both signals, each with answers to try. */
function generated(seed: number, count: number): Case[] {
  const next = seeded(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
  const cases: Case[] = [];
  for (let n = 0; n < count; n += 1) {
    const kind =
      n < 3
        ? (['approval', 'plan', 'question'] as const)[n]
        : pick(['approval', 'plan', 'question', 'approval']);
    const answerIn = n < 3 ? (['api', 'terminal', 'both'] as const)[n] : pick(ANSWER_IN);
    const signals = n % 2 === 0;
    const marks = pick(SIGNAL_MARKS);
    const values: string[] = [];
    const choices = Array.from({ length: 1 + Math.floor(next() * 4) }, (_, i) => {
      const effects = pick(EFFECTS);
      const feedback = pick([undefined, undefined, 'optional', 'required'] as const);
      const value = `c${String(i)}`;
      values.push(value);
      return {
        value,
        label: value,
        hint: pick(HINTS),
        ...(effects === undefined ? {} : { effects }),
        ...(feedback === undefined ? {} : { feedback }),
      };
    });
    // An API decision must offer a rejection.
    const last = choices.at(-1);
    if (last !== undefined && !choices.some(({ hint }) => hint.startsWith('reject_')))
      last.hint = pick(['reject_once', 'reject_always'] as const);
    const common = {
      title: 'Generated',
      answerIn,
      ...(marks === undefined ? {} : { signals: marks }),
    };
    const answers: unknown[] = [
      ...values.map((value) => ({ choice: value })),
      { choice: values[0] ?? 'c0', feedback: 'because' },
      { choice: 'not-offered' },
      { choice: HAND_BACK },
    ];
    if (kind === 'question') {
      cases.push({
        name: `generated ${String(n)} question`,
        prompt: { ...common, kind, ...{ questions: question.questions } },
        signals,
        answers: [
          { answers: { q1: { picked: ['Red'] } } },
          { answers: { q1: { text: 'mine' } } },
          { answers: { q1: { picked: ['Nowhere'] } } },
          { choice: HAND_BACK },
        ],
      });
    } else {
      const subject = pick([
        { type: 'command', command: 'ls', cwd: '/w' },
        { type: 'trust' },
        undefined,
      ]);
      cases.push({
        name: `generated ${String(n)} ${String(kind)}`,
        prompt:
          kind === 'plan'
            ? { ...common, kind, plan: 'Do it', choices }
            : { ...common, kind, ...(subject === undefined ? {} : { subject }), choices },
        signals,
        answers,
      });
    }
  }
  // Pin each boundary value as well as combining them randomly: a seed cannot miss an effect.
  for (const hint of HINTS)
    cases.push({
      name: `hint ${hint}`,
      signals: true,
      prompt: approval([choice('yes', hint), choice('no', 'reject_once')]),
      answers: choiceAnswers(['yes', 'no']),
    });
  for (const [i, effects] of EFFECTS.entries())
    cases.push({
      name: `effects ${String(i)}`,
      signals: true,
      prompt: approval([
        {
          value: 'yes',
          label: 'Yes',
          hint: 'allow_once',
          ...(effects === undefined ? {} : { effects }),
          feedback: 'optional',
        },
        choice('no', 'reject_once'),
      ]),
      answers: [...choiceAnswers(['yes', 'no']), { choice: 'yes', feedback: 'because' }],
    });
  for (const answerIn of new Set(ANSWER_IN))
    cases.push({
      name: `answerIn ${answerIn}`,
      signals: true,
      prompt: approval(SETS.plain, { answerIn }),
      answers: choiceAnswers(['yes', 'no']),
    });
  for (const secret of [true, false])
    cases.push({
      name: `question secret ${String(secret)}`,
      signals: true,
      prompt: { ...question, questions: question.questions.map((one) => ({ ...one, secret })) },
      answers: [
        { answers: { q1: { picked: ['Red'] } } },
        { answers: { q1: { text: 'mine' } } },
        { choice: HAND_BACK },
      ],
    });
  return cases.map((test) => {
    const stranger = `stranger_${String(Math.floor(next() * 1_000_000))}`;
    const parties = [
      ...PARTIES,
      { party: `agent:${stranger}` as const, caller: agentCaller(stranger) },
      { party: `outside:${stranger}` as const, caller: outsideCaller(stranger) },
    ];
    // Exercise identity and order independently of the prompt's generated fields.
    for (let i = parties.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      const left = parties[i];
      const right = parties[j];
      if (left !== undefined && right !== undefined) {
        parties[i] = right;
        parties[j] = left;
      }
    }
    return { ...test, parties };
  });
}

const PARTIES: { party: PartyId; caller: Caller }[] = [
  { party: 'you', caller: { kind: 'human', window: 'host' } as Caller },
  { party: 'agent:mid', caller: agentCaller('mid') },
  { party: 'agent:top', caller: agentCaller('top') },
  { party: 'agent:free', caller: agentCaller('free') },
  { party: 'outside:granted', caller: outsideCaller('granted') },
  { party: 'outside:other', caller: outsideCaller('other') },
];

function agentCaller(id: string): Caller {
  return { kind: 'agent', canvas: CANVAS, agent: id, generation: 1, session: 's' };
}
function outsideCaller(name: string): Caller {
  return { kind: 'outside', token: 't', name, access: 'write', merge: false, canvases: [CANVAS] };
}

let profile: string;
let database: Store;
let messages: MessageStore;
let owner: PromptOwner;
let router: ReplyRouter;
let rules: ReturnType<typeof ruleChecks>;
let given: unknown[];

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-agree-'));
  database = await openTestStore(profile);
  messages = new MessageStore(
    CANVAS,
    new MessageTable(database, new CanvasMemory(database)),
    () => 1000,
  );
  await messages.load();
  given = [];
  owner = new PromptOwner({
    catalog: WITH_API,
    canvas: () => ({ messages, nodes: NODES }),
    generationOf: () => 1,
    changed: () => undefined,
    notice: () => undefined,
    leads: { grantsOf: (_canvas, id) => (id === 'top' || id === 'mid' ? ALL : undefined) },
    grantees: () => ['granted'],
    timer: () => () => undefined,
  });
  router = new ReplyRouter(runReplies({ engines: {} as Engines, prompts: owner }));
  rules = ruleChecks(
    {} as Engines,
    WITH_API,
    (canvas, id) => owner.current(canvas, id),
    (canvas, to, by, answer) => owner.refusal(canvas, to, by, answer),
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  await database.close();
  await rm(profile, { recursive: true, force: true });
});

/** Raises `test.prompt` from the worker on the connection `test.signals` names; its Need id. */
function raise(test: Case): string {
  // Each boundary sees the same facts: an earlier generated rejection is not a denial in this
  // occurrence's world. Shuffling parties must not turn one boundary into the third rejection.
  owner.forgive(CANVAS);
  const origin: PromptOrigin = {
    canvas: CANVAS,
    agent: 'work',
    connection: test.signals ? SIGNALLING : QUIET,
    generation: 1,
    live: true,
    startMode: 'plan',
    answers: {
      answer: (_key, answer) => {
        given.push(answer);
      },
      decline: () => undefined,
      dismiss: () => undefined,
    },
  };
  owner.raised(origin, { type: 'prompt', key: KEY, prompt: test.prompt });
  const item = owner.items(CANVAS).at(-1);
  if (item === undefined) {
    const parsed = PromptEvent.safeParse({ type: 'prompt', key: KEY, prompt: test.prompt });
    throw new Error(
      `not admitted: ${test.name} ${parsed.success ? 'valid' : parsed.error.message}`,
    );
  }
  return item.id;
}

function context(caller: Caller, by: PartyId): OpContext {
  return {
    by,
    caller,
    signal: new AbortController().signal,
    noReturn: () => undefined,
  } as unknown as OpContext;
}

/** Whether the call came to nothing: refused or invalid, never an unexpected failure. */
async function accepted(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return true;
  } catch (error) {
    if (error instanceof OpFailure && ['refused', 'invalid'].includes(error.code)) return false;
    throw error;
  }
}

/** What the displayed controls offer, including feedback and question input controls. */
function offered(view: NeedsItem | undefined, party: PartyId, answer: unknown): boolean {
  if (view?.by.includes(party) !== true || view.answerIn === 'terminal') return false;
  const value = answer as { choice?: string; feedback?: string; answers?: unknown };
  if (value.choice !== undefined) {
    const choice = view.choices.find((one) => one.value === value.choice);
    if (choice === undefined) return false;
    if (
      value.feedback !== undefined &&
      choice.feedback !== 'optional' &&
      choice.feedback !== 'required'
    )
      return false;
    return choice.feedback !== 'required' || !!value.feedback?.trim();
  }
  if (value.answers === undefined || view.questions === undefined) return false;
  try {
    checkQuestionAnswers(view.questions, value.answers);
    return true;
  } catch {
    return false;
  }
}

/** Runs every party and answer of each case through the four boundaries; how many trials ran. */
async function agree(cases: readonly Case[]): Promise<number> {
  {
    let trials = 0;
    for (const test of cases) {
      for (const { party, caller } of test.parties ?? PARTIES) {
        for (const answer of test.answers) {
          // Hand back is never a thing you pick: no boundary offers it.
          if (party === 'you' && JSON.stringify(answer).includes(HAND_BACK)) continue;
          const label = `${test.name} (signals ${String(test.signals)}) · ${party} · ${JSON.stringify(answer)}`;
          const canvas = CANVAS;

          // The selector: the party must be named, and a choice must be among those it is shown.
          const id = raise(test);
          const view = owner
            .items(canvas, party === 'you' ? 'you' : 'token', party)
            .find((one) => one.id === id);
          const shown = offered(view, party, answer);

          // R3, over your view of the item as the router reads it.
          const rule = rules['human-choice'].reply;
          const refusal = rule(
            { canvas, to: id, answer } as never,
            { caller, party: 'worker' } as never,
          );
          // You are never checked by a rule.
          const r3 = party === 'you' || refusal === undefined || !('refuse' in (refusal as object));

          // The reply router, end to end.
          const viaRouter = await accepted(() =>
            router.reply({ canvas, to: id, answer: answer as never }, context(caller, party)),
          );

          // The prompt owner, directly, on a fresh occurrence.
          owner.closed(canvas);
          const again = raise(test);
          const viaOwner = await accepted(() =>
            owner.answer(canvas, again, answer, context(caller, party)),
          );
          owner.closed(canvas);

          // The router includes R3's and the owner's checks; R3 alone can pass what the owner finds
          // unfit for another reason, so only an acceptance by all four counts, and every
          // refusal by the allowance must be a refusal everywhere.
          if (party !== 'you' || !viaRouter) {
            expect(viaOwner, `owner ${label}`).toBe(viaRouter);
          }
          if (viaRouter) {
            expect(r3, `R3 ${label}`).toBe(true);
            expect(shown, `selector ${label}`).toBe(true);
          } else if (!viaOwner) {
            // Refused by the allowance: R3 refuses it too wherever it speaks to a choice, and the
            // selector never showed it as one to pick.
            if (party !== 'you') expect(shown, `selector ${label}`).toBe(false);
            // And R3 refuses it, whenever the prompt takes the answer at all.
            const value = (answer as { choice?: string }).choice;
            // A question's answer picking a label it doesn't offer is refused by its shape, not by
            // the allowance.
            const picked = (answer as { answers?: Record<string, { picked?: string[] }> }).answers
              ?.q1?.picked;
            const offers =
              value === undefined
                ? (picked ?? []).every((label) => ['Red', 'Blue'].includes(label))
                : value === HAND_BACK ||
                  ((test.prompt as { choices?: { value: string }[] }).choices ?? []).some(
                    (one) => one.value === value,
                  );
            if (party !== 'you' && offers) expect(r3, `R3 ${label}`).toBe(false);
          }
          trials += 1;
        }
      }
    }
    return trials;
  }
}

describe('the allowance at every boundary', () => {
  it('is the same for the selector, R3, the router and the owner', async () => {
    expect(await agree(CASES)).toBeGreaterThan(200);
  });

  it('is the same over generated prompts: hints, effects, marks, answerIn, signals and parties', async () => {
    const cases = generated(0x5eed, 24);
    // The generator reaches every kind, hint, answerIn and mark it varies, however it is seeded.
    const kinds = new Set(cases.map(({ prompt }) => (prompt as { kind: string }).kind));
    expect([...kinds].sort()).toEqual(['approval', 'plan', 'question']);
    expect(new Set(cases.map(({ prompt }) => (prompt as { answerIn: string }).answerIn))).toEqual(
      new Set(['api', 'terminal', 'both']),
    );
    expect(new Set(cases.map(({ signals }) => signals))).toEqual(new Set([true, false]));
    expect(await agree(cases)).toBeGreaterThan(300);
  }, 60_000);
});
