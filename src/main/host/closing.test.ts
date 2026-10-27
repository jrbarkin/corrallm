import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import type { MessageBoxOptions } from 'electron';

import type { CanvasId } from '../../shared/canvas';
import { countPresence, PresencePublisher } from '../core/presence-publisher';
import type { Presence } from '../core/presence';
import type { DraftsFlushed, ShutdownPrepared } from '../core/protocol';
import { Closing, QuitCoordinator, SYSTEM_BUDGET_MS } from './closing';
import type { QuitDeps, QuitWindow } from './closing';

function setup(answer = false) {
  const saving = Promise.withResolvers<undefined>();
  const deps = {
    save: vi.fn(() => saving.promise),
    abandon: vi.fn(() => Promise.resolve()),
    ask: vi.fn(() => Promise.resolve(answer)),
    done: vi.fn(),
  };
  return { closing: new Closing(deps), deps, saving };
}

describe('Closing', () => {
  it('holds the close until the run is saved, then closes', async () => {
    const { closing, deps, saving } = setup();
    expect(closing.request()).toBe(false);
    expect(deps.done).not.toHaveBeenCalled();
    saving.resolve(undefined);
    await vi.waitFor(() => {
      expect(deps.done).toHaveBeenCalledTimes(1);
    });
    // The close it asks for now goes through.
    expect(closing.request()).toBe(true);
    expect(deps.save).toHaveBeenCalledTimes(1);
  });

  it('asks whether to close anyway when saving fails, and closes if told to', async () => {
    const { closing, deps, saving } = setup(true);
    closing.request();
    saving.reject(new Error('The disk is full'));
    await vi.waitFor(() => {
      expect(deps.done).toHaveBeenCalledTimes(1);
    });
    expect(deps.ask).toHaveBeenCalledWith('The disk is full');
    expect(deps.abandon).toHaveBeenCalledExactlyOnceWith();
    expect(closing.request()).toBe(true);
  });

  it('stays open when told to, and tries again on the next close', async () => {
    const { closing, deps, saving } = setup(false);
    closing.request();
    saving.reject(new Error('The window did not finish saving its run before closing'));
    await vi.waitFor(() => {
      expect(deps.ask).toHaveBeenCalledTimes(1);
    });
    expect(deps.done).not.toHaveBeenCalled();
    expect(closing.busy).toBe(false);
    closing.request();
    expect(deps.save).toHaveBeenCalledTimes(2);
  });

  it('closes at once when asked again while it saves', async () => {
    const { closing, deps } = setup();
    closing.request();
    expect(closing.busy).toBe(true);
    expect(closing.request()).toBe(false);
    await vi.waitFor(() => {
      expect(deps.done).toHaveBeenCalledTimes(1);
    });
    expect(deps.abandon).toHaveBeenCalledExactlyOnceWith(true);
    expect(deps.ask).not.toHaveBeenCalled();
  });

  it('stays open, asking nothing, when its save decides not to close after all', async () => {
    const deps = {
      save: vi.fn(() => Promise.resolve(false)),
      abandon: vi.fn(() => Promise.resolve()),
      ask: vi.fn(() => Promise.resolve(true)),
      done: vi.fn(),
    };
    const closing = new Closing(deps);
    expect(closing.request()).toBe(false);
    await vi.waitFor(() => {
      expect(closing.busy).toBe(false);
    });
    expect(closing.approved).toBe(false);
    expect(deps.ask).not.toHaveBeenCalled();
    expect(deps.done).not.toHaveBeenCalled();
    expect(deps.abandon).not.toHaveBeenCalled();
  });
});

/*
 * The quit coordinator (B14 C2, C4, C10's main half), against a fake core, fake windows and a fake
 * message box: main's wiring of it to Electron and the core's link is index.test.ts's.
 */

const IDLE: Presence = {
  revision: 1,
  working: 0,
  runs: 0,
  jobs: 0,
  needs: 0,
  busy: false,
  awake: false,
  notify: true,
};
const busy = (counts: Partial<Presence>): Presence => ({
  ...IDLE,
  ...counts,
  busy: true,
  awake: true,
});
const WORKING = busy({ working: 3 });

interface FakeWindow extends QuitWindow {
  minimized: boolean;
  readonly restore: Mock<() => void>;
  readonly minimize: Mock<() => void>;
  readonly show: Mock<() => void>;
  readonly focus: Mock<() => void>;
  readonly close: Mock<() => void>;
}

function fakeWindow(id: number, minimized = false): FakeWindow {
  const window: FakeWindow = {
    webContents: { id },
    minimized,
    isMinimized: () => window.minimized,
    restore: vi.fn<() => void>(() => {
      window.minimized = false;
    }),
    minimize: vi.fn<() => void>(() => {
      window.minimized = true;
    }),
    show: vi.fn<() => void>(),
    focus: vi.fn<() => void>(),
    close: vi.fn<() => void>(),
  };
  return window;
}

interface Asked {
  window: FakeWindow;
  options: MessageBoxOptions;
  answer: (response: number) => void;
}

interface WorldOptions {
  platform?: NodeJS.Platform;
  presence?: Presence;
  windows?: FakeWindow[];
  hidden?: boolean;
  restarting?: boolean;
  macShutdown?: 'wait' | 'at-once';
}

function world({
  platform = 'darwin',
  presence = IDLE,
  windows = [fakeWindow(7)],
  hidden = false,
  restarting = false,
  macShutdown,
}: WorldOptions = {}) {
  const open = {
    windows: [...windows],
    focused: null as FakeWindow | null,
    presence: presence as Presence | undefined,
  };
  const exited = Promise.withResolvers<number>();
  const core = {
    presence: vi.fn(() => open.presence),
    flushDrafts: vi.fn<(windows: number[], reason?: 'system') => Promise<DraftsFlushed>>(() =>
      Promise.resolve({ unanswered: [] }),
    ),
    prepare: vi.fn<(...args: unknown[]) => Promise<ShutdownPrepared>>(() =>
      Promise.resolve({ ok: true }),
    ),
    cancel: vi.fn(() => Promise.resolve(null)),
    commit: vi.fn<() => Promise<unknown>>(() => Promise.resolve(null)),
    activate: vi.fn(() => Promise.resolve(null)),
    exited: vi.fn(() => exited.promise),
    stop: vi.fn(),
  };
  const asked: Asked[] = [];
  const updates = {
    restarting,
    finishQuit: vi.fn(() => false),
    cancelRestart: vi.fn(() => {
      updates.restarting = false;
    }),
  };
  const made: FakeWindow[] = [];
  const deps = {
    platform,
    hidden,
    core,
    windows: () => open.windows,
    focused: () => open.focused,
    open: vi.fn(() => {
      const window = fakeWindow(100 + made.length);
      made.push(window);
      open.windows.push(window);
      return Promise.resolve(window);
    }),
    ask: vi.fn((window: FakeWindow, options: MessageBoxOptions) => {
      const answered = Promise.withResolvers<number>();
      options.signal?.addEventListener('abort', () => {
        answered.resolve(options.cancelId ?? 0);
      });
      asked.push({ window, options, answer: answered.resolve });
      return answered.promise;
    }),
    quit: vi.fn(),
    exit: vi.fn(),
    updates: () => updates,
    log: vi.fn(),
    ...(macShutdown === undefined ? {} : { macShutdown }),
  } satisfies QuitDeps<FakeWindow>;
  const quit = new QuitCoordinator(deps);
  /** Before-quit, as Electron sends it: whether it was let through. */
  const beforeQuit = () => {
    const preventDefault = vi.fn();
    quit.beforeQuit({ preventDefault });
    return preventDefault.mock.calls.length === 0;
  };
  /** A window's close, as Electron sends it: whether it was let through. */
  const close = (window: FakeWindow) => {
    const preventDefault = vi.fn();
    quit.windowClosing(window, { preventDefault });
    return preventDefault.mock.calls.length === 0;
  };
  const names = () => [
    ...core.flushDrafts.mock.calls.map((args) => ['flushDrafts', ...args]),
    ...core.prepare.mock.calls.map((args) => ['prepare', ...args]),
    ...core.commit.mock.calls.map(() => ['commit']),
    ...core.cancel.mock.calls.map(() => ['cancel']),
  ];
  return { quit, deps, core, open, asked, updates, made, exited, beforeQuit, close, names };
}

/** The world's first window. */
function first(w: { open: { windows: FakeWindow[] } }): FakeWindow {
  const [window] = w.open.windows;
  if (window === undefined) throw new Error('no window is open');
  return window;
}

/** Lets what was started settle (fake timers or not). */
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

afterEach(() => {
  vi.useRealTimers();
});

describe('a quit with nothing at work', () => {
  it('saves at once, the core holding its barrier only if still idle, then closes it and quits', async () => {
    const w = world();
    expect(w.beforeQuit()).toBe(false);
    await vi.waitFor(() => {
      expect(w.deps.quit).toHaveBeenCalledOnce();
    });
    expect(w.asked).toEqual([]);
    expect(w.names()).toEqual([
      ['flushDrafts', [7]],
      ['prepare', 'quit', { ifIdle: true }],
      ['commit'],
    ]);
    expect(w.core.stop).toHaveBeenCalledOnce();
    // Its own quit goes through.
    expect(w.beforeQuit()).toBe(true);
  });

  it('asks when the core finds work started meanwhile, holding nothing', async () => {
    const w = world();
    w.core.prepare.mockResolvedValueOnce({ busy: busy({ jobs: 1 }) });
    w.beforeQuit();
    await vi.waitFor(() => {
      expect(w.asked).toHaveLength(1);
    });
    expect(w.asked[0]?.options.message).toBe('corrallm is finishing some work for its agents.');
    expect(w.core.commit).not.toHaveBeenCalled();
    expect(w.core.cancel).not.toHaveBeenCalled();
    // Quit and pause: drafts again, then the barrier without ifIdle, never rechecked.
    w.asked[0]?.answer(0);
    await vi.waitFor(() => {
      expect(w.deps.quit).toHaveBeenCalledOnce();
    });
    expect(w.names()).toEqual([
      ['flushDrafts', [7]],
      ['flushDrafts', [7]],
      ['prepare', 'quit', { ifIdle: true }],
      ['prepare', 'quit'],
      ['commit'],
    ]);
  });
});

describe('the question', () => {
  it('asks about an idle session’s background work even though it does not keep awake', async () => {
    const presence = new PresencePublisher({
      count: () =>
        countPresence({
          canvases: () => [
            {
              document: { id: 'canvas' as CanvasId },
              engine: {
                run: { snapshot: () => ({ running: false, agents: {} }) },
                sessions: {
                  snapshot: () => ({
                    worker: {
                      status: 'idle',
                      tasks: [{ id: 'server', description: 'Dev server', kind: 'command' }],
                    },
                  }),
                },
              },
              messages: { active: () => [] },
            },
          ],
          needs: () => [],
          notify: () => true,
          jobs: () => 0,
        }),
      send: () => {
        // The coordinator reads the core’s last snapshot directly in this world.
      },
    }).now();
    const w = world({ presence });
    w.beforeQuit();
    await vi.waitFor(() => {
      expect(w.asked).toHaveLength(1);
    });
    expect(presence).toMatchObject({ working: 0, runs: 0, jobs: 1, busy: true, awake: false });
    expect(w.asked[0]?.options.message).toBe('corrallm is finishing some work for its agents.');
    expect(w.core.prepare).not.toHaveBeenCalled();
    expect(w.core.commit).not.toHaveBeenCalled();
    w.asked[0]?.answer(2);
    await settle();
    expect(w.quit.asking).toBe(false);
  });

  it.each([
    [busy({ working: 1 }), 'An agent is working.'],
    [busy({ working: 3, runs: 2 }), '3 agents are working.'],
    [busy({ working: 140 }), '99+ agents are working.'],
    [busy({ runs: 1 }), 'A run is going on a canvas.'],
    [busy({ runs: 4, jobs: 2 }), 'A run is going on 4 canvases.'],
    [busy({ jobs: 1 }), 'corrallm is finishing some work for its agents.'],
    [undefined, 'corrallm couldn’t check whether its agents are working.'],
  ])('words its cause from the counts alone: %o', async (presence, message) => {
    const w = world();
    w.open.presence = presence;
    w.beforeQuit();
    await vi.waitFor(() => {
      expect(w.asked).toHaveLength(1);
    });
    expect(w.asked[0]?.options).toMatchObject({
      type: 'question',
      message,
      buttons: ['Quit and pause', 'Keep running', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
    });
    expect(w.core.flushDrafts).not.toHaveBeenCalled();
    expect(w.core.prepare).not.toHaveBeenCalled();
  });

  it.each([
    [
      'darwin',
      'Quit and pause ends their sessions, and each run opens paused next time. Keep running closes the windows; the agents go on, shown in the menu bar and the Dock.',
    ],
    [
      'linux',
      'Quit and pause ends their sessions, and each run opens paused next time. Keep running minimizes corrallm; the agents go on.',
    ],
  ] as const)('says what each answer does on %s', async (platform, detail) => {
    const w = world({ platform, presence: WORKING });
    w.beforeQuit();
    await vi.waitFor(() => {
      expect(w.asked).toHaveLength(1);
    });
    expect(w.asked[0]?.options.detail).toBe(detail);
  });

  it('is a sheet on the focused window, else the first, restored if minimized', async () => {
    const first = fakeWindow(7, true);
    const second = fakeWindow(8);
    const w = world({ presence: WORKING, windows: [first, second] });
    w.beforeQuit();
    await vi.waitFor(() => {
      expect(w.asked).toHaveLength(1);
    });
    expect(w.asked[0]?.window).toBe(first);
    expect(first.restore).toHaveBeenCalledOnce();
    expect(w.asked[0]?.options.signal).toBeInstanceOf(AbortSignal);
    w.asked[0]?.answer(2);
    await settle();
    w.open.focused = second;
    w.beforeQuit();
    await vi.waitFor(() => {
      expect(w.asked).toHaveLength(2);
    });
    expect(w.asked[1]?.window).toBe(second);
  });

  it('on macOS with no window, opens one to ask on, which Cancel leaves open', async () => {
    const w = world({ presence: WORKING, windows: [] });
    w.beforeQuit();
    await vi.waitFor(() => {
      expect(w.asked).toHaveLength(1);
    });
    expect(w.deps.open).toHaveBeenCalledOnce();
    expect(w.asked[0]?.window).toBe(w.made[0]);
    w.asked[0]?.answer(2);
    await settle();
    expect(w.made[0]?.close).not.toHaveBeenCalled();
    expect(w.deps.quit).not.toHaveBeenCalled();
  });

  it('quits nothing when there is no window to ask on', async () => {
    const w = world({ presence: WORKING, windows: [] });
    w.deps.open.mockRejectedValueOnce(new Error('no display'));
    w.beforeQuit();
    await settle();
    expect(w.asked).toEqual([]);
    expect(w.deps.quit).not.toHaveBeenCalled();
    expect(w.core.prepare).not.toHaveBeenCalled();
    expect(w.updates.cancelRestart).toHaveBeenCalledOnce();
    // Asked again, it tries again.
    w.beforeQuit();
    await vi.waitFor(() => {
      expect(w.asked).toHaveLength(1);
    });
  });
});

describe('its answers', () => {
  async function asking(options: WorldOptions = {}) {
    const w = world({ presence: WORKING, ...options });
    w.beforeQuit();
    await vi.waitFor(() => {
      expect(w.asked).toHaveLength(1);
    });
    return w;
  }

  it('Quit and pause: drafts, the barrier for quit, its close, then the quit', async () => {
    const w = await asking();
    w.asked[0]?.answer(0);
    await vi.waitFor(() => {
      expect(w.deps.quit).toHaveBeenCalledOnce();
    });
    expect(w.names()).toEqual([['flushDrafts', [7]], ['prepare', 'quit'], ['commit']]);
    expect(w.deps.exit).not.toHaveBeenCalled();
  });

  it('Quit and pause shows the failed-save question if saving fails, as a sheet too', async () => {
    const w = await asking();
    w.core.prepare.mockResolvedValueOnce({ failed: true, sentence: 'The disk is full.' });
    w.asked[0]?.answer(0);
    await vi.waitFor(() => {
      expect(w.asked).toHaveLength(2);
    });
    expect(w.asked[1]).toMatchObject({
      window: w.open.windows[0],
      options: { message: 'The run could not be saved', cancelId: 0 },
    });
    // Keep corrallm open lifts the barrier.
    w.asked[1]?.answer(0);
    await vi.waitFor(() => {
      expect(w.core.cancel).toHaveBeenCalledOnce();
    });
    expect(w.core.commit).not.toHaveBeenCalled();
  });

  it('Keep running on macOS closes every window, each as a window close, and holds nothing', async () => {
    const other = fakeWindow(8);
    const w = await asking({ windows: [fakeWindow(7), other] });
    w.asked[0]?.answer(1);
    await vi.waitFor(() => {
      expect(other.close).toHaveBeenCalledOnce();
    });
    expect(w.open.windows[0]?.close).toHaveBeenCalledOnce();
    expect(w.open.windows.every((window) => window.minimize.mock.calls.length === 0)).toBe(true);
    expect(w.core.prepare).not.toHaveBeenCalled();
    expect(w.core.stop).not.toHaveBeenCalled();
    expect(w.deps.quit).not.toHaveBeenCalled();
    // Each window's close flushes its own drafts, as any window close does.
    expect(w.close(other)).toBe(false);
    await vi.waitFor(() => {
      expect(other.close).toHaveBeenCalledTimes(2);
    });
    expect(w.core.flushDrafts).toHaveBeenCalledExactlyOnceWith([8]);
  });

  it('Keep running elsewhere minimizes every window, closing none', async () => {
    const w = await asking({ platform: 'linux', windows: [fakeWindow(7), fakeWindow(8)] });
    w.asked[0]?.answer(1);
    await vi.waitFor(() => {
      expect(w.open.windows[1]?.minimize).toHaveBeenCalledOnce();
    });
    expect(w.open.windows[0]?.minimize).toHaveBeenCalledOnce();
    expect(w.open.windows.every((window) => window.close.mock.calls.length === 0)).toBe(true);
  });

  it('Keep running stays Keep running when the work ended while it asked', async () => {
    const w = await asking({ platform: 'linux' });
    w.open.presence = IDLE;
    w.asked[0]?.answer(1);
    await settle();
    expect(w.open.windows[0]?.minimize).toHaveBeenCalledOnce();
    expect(w.core.prepare).not.toHaveBeenCalled();
    expect(w.deps.quit).not.toHaveBeenCalled();
  });

  it('Cancel (and Esc, which is Cancel) changes nothing, and asks again on the next quit', async () => {
    const w = await asking();
    w.asked[0]?.answer(2);
    await settle();
    expect(w.names()).toEqual([]);
    expect(w.deps.quit).not.toHaveBeenCalled();
    expect(w.open.windows[0]?.close).not.toHaveBeenCalled();
    w.beforeQuit();
    await vi.waitFor(() => {
      expect(w.asked).toHaveLength(2);
    });
  });
});

describe('an update’s restart', () => {
  it('asks Restart and pause or Cancel while work goes on; Cancel clears the restart', async () => {
    const w = world({ presence: WORKING, restarting: true });
    w.quit.request('update');
    await vi.waitFor(() => {
      expect(w.asked).toHaveLength(1);
    });
    expect(w.asked[0]?.options).toMatchObject({
      buttons: ['Restart and pause', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      detail: 'Restart and pause ends their sessions, and each run opens paused next time.',
    });
    w.asked[0]?.answer(1);
    await settle();
    expect(w.updates.cancelRestart).toHaveBeenCalledOnce();
    expect(w.updates.finishQuit).not.toHaveBeenCalled();
    expect(w.core.prepare).not.toHaveBeenCalled();
  });

  it('Restart and pause prepares for update, and installs only once the core has closed', async () => {
    const w = world({ presence: WORKING, restarting: true });
    const closed = Promise.withResolvers<null>();
    w.core.commit.mockReturnValueOnce(closed.promise);
    w.updates.finishQuit.mockReturnValue(true);
    w.quit.request('update');
    await vi.waitFor(() => {
      expect(w.asked).toHaveLength(1);
    });
    w.asked[0]?.answer(0);
    await vi.waitFor(() => {
      expect(w.core.commit).toHaveBeenCalledOnce();
    });
    expect(w.core.prepare).toHaveBeenCalledExactlyOnceWith('update');
    expect(w.updates.finishQuit).not.toHaveBeenCalled();
    closed.resolve(null);
    await vi.waitFor(() => {
      expect(w.updates.finishQuit).toHaveBeenCalledOnce();
    });
    expect(w.deps.quit).not.toHaveBeenCalled();
  });

  it('with nothing at work, saves for update at once', async () => {
    const w = world({ restarting: true });
    w.quit.request('update');
    await vi.waitFor(() => {
      expect(w.core.commit).toHaveBeenCalledOnce();
    });
    expect(w.core.prepare).toHaveBeenCalledExactlyOnceWith('update', { ifIdle: true });
    expect(w.asked).toEqual([]);
  });
});

describe('asking again while it asks or saves', () => {
  it('joins every user, last-window or update request to the question up, focusing it', async () => {
    const w = world({ platform: 'linux', presence: WORKING });
    w.beforeQuit();
    await vi.waitFor(() => {
      expect(w.asked).toHaveLength(1);
    });
    const window = first(w);
    window.focus.mockClear();
    w.beforeQuit();
    w.quit.request('update');
    expect(w.close(window)).toBe(false);
    await settle();
    expect(w.asked).toHaveLength(1);
    expect(window.focus).toHaveBeenCalledTimes(3);
    // An update that joined a quit's question: Keep running cancels its restart.
    w.updates.restarting = true;
    w.asked[0]?.answer(1);
    await settle();
    expect(w.updates.cancelRestart).toHaveBeenCalledOnce();
  });

  it('keeps open the window the question is a sheet on, focusing the question', async () => {
    const asking = fakeWindow(7);
    const w = world({ presence: WORKING, windows: [asking, fakeWindow(8)] });
    w.beforeQuit();
    await vi.waitFor(() => {
      expect(w.asked).toHaveLength(1);
    });
    asking.focus.mockClear();
    expect(w.close(asking)).toBe(false);
    await settle();
    expect(asking.focus).toHaveBeenCalledOnce();
    expect(w.core.flushDrafts).not.toHaveBeenCalled();
    expect(asking.close).not.toHaveBeenCalled();
  });

  it('a second quit while saving is the explicit five-second escape; update and last-window wait', async () => {
    vi.useFakeTimers();
    const w = world({ platform: 'linux' });
    w.core.prepare.mockReturnValue(new Promise(() => undefined));
    w.core.commit.mockReturnValue(new Promise(() => undefined));
    w.beforeQuit();
    await vi.advanceTimersByTimeAsync(0);
    expect(w.quit.saving).toBe(true);
    w.quit.request('update');
    w.quit.request('last-window');
    await vi.advanceTimersByTimeAsync(0);
    expect(w.core.commit).not.toHaveBeenCalled();
    w.beforeQuit();
    await vi.advanceTimersByTimeAsync(0);
    expect(w.core.commit).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(4999);
    expect(w.deps.quit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(w.deps.quit).toHaveBeenCalledOnce();
  });

  it('waits out an approved quit: before-quit and window closes stay prevented until the core closed', async () => {
    const w = world();
    const closed = Promise.withResolvers<null>();
    w.core.commit.mockReturnValueOnce(closed.promise);
    w.beforeQuit();
    await vi.waitFor(() => {
      expect(w.core.commit).toHaveBeenCalledOnce();
    });
    expect(w.quit.approved).toBe(true);
    expect(w.close(first(w))).toBe(false);
    closed.resolve(null);
    await vi.waitFor(() => {
      expect(w.deps.quit).toHaveBeenCalledOnce();
    });
    expect(w.close(first(w))).toBe(true);
    expect(w.beforeQuit()).toBe(true);
  });
});

describe('the last window, on Linux and Windows', () => {
  it.each(['linux', 'win32'] as const)(
    'on %s, its close is prevented and becomes the quit question; Cancel leaves it open',
    async (platform) => {
      const w = world({ platform, presence: WORKING });
      const window = first(w);
      expect(w.close(window)).toBe(false);
      await vi.waitFor(() => {
        expect(w.asked).toHaveLength(1);
      });
      expect(w.asked[0]?.window).toBe(window);
      w.asked[0]?.answer(2);
      await settle();
      expect(window.close).not.toHaveBeenCalled();
      expect(window.minimize).not.toHaveBeenCalled();
      expect(w.deps.quit).not.toHaveBeenCalled();
    },
  );

  it('quits when nothing is at work, as before', async () => {
    const w = world({ platform: 'linux' });
    expect(w.close(first(w))).toBe(false);
    await vi.waitFor(() => {
      expect(w.deps.quit).toHaveBeenCalledOnce();
    });
    expect(w.asked).toEqual([]);
    expect(w.core.prepare).toHaveBeenCalledExactlyOnceWith('quit', { ifIdle: true });
  });

  it('is not every window’s close: one with another open closes as a view, its drafts first', async () => {
    const first = fakeWindow(7);
    const second = fakeWindow(8);
    const w = world({ platform: 'linux', presence: WORKING, windows: [first, second] });
    expect(w.close(first)).toBe(false);
    await vi.waitFor(() => {
      expect(first.close).toHaveBeenCalledOnce();
    });
    expect(w.core.flushDrafts).toHaveBeenCalledExactlyOnceWith([7]);
    expect(w.asked).toEqual([]);
    // Its own close then goes through.
    expect(w.close(first)).toBe(true);
  });

  it('of two closing together, the second is the last', async () => {
    const first = fakeWindow(7);
    const second = fakeWindow(8);
    const w = world({ platform: 'linux', presence: WORKING, windows: [first, second] });
    const drafts = Promise.withResolvers<DraftsFlushed>();
    w.core.flushDrafts.mockReturnValueOnce(drafts.promise);
    expect(w.close(first)).toBe(false);
    expect(w.close(second)).toBe(false);
    await vi.waitFor(() => {
      expect(w.asked).toHaveLength(1);
    });
    expect(w.asked[0]?.window).toBe(second);
    drafts.resolve({ unanswered: [] });
    // Cancel: the first goes, as it asked; the second stays.
    w.asked[0]?.answer(2);
    await vi.waitFor(() => {
      expect(first.close).toHaveBeenCalledOnce();
    });
    expect(second.close).not.toHaveBeenCalled();
  });

  it('a window that came back and closes again is the last again, its drafts flushed anew', async () => {
    const first = fakeWindow(7);
    const second = fakeWindow(8);
    const w = world({ platform: 'linux', presence: WORKING, windows: [first, second] });
    w.close(first);
    await vi.waitFor(() => {
      expect(first.close).toHaveBeenCalledOnce();
    });
    // Its own close was let through, but the other went meanwhile: it is the last now.
    w.open.windows = [first];
    expect(w.close(first)).toBe(false);
    await vi.waitFor(() => {
      expect(w.asked).toHaveLength(1);
    });
    w.asked[0]?.answer(2);
    await settle();
    // A new window opens; this one's next close is a view close, saving its drafts again.
    w.open.windows = [first, fakeWindow(9)];
    w.core.flushDrafts.mockClear();
    expect(w.close(first)).toBe(false);
    await vi.waitFor(() => {
      expect(w.core.flushDrafts).toHaveBeenCalledExactlyOnceWith([7]);
    });
  });

  it('is never asked on macOS, where a window close is a view close', async () => {
    const w = world({ presence: WORKING });
    const window = first(w);
    expect(w.close(window)).toBe(false);
    await vi.waitFor(() => {
      expect(window.close).toHaveBeenCalledOnce();
    });
    expect(w.asked).toEqual([]);
    w.open.windows = [];
    w.quit.allClosed();
    await settle();
    expect(w.asked).toEqual([]);
    expect(w.deps.quit).not.toHaveBeenCalled();
  });

  it('a window gone without its close counts as the last, a window made to ask on', async () => {
    const w = world({ platform: 'linux', presence: WORKING, windows: [] });
    w.quit.allClosed();
    await vi.waitFor(() => {
      expect(w.asked).toHaveLength(1);
    });
    expect(w.asked[0]?.window).toBe(w.made[0]);
  });
});

describe('the system’s shutdown or logout', () => {
  it('asks nothing: drafts for the system, its barrier, its close, then quits', async () => {
    const w = world({ presence: WORKING });
    w.quit.request('system');
    await vi.waitFor(() => {
      expect(w.deps.quit).toHaveBeenCalledOnce();
    });
    expect(w.asked).toEqual([]);
    expect(w.names()).toEqual([['flushDrafts', [7], 'system'], ['prepare', 'system'], ['commit']]);
    expect(w.core.stop).toHaveBeenCalledOnce();
    expect(w.deps.exit).not.toHaveBeenCalled();
    expect(w.beforeQuit()).toBe(true);
  });

  it('withdraws a question up, and goes on as the system path', async () => {
    const w = world({ presence: WORKING });
    w.beforeQuit();
    await vi.waitFor(() => {
      expect(w.asked).toHaveLength(1);
    });
    w.quit.request('system');
    expect(w.asked[0]?.options.signal?.aborted).toBe(true);
    await vi.waitFor(() => {
      expect(w.deps.quit).toHaveBeenCalledOnce();
    });
    expect(w.updates.cancelRestart).not.toHaveBeenCalled();
    expect(w.core.prepare).toHaveBeenCalledExactlyOnceWith('system');
  });

  it('withdraws a failed-save question, lifting no barrier, and closes', async () => {
    const w = world();
    w.core.prepare.mockResolvedValueOnce({ failed: true, sentence: 'The disk is full.' });
    w.beforeQuit();
    await vi.waitFor(() => {
      expect(w.asked).toHaveLength(1);
    });
    w.quit.request('system');
    await vi.waitFor(() => {
      expect(w.deps.quit).toHaveBeenCalledOnce();
    });
    expect(w.core.cancel).not.toHaveBeenCalled();
    expect(w.core.commit).toHaveBeenCalledOnce();
  });

  it('commits whatever its barrier said, saying a failure without its values', async () => {
    const w = world();
    w.core.prepare.mockResolvedValueOnce({ failed: true, sentence: 'secret /path/to/x' });
    w.quit.request('system');
    await vi.waitFor(() => {
      expect(w.deps.quit).toHaveBeenCalledOnce();
    });
    expect(w.core.commit).toHaveBeenCalledOnce();
    expect(JSON.stringify(w.deps.log.mock.calls)).not.toContain('secret');
    expect(w.asked).toEqual([]);
  });

  it('gives drafts at most a second before its barrier', async () => {
    vi.useFakeTimers();
    const w = world();
    w.core.flushDrafts.mockReturnValueOnce(new Promise(() => undefined));
    w.quit.request('system');
    await vi.advanceTimersByTimeAsync(999);
    expect(w.core.prepare).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(w.core.prepare).toHaveBeenCalledExactlyOnceWith('system');
    await vi.advanceTimersByTimeAsync(0);
    expect(w.deps.quit).toHaveBeenCalledOnce();
  });

  it(`exits 1, saying so once, if the core hasn't closed ${String(SYSTEM_BUDGET_MS)} ms after the signal`, async () => {
    vi.useFakeTimers();
    const w = world();
    w.core.commit.mockReturnValueOnce(new Promise(() => undefined));
    w.quit.request('system');
    await vi.advanceTimersByTimeAsync(SYSTEM_BUDGET_MS - 1);
    expect(w.deps.exit).not.toHaveBeenCalled();
    expect(w.deps.quit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(w.deps.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(w.deps.log).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(w.deps.exit).toHaveBeenCalledOnce();
  });

  it('counts a core that closed itself and exited 0 as closed, and one that exited otherwise as not', async () => {
    const closedItself = world();
    closedItself.core.flushDrafts.mockRejectedValue(new Error('gone'));
    closedItself.core.prepare.mockRejectedValue(new Error('gone'));
    closedItself.core.commit.mockRejectedValue(new Error('gone'));
    closedItself.exited.resolve(0);
    closedItself.quit.request('system');
    await vi.waitFor(() => {
      expect(closedItself.deps.quit).toHaveBeenCalledOnce();
    });
    expect(closedItself.deps.exit).not.toHaveBeenCalled();
    expect(closedItself.deps.log).not.toHaveBeenCalled();

    const crashed = world();
    crashed.core.commit.mockRejectedValue(new Error('gone'));
    crashed.exited.resolve(9);
    crashed.quit.request('system');
    await vi.waitFor(() => {
      expect(crashed.deps.exit).toHaveBeenCalledExactlyOnceWith(1);
    });
    expect(crashed.deps.quit).not.toHaveBeenCalled();
  });

  it('lets an approved quit finish, installing no update, and prepares nothing more', async () => {
    const w = world({ restarting: true });
    w.updates.finishQuit.mockReturnValue(true);
    const closed = Promise.withResolvers<null>();
    w.core.commit.mockReturnValueOnce(closed.promise);
    w.quit.request('update');
    await vi.waitFor(() => {
      expect(w.core.commit).toHaveBeenCalledOnce();
    });
    w.quit.request('system');
    closed.resolve(null);
    await vi.waitFor(() => {
      expect(w.deps.quit).toHaveBeenCalledOnce();
    });
    expect(w.updates.finishQuit).not.toHaveBeenCalled();
    expect(w.core.prepare).toHaveBeenCalledOnce();
    expect(w.core.commit).toHaveBeenCalledOnce();
  });

  it('takes over a quit still saving, with no failed-save question', async () => {
    const w = world();
    const drafts = Promise.withResolvers<DraftsFlushed>();
    w.core.flushDrafts.mockReturnValueOnce(drafts.promise);
    w.beforeQuit();
    await settle();
    w.quit.request('system');
    await vi.waitFor(() => {
      expect(w.deps.quit).toHaveBeenCalledOnce();
    });
    drafts.resolve({ unanswered: [7] });
    await settle();
    expect(w.asked).toEqual([]);
    expect(w.core.commit).toHaveBeenCalledOnce();
    expect(w.deps.exit).not.toHaveBeenCalled();
  });

  it('happens once, and holds before-quit and window closes until it quits', async () => {
    const w = world();
    const closed = Promise.withResolvers<null>();
    w.core.commit.mockReturnValueOnce(closed.promise);
    w.quit.request('system');
    w.quit.request('system');
    await settle();
    expect(w.beforeQuit()).toBe(false);
    expect(w.close(first(w))).toBe(false);
    w.quit.request('user');
    expect(await w.quit.reopen()).toBeUndefined();
    closed.resolve(null);
    await vi.waitFor(() => {
      expect(w.deps.quit).toHaveBeenCalledOnce();
    });
    expect(w.core.prepare).toHaveBeenCalledOnce();
    expect(w.asked).toEqual([]);
  });

  it('prevents powerMonitor’s shutdown event and quits itself', async () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const w = world({ platform, presence: WORKING });
      const preventDefault = vi.fn();
      w.quit.shutdown({ preventDefault });
      expect(preventDefault).toHaveBeenCalledOnce();
      await vi.waitFor(() => {
        expect(w.deps.quit).toHaveBeenCalledOnce();
      });
      expect(w.asked).toEqual([]);
    }
  });

  it('with macOS’s fallback (at once), lets the logout go on, asking the core without waiting', () => {
    const w = world({ presence: WORKING, macShutdown: 'at-once' });
    w.core.prepare.mockReturnValue(new Promise(() => undefined));
    const preventDefault = vi.fn();
    w.quit.shutdown({ preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(w.deps.quit).toHaveBeenCalledOnce();
    expect(w.core.stop).toHaveBeenCalledOnce();
    // The system's own quit, and its windows' closes, go through.
    expect(w.beforeQuit()).toBe(true);
    expect(w.close(first(w))).toBe(true);
    expect(w.asked).toEqual([]);
  });
});

describe('reopening', () => {
  it('restores a minimized window, else shows the first, else makes one, one at a time', async () => {
    const minimized = fakeWindow(8, true);
    const w = world({ windows: [fakeWindow(7), minimized] });
    expect(await w.quit.reopen()).toBe(minimized);
    expect(minimized.restore).toHaveBeenCalledOnce();
    expect(minimized.focus).toHaveBeenCalledOnce();
    expect(await w.quit.reopen()).toBe(w.open.windows[0]);
    expect(w.open.windows[0]?.show).toHaveBeenCalledOnce();
    w.open.windows = [];
    const [one, two] = await Promise.all([w.quit.reopen(), w.quit.reopen()]);
    expect(one).toBe(two);
    expect(w.deps.open).toHaveBeenCalledOnce();
  });

  it('never shows the hidden e2e app’s window', async () => {
    const w = world({ hidden: true });
    await w.quit.reopen();
    expect(w.open.windows[0]?.show).not.toHaveBeenCalled();
    expect(w.open.windows[0]?.focus).toHaveBeenCalledOnce();
  });

  it('focuses the question while it asks, making nothing', async () => {
    const w = world({ presence: WORKING });
    w.beforeQuit();
    await vi.waitFor(() => {
      expect(w.asked).toHaveLength(1);
    });
    w.open.windows.push(fakeWindow(8));
    expect(await w.quit.reopen()).toBe(w.open.windows[0]);
    expect(w.deps.open).not.toHaveBeenCalled();
  });

  it('does nothing once a quit is saving or approved', async () => {
    const w = world({ windows: [] });
    const drafts = Promise.withResolvers<DraftsFlushed>();
    w.core.flushDrafts.mockReturnValueOnce(drafts.promise);
    w.beforeQuit();
    expect(await w.quit.reopen()).toBeUndefined();
    drafts.resolve({ unanswered: [] });
    await vi.waitFor(() => {
      expect(w.deps.quit).toHaveBeenCalledOnce();
    });
    expect(await w.quit.reopen()).toBeUndefined();
    expect(w.deps.open).not.toHaveBeenCalled();
  });

  it('a click shows its window, then has the core resolve its opaque handle at that window', async () => {
    const w = world({ windows: [] });
    await w.quit.activate('0f8fad5b-d9cb-469f-a165-70867728950e');
    expect(w.core.activate).toHaveBeenCalledExactlyOnceWith(
      100,
      '0f8fad5b-d9cb-469f-a165-70867728950e',
    );
    const quitting = world();
    quitting.quit.request('system');
    await quitting.quit.activate('0f8fad5b-d9cb-469f-a165-70867728950e');
    expect(quitting.core.activate).not.toHaveBeenCalled();
  });
});

it('publishes quit presentation changes so native Pause all follows asking, saving and approval', async () => {
  const w = world({ presence: WORKING });
  const states: { asking: boolean; saving: boolean; approved: boolean }[] = [];
  const quit = new QuitCoordinator<FakeWindow>({
    ...w.deps,
    changed: () => {
      states.push({ asking: quit.asking, saving: quit.saving, approved: quit.approved });
    },
  });
  quit.request('user');
  await vi.waitFor(() => {
    expect(w.asked).toHaveLength(1);
  });
  w.asked[0]?.answer(0);
  await vi.waitFor(() => {
    expect(w.deps.quit).toHaveBeenCalledOnce();
  });
  expect(states).toContainEqual({ asking: true, saving: false, approved: false });
  expect(states.some((state) => state.saving && !state.approved)).toBe(true);
  expect(states.some((state) => state.approved)).toBe(true);
});
