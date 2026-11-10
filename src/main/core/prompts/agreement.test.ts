import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Catalog } from '../../../shared/adapter';
import type { LeadGrants } from '../../../shared/api/ops/leads';
import type { CanvasId } from '../../../shared/canvas';
import type { NodeLike } from '../../../shared/model/canvas';
import type { PartyId } from '../../../shared/model/messages';
import { MADE_UP } from '../../../shared/test-made-up';
import { CanvasMemory } from '../../memory';
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

/*
 * B24 C4's core: one allowance used at every boundary. For generated prompts (kind, choice hints,
 * marks, signals), parties (you, the routed lead, a lead it isn't routed to, a granted outside
 * party, an ungranted one, a stranger) and answers, the Needs selector, R3 (rules.ts), the reply
 * router and the prompt owner accept exactly the same answers.
 */

const CANVAS = '7f3e4d5c-6b7a-4c8d-9e0f-1a2b3c4d5e6f' as CanvasId;
const WITH_API: Catalog = {
  ...MADE_UP,
  adapters: MADE_UP.adapters.map((adapter) => ({
    ...adapter,
    connections: adapter.connections.map((connection) => ({ ...connection, api: 'channel' })),
  })),
};
const KEY = '0f6b1e2a-3c4d-4e5f-8a9b-0c1d2e3f4a5b';
const ALL: LeadGrants = { questions: true, plans: true, approvals: true };

function agent(id: string, parentId?: string): NodeLike {
  return {
    id,
    type: 'agent',
    ...(parentId === undefined ? {} : { parentId }),
    data: { label: id, adapter: 'zed', connection: 'zed.acp' } as NodeLike['data'],
  };
}

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
}

const approval = (choices: readonly object[], more: object = {}) => ({
  kind: 'approval',
  title: 'Run it?',
  subject: { type: 'command', command: 'ls', cwd: '/w' },
  answerIn: 'api',
  choices,
  ...more,
});
const question = {
  kind: 'question',
  title: 'Which?',
  answerIn: 'api',
  questions: [
    {
      id: 'q1',
      header: 'H',
      text: 'Which?',
      options: [{ label: 'Red' }, { label: 'Blue' }],
      multiple: false,
      other: true,
    },
  ],
};
const plan = {
  kind: 'plan',
  title: 'Plan',
  plan: 'Do it',
  answerIn: 'api',
  choices: [choice('go', 'allow_once'), choice('stay', 'reject_once')],
};

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
  const origin: PromptOrigin = {
    canvas: CANVAS,
    agent: 'work',
    connection: test.signals ? 'zed.acp' : 'zed.free',
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
  if (item === undefined) throw new Error('not admitted');
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

describe('the allowance at every boundary', () => {
  it('is the same for the selector, R3, the router and the owner', async () => {
    let trials = 0;
    for (const test of CASES) {
      for (const { party, caller } of PARTIES) {
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
          const named = view?.by.includes(party) === true;
          const shown =
            'choice' in (answer as object)
              ? named &&
                view.choices.some(({ value }) => value === (answer as { choice: string }).choice)
              : undefined;

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
            if (shown !== undefined) expect(shown, `selector ${label}`).toBe(true);
          } else if (!viaOwner) {
            // Refused by the allowance: R3 refuses it too wherever it speaks to a choice, and the
            // selector never showed it as one to pick.
            if (shown !== undefined && party !== 'you')
              expect(shown, `selector ${label}`).toBe(false);
            // And R3 refuses it, whenever the prompt takes the answer at all.
            const value = (answer as { choice?: string }).choice;
            const offers =
              value === undefined ||
              value === HAND_BACK ||
              ((test.prompt as { choices?: { value: string }[] }).choices ?? []).some(
                (one) => one.value === value,
              );
            if (party !== 'you' && offers) expect(r3, `R3 ${label}`).toBe(false);
          }
          trials += 1;
        }
      }
    }
    expect(trials).toBeGreaterThan(200);
  });
});
