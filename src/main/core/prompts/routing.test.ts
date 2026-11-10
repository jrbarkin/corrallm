import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Catalog } from '../../../shared/adapter';
import type { LeadGrants } from '../../../shared/api/ops/leads';
import { LEAD_ANSWER_SECONDS, LEAD_DENIALS } from '../../../shared/api/limits';
import type { CanvasId } from '../../../shared/canvas';
import type { NodeLike } from '../../../shared/model/canvas';
import type { PromptAnswer } from '../../../shared/model/prompts';
import { MADE_UP } from '../../../shared/test-made-up';
import { CanvasMemory } from '../../memory';
import type { PromptAnswers } from '../../sessions/connector';
import type { PromptOrigin } from '../../sessions/manager';
import { OpFailure } from '../call';
import type { OpContext } from '../call';
import { MessageStore, MessageTable } from '../delivery/messages';
import type { Store } from '../store/store';
import { openTestStore } from '../store/test-store';
import { HAND_BACK } from './grants';
import { PromptOwner } from './owner';
import type { RouteChange } from './owner';

/*
 * B24 C3, C4, C7: a team's prompts routed to the nearest ancestor lead granted their kind (and to
 * you at once), answered within the one allowance, handed back, timed out and cut off.
 */

const CANVAS = '7f3e4d5c-6b7a-4c8d-9e0f-1a2b3c4d5e6f' as CanvasId;
const WITH_API: Catalog = {
  ...MADE_UP,
  adapters: MADE_UP.adapters.map((adapter) => ({
    ...adapter,
    connections: adapter.connections.map((connection) => ({ ...connection, api: 'channel' })),
  })),
};
const SIGNALLING = 'zed.acp';
const QUIET = 'zed.free';

function agent(id: string, parentId?: string): NodeLike {
  return {
    id,
    type: 'agent',
    ...(parentId === undefined ? {} : { parentId }),
    data: { label: id.toUpperCase(), adapter: 'zed', connection: SIGNALLING } as NodeLike['data'],
  };
}

const NODES: NodeLike[] = [agent('top'), agent('mid', 'top'), agent('work', 'mid'), agent('free')];
const ALL: LeadGrants = { questions: true, plans: true, approvals: true };
const KEYS = [
  '0f6b1e2a-3c4d-4e5f-8a9b-0c1d2e3f4a5b',
  '1a7c2f3b-4d5e-4f60-9b1c-2d3e4f5a6b7c',
  '2b8d3a4c-5e6f-4071-8c2d-3e4f5a6b7c8d',
  '3c9e4b5d-6f70-4182-9d3e-4f5a6b7c8d9e',
];

const yes = { value: 'yes', label: 'Yes', hint: 'allow_once', effects: {} };
const no = { value: 'no', label: 'No', hint: 'reject_once', effects: {} };
const always = { value: 'always', label: 'Always', hint: 'allow_always', effects: {} };
const approval = {
  kind: 'approval',
  title: 'Run it?',
  subject: { type: 'command', command: 'private-command-text', cwd: '/work' },
  answerIn: 'api',
  choices: [yes, no, always],
};
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

let profile: string;
let database: Store;
let messages: MessageStore;
let owner: PromptOwner;
let grants: Map<string, LeadGrants>;
let grantees: string[];
let nodes: NodeLike[];
let timers: { run: () => void; ms: number; stopped: boolean }[];
let moves: RouteChange[];
let answered: [string, PromptAnswer][];

function handle(): PromptAnswers {
  return {
    answer: (key, answer) => {
      answered.push([key, answer]);
    },
    decline: () => undefined,
    dismiss: () => undefined,
  };
}

function origin(agentId: string, connection = SIGNALLING): PromptOrigin {
  return {
    canvas: CANVAS,
    agent: agentId,
    connection,
    generation: 1,
    live: true,
    startMode: 'plan',
    answers: handle(),
  };
}

let next = 0;
/** Raises `prompt` from `agentId` on `connection`, and the item it waits as. */
function raise(agentId: string, prompt: object = approval, connection = SIGNALLING) {
  const key = KEYS[next++ % KEYS.length] ?? '';
  owner.raised(origin(agentId, connection), { type: 'prompt', key, prompt });
  const item = owner.items(CANVAS).at(-1);
  if (item === undefined) throw new Error('not admitted');
  return item;
}

function ctx(by: string): OpContext {
  return {
    by,
    caller:
      by === 'you' ? { kind: 'human', window: 'host' } : { kind: 'agent', agent: by.slice(6) },
    signal: new AbortController().signal,
    noReturn: vi.fn(),
  } as unknown as OpContext;
}

async function reply(to: string, given: unknown, by: string) {
  try {
    return await owner.answer(CANVAS, to, given, ctx(by));
  } catch (error) {
    if (error instanceof OpFailure) return { code: error.code, sentence: error.message };
    throw error;
  }
}

const seenBy = (party: string, to: string) =>
  owner.items(CANVAS, 'token', party as `agent:${string}`).find((item) => item.id === to);

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-routing-'));
  database = await openTestStore(profile);
  messages = new MessageStore(
    CANVAS,
    new MessageTable(database, new CanvasMemory(database)),
    () => 1000,
  );
  await messages.load();
  grants = new Map([
    ['top', ALL],
    ['mid', ALL],
  ]);
  grantees = [];
  nodes = [...NODES];
  timers = [];
  moves = [];
  answered = [];
  next = 0;
  owner = new PromptOwner({
    catalog: WITH_API,
    canvas: () => ({ messages, nodes }),
    generationOf: () => 1,
    changed: () => undefined,
    notice: () => undefined,
    leads: { grantsOf: (_canvas, id) => grants.get(id) },
    grantees: () => grantees,
    timer: (run, ms) => {
      const timer = { run, ms, stopped: false };
      timers.push(timer);
      return () => {
        timer.stopped = true;
      };
    },
    routed: (change) => moves.push(change),
    now: () => 5_000,
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await database.close();
  await rm(profile, { recursive: true, force: true });
});

describe('routing', () => {
  it('routes a team’s prompt to the nearest granted ancestor, and to you at once', () => {
    const item = raise('work');
    expect(item.by).toEqual(['you', 'agent:mid']);
    expect(item.routed).toEqual({ to: 'agent:mid', until: 5_000 + LEAD_ANSWER_SECONDS * 1000 });
    expect(moves).toMatchObject([{ agent: 'work', to: 'mid', why: 'raised' }]);
    // Yours is not removed because a lead holds it.
    expect(item.choices.map(({ value }) => value)).toEqual(['yes', 'no', 'always']);
  });

  it('gives choices to the routed lead alone', () => {
    const { id } = raise('work');
    expect(seenBy('agent:mid', id)?.choices.map(({ value }) => value)).toEqual([
      'yes',
      'no',
      HAND_BACK,
    ]);
    expect(seenBy('agent:top', id)?.choices).toEqual([]);
    expect(owner.items(CANVAS, 'token').find((one) => one.id === id)?.choices).toEqual([]);
  });

  it('skips a lead not granted the prompt’s kind, and routes a question where it is', () => {
    grants.set('mid', { questions: false, plans: false, approvals: false });
    expect(raise('work').by).toEqual(['you', 'agent:top']);
    grants.set('mid', { questions: true, plans: false, approvals: false });
    owner.reroute(CANVAS);
    // The first prompt moves away from nobody: mid never held an approval's route.
    expect(raise('work', question).by).toEqual(['you', 'agent:mid']);
  });

  it('routes nothing in a terminal, past an agent no one leads, or for a lead on a connection with no API', () => {
    expect(raise('free').by).toEqual(['you']);
    nodes = nodes.map((node) =>
      node.id === 'mid'
        ? {
            ...node,
            data: { ...node.data, connection: 'yak.terminal', adapter: 'yak' } as NodeLike['data'],
          }
        : node,
    );
    expect(raise('work').by).toEqual(['you', 'agent:top']);
  });

  it('never routes a lead’s own prompt into its team, only to its ancestors', () => {
    expect(raise('mid').by).toEqual(['you', 'agent:top']);
    expect(raise('top').by).toEqual(['you']);
  });

  it('routes to you alone where the ancestry loops', () => {
    nodes = [agent('x', 'y'), agent('y', 'x')];
    grants.set('x', ALL);
    grants.set('y', ALL);
    expect(raise('x').by).toEqual(['you']);
  });
});

describe('answering as the lead', () => {
  it('allows once, recorded as the lead’s, and the first answer wins', async () => {
    const { id } = raise('work');
    expect(await reply(id, { choice: 'yes' }, 'agent:mid')).toMatchObject({ outcome: 'answered' });
    expect(answered).toHaveLength(1);
    const record = messages.all().find((one) => one.kind === 'settled');
    expect(record).toMatchObject({ by: 'agent:mid' });
    expect(record?.body).toMatch(/allowed WORK’s command once/);
    expect(record?.body).not.toContain('private-command-text');
    expect(await reply(id, { choice: 'no' }, 'you')).toMatchObject({ code: 'conflict' });
  });

  it('refuses always, feedback, own words, a choice not offered, and any party not named', async () => {
    const { id } = raise('work');
    for (const given of [
      { choice: 'always' },
      { choice: 'yes', feedback: 'and more' },
      { answers: { q1: { text: 'x' } } },
      { choice: 'absent' },
    ]) {
      expect(await reply(id, given, 'agent:mid'), JSON.stringify(given)).toMatchObject({
        code: 'refused',
      });
    }
    expect(await reply(id, { choice: 'yes' }, 'agent:top')).toMatchObject({ code: 'refused' });
    expect(await reply(id, { choice: 'yes' }, 'outside:orchestrator')).toMatchObject({
      code: 'refused',
    });
    expect(answered).toEqual([]);
  });

  it('may only reject on a worker whose connection reports no signals', async () => {
    const { id } = raise('work', approval, QUIET);
    expect(await reply(id, { choice: 'yes' }, 'agent:mid')).toMatchObject({ code: 'refused' });
    expect(await reply(id, { choice: 'no' }, 'agent:mid')).toMatchObject({ outcome: 'answered' });
  });

  it('answers a question by its labels, and refuses a lead no longer granted', async () => {
    const { id } = raise('work', question);
    grants.delete('mid');
    expect(await reply(id, { answers: { q1: { picked: ['Red'] } } }, 'agent:mid')).toMatchObject({
      code: 'refused',
    });
    grants.set('mid', ALL);
    expect(await reply(id, { answers: { q1: { picked: ['Red'] } } }, 'agent:mid')).toMatchObject({
      outcome: 'answered',
    });
  });

  it('lets a granted outside party answer an approval once, never a question', async () => {
    grantees = ['orchestrator'];
    const a = raise('work');
    expect(a.by).toEqual(['you', 'agent:mid', 'outside:orchestrator']);
    expect(await reply(a.id, { choice: 'always' }, 'outside:orchestrator')).toMatchObject({
      code: 'refused',
    });
    expect(await reply(a.id, { choice: HAND_BACK }, 'outside:orchestrator')).toMatchObject({
      code: 'refused',
    });
    expect(await reply(a.id, { choice: 'yes' }, 'outside:orchestrator')).toMatchObject({
      outcome: 'answered',
    });
    const q = raise('work', question);
    expect(q.by).not.toContain('outside:orchestrator');
  });

  it('fails an answer whose route moved while its record was written, and gives nothing', async () => {
    const { id } = raise('work');
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const durable = messages.durable.bind(messages);
    vi.spyOn(messages, 'durable').mockImplementationOnce(async () => {
      await held;
      await durable();
    });
    const pending = reply(id, { choice: 'yes' }, 'agent:mid');
    // The deadline passes while the record is being written.
    timers[0]?.run();
    release();
    expect(await pending).toMatchObject({ code: 'conflict' });
    expect(answered).toEqual([]);
    expect(
      messages.all().find((one) => one.settled !== undefined && one.state !== 'withdrawn'),
    ).toBeUndefined();
  });
});

describe('hand back and the deadline', () => {
  it('moves the route strictly up, then to you, and never offers a passed party again', async () => {
    const { id } = raise('work');
    expect(await reply(id, { choice: HAND_BACK }, 'agent:mid')).toMatchObject({
      outcome: 'handed-back',
    });
    expect(owner.items(CANVAS)[0]?.by).toEqual(['you', 'agent:top']);
    expect(answered).toEqual([]);
    expect(await reply(id, { choice: HAND_BACK }, 'agent:top')).toMatchObject({
      outcome: 'handed-back',
    });
    expect(owner.items(CANVAS)[0]?.by).toEqual(['you']);
    // Even a lead promoted later below the passed one is not offered it.
    grants.set('work', ALL);
    owner.reroute(CANVAS);
    expect(owner.items(CANVAS)[0]?.by).toEqual(['you']);
    expect(await reply(id, { choice: HAND_BACK }, 'agent:mid')).toMatchObject({ code: 'refused' });
  });

  it('acts as a hand-back at the deadline, and tells you once, value-free', () => {
    raise('work');
    expect(timers[0]).toMatchObject({ ms: LEAD_ANSWER_SECONDS * 1000, stopped: false });
    timers[0]?.run();
    expect(owner.items(CANVAS)[0]?.by).toEqual(['you', 'agent:top']);
    expect(timers[0]?.stopped).toBe(true);
    const told = messages.all().filter((one) => one.to === 'you');
    expect(told.map((one) => one.body)).toEqual([expect.stringMatching(/ran out of time on WORK/)]);
    expect(JSON.stringify(told)).not.toContain('private-command-text');
  });

  it('stops the timer when you answer first, and tells the copy path it ended', async () => {
    const { id } = raise('work');
    expect(await reply(id, { choice: 'no' }, 'you')).toMatchObject({ outcome: 'answered' });
    expect(timers[0]?.stopped).toBe(true);
    expect(moves.at(-1)).toMatchObject({ why: 'ended', how: 'by-you', from: 'mid' });
  });

  it('moves a prompt away from a lead that lost authority, and tells the copy path', () => {
    raise('work');
    grants.delete('mid');
    owner.reroute(CANVAS);
    expect(owner.items(CANVAS)[0]?.by).toEqual(['you', 'agent:top']);
    expect(moves.at(-1)).toMatchObject({ from: 'mid', to: 'top', why: 'authority' });
  });
});

describe('a route when the ancestry or the grants change', () => {
  const moveWork = (parentId?: string) => {
    nodes = nodes.map((node) =>
      node.id === 'work'
        ? { id: node.id, type: node.type, data: node.data, ...(parentId ? { parentId } : {}) }
        : node,
    ) as NodeLike[];
  };

  it('stops the old lead answering a worker moved off its team, and re-routes to the new team’s lead', () => {
    const { id } = raise('work');
    moveWork('free');
    grants.set('free', ALL);
    // At once, before any reroute: the old lead is no longer above the worker.
    expect(owner.refusal(CANVAS, id, 'agent:mid', { choice: 'yes' })).toBeDefined();
    expect(seenBy('agent:mid', id)?.choices).toEqual([]);
    expect(owner.items(CANVAS)[0]?.by).toEqual(['you']);
    owner.reroute(CANVAS);
    expect(owner.items(CANVAS)[0]?.by).toEqual(['you', 'agent:free']);
    expect(moves.at(-1)).toMatchObject({ from: 'mid', to: 'free', why: 'authority' });
    expect(owner.refusal(CANVAS, id, 'agent:free', { choice: 'yes' })).toBeUndefined();
  });

  it('goes to you alone when the worker leaves every team', () => {
    const { id } = raise('work');
    moveWork();
    owner.reroute(CANVAS);
    expect(owner.items(CANVAS)[0]?.by).toEqual(['you']);
    expect(owner.items(CANVAS)[0]?.routed).toBeUndefined();
    expect(owner.refusal(CANVAS, id, 'agent:top', { choice: 'yes' })).toBeDefined();
  });

  it('keeps a route where it is when a nearer lead is granted later (routes only go up)', () => {
    grants.delete('mid');
    raise('work');
    expect(owner.items(CANVAS)[0]?.by).toEqual(['you', 'agent:top']);
    const before = moves.length;
    grants.set('mid', ALL);
    owner.reroute(CANVAS);
    expect(owner.items(CANVAS)[0]?.by).toEqual(['you', 'agent:top']);
    expect(moves).toHaveLength(before);
  });

  it('never routes back to a lead it left, even when its grant returns', () => {
    raise('work');
    grants.delete('mid');
    owner.reroute(CANVAS);
    expect(owner.items(CANVAS)[0]?.by).toEqual(['you', 'agent:top']);
    grants.delete('top');
    owner.reroute(CANVAS);
    expect(owner.items(CANVAS)[0]?.by).toEqual(['you']);
    grants.set('top', ALL);
    grants.set('mid', ALL);
    owner.reroute(CANVAS);
    expect(owner.items(CANVAS)[0]?.by).toEqual(['you']);
  });

  it('tells the copy path who answered or handed back', async () => {
    const { id } = raise('work');
    await reply(id, { choice: 'yes' }, 'agent:mid');
    expect(moves.at(-1)).toMatchObject({
      why: 'ended',
      how: 'answered',
      from: 'mid',
      by: 'agent:mid',
    });
    const second = raise('work');
    await reply(second.id, { choice: HAND_BACK }, 'agent:mid');
    expect(moves.at(-1)).toMatchObject({
      why: 'handed-back',
      from: 'mid',
      to: 'top',
      by: 'agent:mid',
    });
  });
});

describe('LEAD_DENIALS', () => {
  async function refuseOne() {
    const { id } = raise('work');
    await reply(id, { choice: 'no' }, 'agent:mid');
  }

  it('cuts a lead off from a worker after consecutive rejections, then to you alone', async () => {
    for (let n = 0; n < LEAD_DENIALS; n += 1) await refuseOne();
    await new Promise((resolve) => {
      queueMicrotask(() => {
        resolve(undefined);
      });
    });
    const after = raise('work');
    expect(after.by).toEqual(['you']);
    expect(messages.all().filter((one) => one.body.includes('in a row'))).toHaveLength(1);
  });

  it('starts again after an allow in between', async () => {
    await refuseOne();
    await refuseOne();
    const { id } = raise('work');
    await reply(id, { choice: 'yes' }, 'agent:mid');
    await refuseOne();
    await refuseOne();
    expect(raise('work').by).toEqual(['you', 'agent:mid']);
  });

  it('starts again when you answer one of the worker’s prompts', async () => {
    for (let n = 0; n < LEAD_DENIALS; n += 1) await refuseOne();
    const open = raise('work');
    await reply(open.id, { choice: 'no' }, 'you');
    await new Promise((resolve) => {
      queueMicrotask(() => {
        resolve(undefined);
      });
    });
    expect(raise('work').by).toEqual(['you', 'agent:mid']);
  });
});
