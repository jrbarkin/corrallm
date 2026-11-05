import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CanvasId } from '../../shared/canvas';
import type { NeedsItem } from '../../shared/model/needs';
import type { SessionMode } from '../../shared/session';
import type { Connector } from '../sessions/connector';
import { fakeConnector } from '../sessions/test-fake';
import type { Caller, OutsideCaller } from './caller';
import { createCore } from './core';
import type { Core } from './core';
import { expectRestorable, liveRunOf } from './engine/run/test-restore';
import { keepCanvases, readOnDisk } from './store/test-store';
import { CALLERS, NO_DESKTOP } from './test-registry';
import { legacyDirectories } from './workspaces/test-directories';

/*
 * B19 Design §9 C3 through core.call: what the core settles for an agent (a run hold's answer, a
 * native prompt's, an ask's end) is kept with the association the core resolved as it settled it,
 * and reaches the window as a typed display entry of that agent's, through one selector at the
 * transcript's read and its topic: yours alone, a token reaching the agent reading none of it,
 * nowhere, while you see each.
 */

const CANVAS = '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f' as CanvasId;
const YOU = CALLERS.you;
const ORCHESTRATOR: OutsideCaller = {
  kind: 'outside',
  token: 'write-token',
  name: 'orchestrator',
  access: 'write',
  merge: true,
  canvases: [CANVAS],
};

/** What you answer the Builder's OK with, in words: never in a record, its association or entry. */
const WORDS = 'private-change-words';

/**
 * The Builder writes a spec, asks for your OK on it, then builds; the Reviewer runs in Manual (its
 * CLI asks before it runs a command); the Linker reaches both; the Stranger neither.
 */
function canvasText(): string {
  const node = (id: string, label: string, x: number, extra: object = {}) => ({
    id,
    kind: 'agent',
    label,
    position: { x, y: 0 },
    adapter: 'claude-code',
    connection: 'claude-code.sdk',
    ...extra,
  });
  return JSON.stringify({
    format: 'corrallm',
    version: 2,
    id: CANVAS,
    nodes: [
      node('a', 'Builder', 0, {
        queue: [
          { id: 'spec', message: 'Write the spec' },
          { id: 'ok', approve: 'the spec' },
          { id: 'build', message: 'Build it' },
        ],
      }),
      node('b', 'Reviewer', 300, { settings: { 'claude-code': { mode: 'manual' } } }),
      node('l', 'Linker', 600),
      node('s', 'Stranger', 900),
    ],
    links: [{ agents: ['l', 'a'] }, { agents: ['l', 'b'] }],
  });
}

let profile: string;
const cores: Core[] = [];

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-records-'));
  const project = path.join(profile, 'project');
  await mkdir(project);
  const file = path.join(profile, 'team.corral');
  await writeFile(file, canvasText());
  await keepCanvases(profile, { [CANVAS]: { file, project } });
});

afterEach(async () => {
  expectRestorable();
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const core of cores.splice(0)) await core.close().catch(() => undefined);
  await rm(profile, { recursive: true, force: true });
});

async function start(
  connector: Connector<SessionMode> = fakeConnector({ mode: 'acceptEdits' }),
): Promise<Core> {
  const core = await createCore(
    {
      profile,
      app: { name: 'corrallm', version: '9.8.7' },
      check: true,
      distribution: 'local',
      directoryResolver: legacyDirectories,
      leads: (_canvas, id) => id === 'l',
      sessions: {
        // Its agent callers are made up: no session authority issued them.
        callers: () => true,
        connectors: { 'claude-code.sdk': connector },
        environment: () => Promise.resolve({}),
      },
      watchFolder: () => ({ close: () => undefined }),
    },
    NO_DESKTOP,
  );
  cores.push(core);
  const engine = await core.engines.open(CANVAS);
  // Kept to check that it restores (expectRestorable), given its canvas's nodes again to keep.
  liveRunOf(engine.run, engine.catalog, () => Date.now());
  engine.run.update(opened(core).document.nodes);
  return core;
}

async function ok<T = unknown>(core: Core, op: string, args: object, caller: Caller = YOU) {
  const result = await core.call(op as never, { canvas: CANVAS, ...args }, caller);
  if (!result.ok) throw new Error(`${op}: ${result.error.code}: ${result.error.sentence}`);
  return result.value as T;
}

async function needsOf(core: Core, caller: Caller = YOU): Promise<NeedsItem[]> {
  return (await ok<{ items: NeedsItem[] }>(core, 'needs', {}, caller)).items;
}

/** The first item waiting that `which` picks, once one does. */
async function waitingFor(core: Core, which: (item: NeedsItem) => boolean): Promise<NeedsItem> {
  let found: NeedsItem | undefined;
  await vi.waitFor(
    async () => {
      found = (await needsOf(core)).find(which);
      expect(found).toBeDefined();
    },
    { timeout: 10_000, interval: 10 },
  );
  if (found === undefined) throw new Error('Nothing waits');
  return found;
}

const isHold = (id: string) => (item: NeedsItem) => item.kind === 'hold' && item.agent === id;
const isPrompt = (id: string) => (item: NeedsItem) => item.kind === 'prompt' && item.agent === id;

function opened(core: Core) {
  const open = core.engines.canvas(CANVAS);
  if (open === undefined) throw new Error('The canvas is not open.');
  return open;
}

/** The association kept on disk with message `id`, as the profile's database holds it. */
function aboutOnDisk(id: string): unknown {
  const row = readOnDisk(profile, (disk) =>
    disk.prepare('SELECT about FROM message WHERE id = ?').get(id),
  ) as { about: string | null } | undefined;
  return row?.about === null || row?.about === undefined ? undefined : JSON.parse(row.about);
}

describe('what the core settles for an agent is kept with its association', () => {
  it('a run hold’s answer: its agent, its Needs item and the choice by key, never the words given', async () => {
    const core = await start();
    opened(core).engine.run.start();
    const hold = await waitingFor(core, isHold('a'));
    // Ask for changes, in words: the Builder makes them, then asks again.
    const changes = await ok<{ id: string }>(core, 'reply', {
      to: hold.id,
      answer: { text: WORDS },
    });
    const again = await waitingFor(core, (item) => isHold('a')(item) && item.id !== hold.id);
    const approved = await ok<{ id: string }>(core, 'reply', {
      to: again.id,
      answer: { choice: 'approve' },
    });
    expect(opened(core).messages.records('a')).toMatchObject([
      {
        message: { id: changes.id, kind: 'settled', to: 'you', by: 'you' },
        about: { v: 1, agent: 'a', need: hold.id, hold: { words: true } },
      },
      {
        message: { id: approved.id },
        about: { v: 1, agent: 'a', need: again.id, hold: { choice: 'approve' } },
      },
    ]);
    await opened(core).messages.durable();
    expect(aboutOnDisk(approved.id)).toEqual({
      v: 1,
      agent: 'a',
      need: again.id,
      hold: { choice: 'approve' },
    });
    const kept = JSON.stringify([aboutOnDisk(changes.id), aboutOnDisk(approved.id)]);
    expect(kept).not.toContain(WORDS);
    expect(kept).not.toContain('Your OK');
    // No other agent's window shows it.
    expect(opened(core).messages.records('b')).toEqual([]);
  });

  it('a native prompt’s answer: its agent and Needs item, shown by B13’s owner entry alone while the core runs', async () => {
    const core = await start();
    await ok(core, 'message', { to: 'b', body: 'Run the tests' });
    const prompt = await waitingFor(core, isPrompt('b'));
    const answered = await ok<{ id: string }>(core, 'reply', {
      to: prompt.id,
      answer: { choice: 'allow' },
    });
    await opened(core).messages.durable();
    expect(aboutOnDisk(answered.id)).toEqual({ v: 1, agent: 'b', need: prompt.id });
    expect(opened(core).messages.records('b')).toEqual([]);
  });

  it('an ask’s end: its recipient agent and the ask’s Needs item', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    const core = await start();
    // Held, so its ask waits unanswered until its deadline.
    await ok(core, 'run.pause', { target: { agent: 'a' } });
    const { id } = await ok<{ id: string }>(
      core,
      'ask',
      {
        to: 'a',
        questions: [
          {
            id: 'scope',
            header: 'Scope',
            text: 'How much of it?',
            options: [{ label: 'All' }, { label: 'Some' }],
            multiple: false,
            other: false,
          },
        ],
        deadlineSeconds: 60,
      },
      ORCHESTRATOR,
    );
    await vi.advanceTimersByTimeAsync(60_001);
    await vi.waitFor(() => {
      expect(opened(core).messages.records('a')).toHaveLength(1);
    });
    const [ended] = opened(core).messages.records('a');
    expect(ended).toMatchObject({
      message: {
        kind: 'settled',
        from: 'corrallm',
        to: 'outside:orchestrator',
        replyTo: id,
        settled: { outcome: { type: 'expired' } },
      },
      about: { v: 1, agent: 'a', need: `ask/${id}` },
    });
  });
});
