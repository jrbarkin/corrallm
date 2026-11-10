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
  });
  owner = new PromptOwner({
    catalog: WITH_API,
    canvas: () => ({ messages, nodes: NODES }),
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

  it('offers a lead no more than MAX_WAITING open copies', () => {
    for (let n = 0; n < 25; n += 1) {
      raise(`${String(n).padStart(8, '0')}-3c4d-4e5f-8a9b-0c1d2e3f4a5b`);
    }
    expect(copies().length).toBeLessThanOrEqual(20);
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
