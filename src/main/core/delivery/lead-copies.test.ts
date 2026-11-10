import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Catalog } from '../../../shared/adapter';
import type { LeadGrants } from '../../../shared/api/ops/leads';
import type { CanvasId } from '../../../shared/canvas';
import type { NodeLike } from '../../../shared/model/canvas';
import { isLeadCopy, isLeadNotice } from '../../../shared/model/messages';
import { MADE_UP } from '../../../shared/test-made-up';
import { CanvasMemory } from '../../memory';
import { PromptOwner } from '../prompts/owner';
import type { Store } from '../store/store';
import { openTestStore } from '../store/test-store';
import { LeadCopies } from './lead-copies';
import { MessageStore, MessageTable } from './messages';

/*
 * B24 C5: a routed lead's copy is a host-built card; it is withdrawn if it never reached the lead,
 * noticed once if it did, and recovered after a crash without being sent again.
 */

const CANVAS = '7f3e4d5c-6b7a-4c8d-9e0f-1a2b3c4d5e6f' as CanvasId;
const WITH_API: Catalog = {
  ...MADE_UP,
  adapters: MADE_UP.adapters.map((adapter) => ({
    ...adapter,
    connections: adapter.connections.map((connection) => ({ ...connection, api: 'channel' })),
  })),
};
const ALL: LeadGrants = { questions: true, plans: true, approvals: true };
const CANARY = 'CANARY-7c41';

function agent(id: string, label: string, parentId?: string): NodeLike {
  return {
    id,
    type: 'agent',
    ...(parentId === undefined ? {} : { parentId }),
    data: { label, adapter: 'zed', connection: 'zed.acp' } as NodeLike['data'],
  };
}

const NODES = [
  agent('top', 'Top'),
  agent('mid', 'Mid', 'top'),
  agent('work', `Work ${CANARY}`, 'mid'),
];
/** The nodes the owner reads: a test may nest its own. */
let nodes: NodeLike[] = NODES;

let profile: string;
let database: Store;
let messages: MessageStore;
let owner: PromptOwner;
let grants: Map<string, LeadGrants>;

async function load(): Promise<MessageStore> {
  const store = new MessageStore(
    CANVAS,
    new MessageTable(database, new CanvasMemory(database)),
    () => 1000,
  );
  await store.load();
  return store;
}

function wire(): void {
  const copies = new LeadCopies({
    messages: () => messages,
    schedule: () => undefined,
    routeOf: (canvas, need) => owner.routeOf(canvas, need),
    unreachable: (canvas, need, lead) => {
      owner.unreachable(canvas, need, lead);
    },
  });
  owner = new PromptOwner({
    catalog: WITH_API,
    canvas: () => ({ messages, nodes }),
    generationOf: () => 1,
    changed: () => undefined,
    notice: () => undefined,
    leads: { grantsOf: (_canvas, id) => grants.get(id) },
    timer: () => () => undefined,
    grantees: () => grantees,
    routed: (change) => {
      copies.routed(change);
    },
    wake: (wake) => {
      copies.wake(wake);
    },
    now: () => 5_000,
  });
  live = copies;
}
let live: LeadCopies;
let grantees: string[] = [];

function raise(key: string) {
  owner.raised(
    {
      canvas: CANVAS,
      agent: 'work',
      connection: 'zed.acp',
      generation: 1,
      live: true,
      startMode: 'plan',
      answers: { answer: () => undefined, decline: () => undefined, dismiss: () => undefined },
    },
    {
      type: 'prompt',
      key,
      prompt: {
        kind: 'approval',
        title: `Run ${CANARY}?`,
        summary: CANARY,
        subject: { type: 'command', command: `echo ${CANARY}`, cwd: '/w' },
        answerIn: 'api',
        choices: [
          { value: 'yes', label: `Yes ${CANARY}`, hint: 'allow_once', effects: {} },
          { value: 'no', label: 'No', hint: 'reject_once', effects: {} },
        ],
      },
    },
  );
  const item = owner.items(CANVAS).at(-1);
  if (item === undefined) throw new Error('not admitted');
  return item.id;
}

const KEY = '0f6b1e2a-3c4d-4e5f-8a9b-0c1d2e3f4a5b';
const KEY2 = '1a7c2f3b-4d5e-4f60-9b1c-2d3e4f5a6b7c';
const copies = () => messages.all().filter((one) => isLeadCopy(one));
const notices = () => messages.all().filter((one) => isLeadNotice(one));

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-copies-'));
  database = await openTestStore(profile);
  messages = await load();
  grantees = [];
  nodes = NODES;
  grants = new Map([
    ['top', ALL],
    ['mid', ALL],
  ]);
  wire();
});

afterEach(async () => {
  await database.close();
  await rm(profile, { recursive: true, force: true });
});

describe('a lead’s copy', () => {
  it('is one host-built turn, pending, to the routed lead, quoting nothing the worker said', () => {
    const need = raise(KEY);
    const [copy] = copies();
    expect(copies()).toHaveLength(1);
    expect(copy).toMatchObject({
      from: 'corrallm',
      to: 'agent:mid',
      kind: 'text',
      state: 'pending',
      purpose: { v: 1, type: 'lead-copy', need },
    });
    expect(copy?.body).toContain(need);
    expect(copy?.body).toContain(CANVAS);
    expect(copy?.body).toContain('hand-back');
    // No title, command, label, summary or agent name reaches the lead's turn (R29).
    expect(JSON.stringify(messages.all())).not.toContain(CANARY);
  });

  it('is sent only while its prompt still waits on that lead', () => {
    raise(KEY);
    const [copy] = copies();
    if (copy === undefined) throw new Error('no copy');
    expect(live.live(copy)).toBe(true);
    grants.delete('mid');
    owner.reroute(CANVAS);
    expect(live.live(copy)).toBe(false);
  });

  it('is withdrawn with nothing sent when its route moves before it reached the lead, and the next lead gets its own', () => {
    raise(KEY);
    grants.delete('mid');
    owner.reroute(CANVAS);
    expect(copies().map(({ to, state }) => [to, state])).toEqual([
      ['agent:mid', 'withdrawn'],
      ['agent:top', 'pending'],
    ]);
    expect(notices()).toEqual([]);
  });

  it('gets one notice, once, when the prompt ends after the copy reached the lead', async () => {
    const need = raise(KEY);
    const [copy] = copies();
    if (copy === undefined) throw new Error('no copy');
    messages.update(copy.id, { state: 'delivered' });
    await owner.answer(CANVAS, need, { choice: 'no' }, {
      by: 'you',
      caller: { kind: 'human', window: 'host' },
      signal: new AbortController().signal,
      noReturn: () => undefined,
    } as never);
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toMatchObject({ to: 'agent:mid', purpose: { type: 'lead-notice', need } });
    expect(notices()[0]?.body).toMatch(/the user answered it/);
    expect(JSON.stringify(notices())).not.toContain(CANARY);
    // A second end tells nothing more.
    owner.closed(CANVAS);
    expect(notices()).toHaveLength(1);
  });

  it('sends the lead that answered, or handed back, no notice of it', async () => {
    const need = raise(KEY);
    const [copy] = copies();
    if (copy === undefined) throw new Error('no copy');
    messages.update(copy.id, { state: 'delivered' });
    const as = (by: `agent:${string}`) =>
      ({
        by,
        caller: { kind: 'agent', agent: by.slice(6) },
        signal: new AbortController().signal,
        noReturn: () => undefined,
      }) as never;
    await owner.answer(CANVAS, need, { choice: 'hand-back' }, as('agent:mid'));
    expect(notices()).toEqual([]);
    const top = copies().find(({ to }) => to === 'agent:top');
    if (top === undefined) throw new Error('no copy for top');
    messages.update(top.id, { state: 'delivered' });
    await owner.answer(CANVAS, need, { choice: 'yes' }, as('agent:top'));
    expect(notices()).toEqual([]);
  });

  it('offers a lead no more than MAX_WAITING open copies', () => {
    for (let n = 0; n < 25; n += 1) {
      raise(`${String(n).padStart(8, '0')}-3c4d-4e5f-8a9b-0c1d2e3f4a5b`);
    }
    expect(copies().filter(({ to }) => to === 'agent:mid').length).toBeLessThanOrEqual(20);
    expect(copies().filter(({ to }) => to === 'agent:top').length).toBeLessThanOrEqual(20);
  });
});

describe('a lead it could not send a copy', () => {
  it('loses the route past MAX_WAITING open copies: the next lead above gets it, and the lead is passed', () => {
    let last = '';
    for (let n = 0; n < 22; n += 1) {
      last = raise(`${String(n).padStart(8, '0')}-3c4d-4e5f-8a9b-0c1d2e3f4a5b`);
    }
    expect(copies().filter(({ to }) => to === 'agent:mid')).toHaveLength(20);
    expect(owner.routeOf(CANVAS, last)).toBe('top');
    expect(
      copies().some(
        ({ to, purpose }) =>
          to === 'agent:top' && purpose?.type === 'lead-copy' && purpose.need === last,
      ),
    ).toBe(true);
  });

  it('with nobody above leaves the prompt with you alone', () => {
    grants.delete('top');
    let last = '';
    for (let n = 0; n < 22; n += 1) {
      last = raise(`${String(n).padStart(8, '0')}-3c4d-4e5f-8a9b-0c1d2e3f4a5b`);
    }
    expect(owner.routeOf(CANVAS, last)).toBeUndefined();
  });

  it('loses the route when its card is refused by the lead’s shell prefix or file-mention check', () => {
    const need = raise(KEY);
    const [copy] = copies();
    if (copy === undefined) throw new Error('no copy');
    messages.update(copy.id, { state: 'withdrawn', by: 'corrallm' });
    live.refused(copy);
    expect(owner.routeOf(CANVAS, need)).toBe('top');
    // A copy whose route had moved already changes nothing more.
    live.refused(copy);
    expect(owner.routeOf(CANVAS, need)).toBe('top');
  });
});

describe('copy and notice keys', () => {
  it('match exactly: a lead whose id starts another’s still gets its own copy', async () => {
    nodes = [
      agent('lead', 'Lead'),
      agent('lead2', 'Lead2', 'lead'),
      agent('work', 'Work', 'lead2'),
    ];
    grants = new Map([
      ['lead', ALL],
      ['lead2', ALL],
    ]);
    const need = raise(KEY);
    const [first] = copies();
    if (first === undefined) throw new Error('no copy');
    expect(first.to).toBe('agent:lead2');
    messages.update(first.id, { state: 'delivered' });
    await owner.answer(CANVAS, need, { choice: 'hand-back' }, {
      by: 'agent:lead2',
      caller: { kind: 'agent', agent: 'lead2' },
      signal: new AbortController().signal,
      noReturn: () => undefined,
    } as never);
    expect(copies().map(({ to, state }) => [to, state])).toEqual([
      ['agent:lead2', 'delivered'],
      ['agent:lead', 'pending'],
    ]);
  });

  it('notice only the lead that held the prompt, not one whose id extends its own', () => {
    nodes = [
      agent('lead2', 'Lead2'),
      agent('lead', 'Lead', 'lead2'),
      agent('work', 'Work', 'lead'),
    ];
    grants = new Map([
      ['lead', ALL],
      ['lead2', ALL],
    ]);
    const need = raise(KEY);
    const [copy] = copies();
    if (copy === undefined) throw new Error('no copy');
    expect(copy.to).toBe('agent:lead');
    messages.update(copy.id, { state: 'delivered' });
    // A copy kept for the farther lead2, once delivered to it, is its own business.
    messages.add(
      {
        from: 'corrallm',
        to: 'agent:lead2',
        kind: 'text',
        origin: 'party',
        body: 'old',
        state: 'delivered',
        purpose: { v: 1, type: 'lead-copy', need },
      },
      `lead-copy:${need}|lead2`,
    );
    owner.closed(CANVAS);
    expect(notices().map(({ to }) => to)).toEqual(['agent:lead']);
  });
});

describe('work per event', () => {
  /** Entries iterated by Maps and Sets while `run` does. */
  function iterated(run: () => void): number {
    let count = 0;
    const patch = (type: { prototype: Record<string | symbol, unknown> }): (() => void) => {
      const restore: (() => void)[] = [];
      for (const name of ['values', 'entries', 'keys', Symbol.iterator] as const) {
        const original = type.prototype[name] as (this: unknown) => Iterator<unknown>;
        type.prototype[name] = function (this: unknown): Iterator<unknown> {
          const inner = original.call(this);
          return {
            next: () => {
              const step = inner.next();
              if (step.done !== true) count += 1;
              return step;
            },
            [Symbol.iterator]() {
              return this;
            },
          } as Iterator<unknown>;
        };
        restore.push(() => {
          type.prototype[name] = original;
        });
      }
      return () => {
        restore.forEach((one) => {
          one();
        });
      };
    };
    const undoMap = patch(Map as never);
    const undoSet = patch(Set as never);
    try {
      run();
    } finally {
      undoMap();
      undoSet();
    }
    return count;
  }

  function backlog(n: number): void {
    for (let i = 0; i < n; i += 1) {
      messages.add({
        from: 'you',
        to: 'agent:other',
        kind: 'text',
        origin: 'party',
        body: `old ${String(i)}`,
        state: 'pending',
      });
    }
  }

  it('a routing event reads no more with a bigger backlog of messages', () => {
    raise(KEY2); // warm
    backlog(10);
    const small = iterated(() => {
      raise(KEY);
    });
    backlog(300);
    const big = iterated(() => {
      raise('3c9e4b5d-6f70-4182-9d3e-4f5a6b7c8d9e');
    });
    expect(big).toBeLessThanOrEqual(small + 4);
  });

  it('recovering a copy reads no more with a bigger backlog', async () => {
    const setup = async (n: number) => {
      messages = await load();
      wire();
      const need = raise(KEY);
      const [copy] = copies();
      if (copy === undefined) throw new Error('no copy');
      messages.update(copy.id, { state: 'delivered' });
      backlog(n);
      await messages.durable();
      return need;
    };
    await setup(10);
    const small = await (async () => {
      const again = await load();
      return iterated(() => {
        LeadCopies.recover(again);
      });
    })();
    // A second world, with a far bigger backlog.
    await database.close();
    await rm(profile, { recursive: true, force: true });
    profile = await mkdtemp(path.join(tmpdir(), 'corrallm-copies-'));
    database = await openTestStore(profile);
    await setup(400);
    const big = await (async () => {
      const again = await load();
      return iterated(() => {
        LeadCopies.recover(again);
      });
    })();
    expect(big).toBeLessThanOrEqual(small + 4);
  });
});

describe('after a crash', () => {
  it('withdraws a pending copy, leaves a delivering one unresolved, and notices a delivered one once', async () => {
    raise(KEY);
    raise(KEY2);
    const third = raise('2b8d3a4c-5e6f-4071-8c2d-3e4f5a6b7c8d');
    const [pending, delivering, delivered] = copies();
    if (!pending || !delivering || !delivered) throw new Error('no copies');
    messages.update(delivering.id, { state: 'delivering' });
    messages.update(delivered.id, { state: 'delivered' });
    await messages.durable();

    const again = await load();
    expect(LeadCopies.recover(again)).toBe(true);
    const states = again
      .all()
      .filter((one) => isLeadCopy(one))
      .map((one) => one.state);
    expect(states).toEqual(['withdrawn', 'unresolved', 'delivered']);
    const told = again.all().filter((one) => isLeadNotice(one));
    expect(told.map((one) => one.purpose)).toEqual(
      expect.arrayContaining([expect.objectContaining({ need: third })]),
    );
    expect(told).toHaveLength(2);
    // Once recovered, recovering again changes nothing and sends nothing more.
    LeadCopies.recover(again);
    expect(again.all().filter((one) => isLeadNotice(one))).toHaveLength(2);
  });
});

describe('an outside orchestrator you let answer approvals', () => {
  it('is woken once by a record for its wait, and told once when it ends unanswered by it', () => {
    grantees = ['orchestrator'];
    const need = raise(KEY);
    const woken = () => messages.all().filter((one) => one.to === 'outside:orchestrator');
    expect(woken()).toHaveLength(1);
    expect(woken()[0]).toMatchObject({ from: 'corrallm', kind: 'notice', state: 'delivered' });
    expect(woken()[0]?.body).toContain(need);
    expect(JSON.stringify(woken())).not.toContain(CANARY);
    owner.closed(CANVAS);
    expect(woken()).toHaveLength(2);
    owner.closed(CANVAS);
    expect(woken()).toHaveLength(2);
  });

  it('is not woken for a name you did not grant', () => {
    raise(KEY);
    expect(messages.all().filter((one) => one.to.startsWith('outside:'))).toEqual([]);
  });
});
