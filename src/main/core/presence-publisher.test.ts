import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CanvasId } from '../../shared/canvas';
import type { Message } from '../../shared/model/messages';
import type { NeedsItem } from '../../shared/model/needs';
import type { Run } from '../../shared/model/run';
import type { Session } from '../../shared/model/session';
import { MAX_PRESENCE_COUNT, Presence } from './presence';
import type { PresenceCanvas, PresenceCounts } from './presence-publisher';
import { countPresence, PRESENCE_EVERY_MS, PresencePublisher } from './presence-publisher';

/*
 * The core's presence (B14 §9 C5): one whole snapshot, sent first before init answers, then at
 * most one per PRESENCE_EVERY_MS (trailing) when what it counts changed, each a revision more.
 */

const IDLE: PresenceCounts = { working: 0, runs: 0, jobs: 0, needs: 0, awake: false };

let counts: PresenceCounts;
let sent: Presence[];

beforeEach(() => {
  vi.useFakeTimers();
  counts = IDLE;
  sent = [];
});
afterEach(() => {
  vi.useRealTimers();
});

function publisher(): PresencePublisher {
  return new PresencePublisher({
    count: () => counts,
    send: (snapshot) => {
      sent.push(Presence.parse(snapshot));
    },
  });
}

it('sends its first snapshot whole at once, revision 0, even when nothing goes on', () => {
  publisher().start();
  expect(sent).toEqual([{ revision: 0, ...IDLE, busy: false }]);
});

it('coalesces changes into one trailing snapshot per period, and sends nothing that is the same', () => {
  const presence = publisher();
  presence.start();
  counts = { ...IDLE, working: 1, awake: true };
  presence.changed();
  counts = { ...IDLE, working: 2, awake: true };
  presence.changed();
  vi.advanceTimersByTime(PRESENCE_EVERY_MS - 1);
  expect(sent).toHaveLength(1);
  vi.advanceTimersByTime(1);
  expect(sent.at(-1)).toEqual({ revision: 1, ...IDLE, working: 2, busy: true, awake: true });
  // A change back and forth within a period: what it counts is as it was, so nothing is sent.
  presence.changed();
  vi.advanceTimersByTime(PRESENCE_EVERY_MS);
  expect(sent).toHaveLength(2);
});

it('answers now with what it counts this moment, sending it at once if it changed', () => {
  const presence = publisher();
  presence.start();
  counts = { ...IDLE, runs: 1 };
  presence.changed();
  // Before the period's end: the snapshot asked for now is the one sent, and the period's ends.
  expect(presence.now()).toEqual({ revision: 1, ...IDLE, runs: 1, busy: true });
  expect(sent.at(-1)).toEqual({ revision: 1, ...IDLE, runs: 1, busy: true });
  vi.advanceTimersByTime(PRESENCE_EVERY_MS);
  expect(sent).toHaveLength(2);
  // Unchanged: the last one, sending nothing.
  expect(presence.now()).toEqual({ revision: 1, ...IDLE, runs: 1, busy: true });
  expect(sent).toHaveLength(2);
});

it('caps every count, so a snapshot always parses', () => {
  const presence = publisher();
  counts = { working: 20_000, runs: 10_000, jobs: 12_345, needs: 99_999, awake: true };
  presence.start();
  expect(sent).toEqual([
    {
      revision: 0,
      working: MAX_PRESENCE_COUNT,
      runs: MAX_PRESENCE_COUNT,
      jobs: MAX_PRESENCE_COUNT,
      needs: MAX_PRESENCE_COUNT,
      busy: true,
      awake: true,
    },
  ]);
});

describe('what it counts', () => {
  const session = (status: Session['status']) => ({ status }) as Session;
  const canvas = (
    id: string,
    {
      run = { running: false, agents: {} },
      sessions = {},
      messages = [],
    }: { run?: Run; sessions?: Record<string, Session>; messages?: Partial<Message>[] },
  ) =>
    ({
      document: { id: id as CanvasId },
      engine: { run: { snapshot: () => run }, sessions: { snapshot: () => sessions } },
      messages: { active: () => messages as Message[] },
    }) satisfies PresenceCanvas;

  it('counts turns, runs, jobs and your distinct Needs on every canvas, and what keeps it awake', () => {
    const one = canvas('one', {
      sessions: { a: session('idle'), b: session('working'), c: session('waiting') },
      messages: [
        // Being handed to an idle session: a job. One queued behind a turn is that turn's.
        { kind: 'text', state: 'delivering', to: 'agent:a' },
        { kind: 'text', state: 'delivering', to: 'agent:b' },
        { kind: 'text', state: 'pending', to: 'agent:a' },
      ],
    });
    const two = canvas('two', {
      run: { running: true, agents: { d: { status: 'asking', outcomes: {} } } },
    });
    const items: Record<string, Pick<NeedsItem, 'id' | 'for'>[]> = {
      one: [
        { id: 'shared-setup', for: 'you' },
        { id: 'shared-setup', for: 'you' },
        { id: 'lead-copy', for: 'agent:lead' },
      ],
      two: [{ id: 'shared-setup', for: 'you' }],
    };
    expect(
      countPresence({
        canvases: () => [one, two],
        needs: (id) => items[id] ?? [],
        jobs: () => 2,
      }),
    ).toEqual({ working: 2, runs: 1, jobs: 3, needs: 2, awake: true });
  });

  it('keeps awake only for what goes on without you', () => {
    const waitingForYou = canvas('one', {
      run: {
        running: true,
        agents: {
          ok: { status: 'asking', outcomes: {} },
          // A delay held by a pause moves nothing.
          held: { status: 'waiting', until: 1, paused: true, outcomes: {} },
        },
      },
      sessions: { a: session('waiting') },
    });
    const sources = { needs: () => [], jobs: () => 0 };
    expect(countPresence({ ...sources, canvases: () => [waitingForYou] })).toMatchObject({
      awake: false,
    });
    const delayed = canvas('two', {
      run: { running: true, agents: { later: { status: 'waiting', until: 1, outcomes: {} } } },
    });
    expect(countPresence({ ...sources, canvases: () => [delayed] })).toMatchObject({
      awake: true,
    });
    // A run stopped holds no timer that moves it.
    const stopped = canvas('three', {
      run: { running: false, agents: { later: { status: 'waiting', until: 1, outcomes: {} } } },
    });
    expect(countPresence({ ...sources, canvases: () => [stopped] })).toMatchObject({
      awake: false,
    });
  });

  it.each(['idle', 'waiting', 'working'] as const)(
    'counts reported background tasks as jobs without changing awake for a %s session',
    (status) => {
      const agent = {
        ...session(status),
        tasks: [
          { id: 'server', description: 'Dev server', kind: 'command' as const },
          { id: 'helper', description: 'Helper', kind: 'agent' as const },
        ],
      };
      const sources = {
        canvases: () => [canvas('one', { sessions: { a: agent } })],
        needs: () => [],
        jobs: () => 0,
      };
      expect(countPresence(sources)).toEqual({
        working: status === 'idle' ? 0 : 1,
        runs: 0,
        jobs: 2,
        needs: 0,
        awake: status === 'working',
      });
      agent.tasks = [];
      expect(countPresence(sources)).toMatchObject({ jobs: 0, awake: status === 'working' });
    },
  );
});

it('sends nothing once closed, and a failing host never stops it counting', () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  let fail = true;
  const presence = new PresencePublisher({
    count: () => counts,
    send: (snapshot) => {
      if (fail) throw new Error('the link is gone');
      sent.push(snapshot);
    },
  });
  presence.start();
  expect(errors).toHaveBeenCalledOnce();
  fail = false;
  counts = { ...IDLE, jobs: 1, awake: true };
  presence.changed();
  vi.advanceTimersByTime(PRESENCE_EVERY_MS);
  expect(sent).toEqual([{ revision: 1, ...IDLE, jobs: 1, busy: true, awake: true }]);
  counts = IDLE;
  presence.changed();
  presence.close();
  vi.advanceTimersByTime(PRESENCE_EVERY_MS);
  expect(sent).toHaveLength(1);
  errors.mockRestore();
});
