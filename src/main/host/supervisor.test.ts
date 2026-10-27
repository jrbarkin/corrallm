import { describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { ProfileLocked } from '../core/lock';
import type { CoreProcess } from './core-process';
import { CoreSupervisor } from './supervisor';
import type { SupervisorOptions } from './supervisor';
import { RESTARTS, WINDOW_MS } from './supervise';

/*
 * The core process, supervised (Core Server §7.5), against fake core processes and a fake clock:
 * the real one is killed in e2e (e2e/core-crash.e2e.ts). supervise.ts's policy has its own tests;
 * these check what main does with it.
 */

interface FakeCore extends CoreProcess {
  /** Ends the fake process with `code`, as a crash (or a clean exit) would. */
  exit(code: number): void;
  readonly connect: Mock<CoreProcess['connect']>;
  readonly windowGone: Mock<CoreProcess['windowGone']>;
  readonly windowFocused: Mock<CoreProcess['windowFocused']>;
  readonly resumed: Mock<CoreProcess['resumed']>;
  readonly kill: Mock<CoreProcess['kill']>;
}

function fakeCore(): FakeCore {
  const exited = Promise.withResolvers<number>();
  return {
    link: {} as CoreProcess['link'],
    exited: exited.promise,
    presence: undefined,
    exit: exited.resolve,
    connect: vi.fn<CoreProcess['connect']>(),
    windowGone: vi.fn<CoreProcess['windowGone']>(),
    windowFocused: vi.fn<CoreProcess['windowFocused']>(),
    resumed: vi.fn<CoreProcess['resumed']>(),
    focus: vi.fn<CoreProcess['focus']>(),
    kill: vi.fn<CoreProcess['kill']>(),
  };
}

function setup(init: (core: CoreProcess, nth: number) => Promise<void> = () => Promise.resolve()) {
  const forked: FakeCore[] = [];
  let now = 1_000_000;
  const options = {
    fork: vi.fn(() => {
      const core = fakeCore();
      forked.push(core);
      return core;
    }),
    init: vi.fn((core: CoreProcess) => init(core, forked.indexOf(core as FakeCore))),
    restarting: vi.fn<(why: string) => void>(),
    restarted: vi.fn<(epoch: number) => void>(),
    gaveUp: vi.fn<(why: Error) => void>(),
    now: () => now,
  } satisfies SupervisorOptions;
  const supervisor = new CoreSupervisor(options);
  return {
    supervisor,
    options,
    forked,
    /** The nth core forked. */
    core: (nth: number) => {
      const core = forked[nth];
      if (!core) throw new Error(`no core ${String(nth)} was forked`);
      return core;
    },
    later: (ms: number) => {
      now += ms;
    },
  };
}

/** Lets what the supervisor does after an exit (it awaits the new core's init) happen. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('starting the core', () => {
  it('forks a core and asks it up, as epoch 1', async () => {
    const { supervisor, options, core } = setup();
    await supervisor.start();

    expect(options.fork).toHaveBeenCalledOnce();
    expect(options.init).toHaveBeenCalledExactlyOnceWith(core(0));
    expect(await supervisor.core).toBe(core(0));
    expect(supervisor.epoch).toBe(1);
  });

  it('rejects when the core can’t come up, killing it, and never restarts it', async () => {
    const locked = new ProfileLocked({ owner: 'serve', pid: 42, started: 1 });
    const { supervisor, options, core } = setup(() => Promise.reject(locked));

    await expect(supervisor.start()).rejects.toBe(locked);
    expect(core(0).kill).toHaveBeenCalledOnce();
    core(0).exit(1);
    await settle();
    expect(options.fork).toHaveBeenCalledOnce();
  });

  it('hands windows’ ports to the core once it is up', async () => {
    const { supervisor, core } = setup();
    const starting = supervisor.start();
    const port = {} as Electron.MessagePortMain;
    supervisor.connect(7, port);
    supervisor.windowGone(8, true);
    supervisor.windowFocused(7);
    supervisor.resumed();
    expect(core(0).connect).not.toHaveBeenCalled();

    await starting;
    await settle();
    expect(core(0).connect).toHaveBeenCalledExactlyOnceWith(7, port);
    expect(core(0).windowGone).toHaveBeenCalledExactlyOnceWith(8, true);
    expect(core(0).windowFocused).toHaveBeenCalledExactlyOnceWith(7);
    expect(core(0).resumed).toHaveBeenCalledOnce();
  });
});

describe('a core that crashes', () => {
  it('is restarted: a new core forked and asked up, as the next epoch, and main told', async () => {
    const { supervisor, options, core } = setup();
    await supervisor.start();

    core(0).exit(9);
    await settle();
    expect(options.restarting).toHaveBeenCalledExactlyOnceWith('the core process stopped (code 9)');
    expect(options.fork).toHaveBeenCalledTimes(2);
    expect(options.init).toHaveBeenLastCalledWith(core(1));
    expect(options.restarted).toHaveBeenCalledExactlyOnceWith(2);
    expect(await supervisor.core).toBe(core(1));
    expect(supervisor.epoch).toBe(2);
  });

  it('sends what asks the core while a new one comes up to the new one, as its epoch', async () => {
    let up: (() => void) | undefined;
    const { supervisor, options, core } = setup((_core, nth) =>
      nth === 0
        ? Promise.resolve()
        : new Promise((resolve) => {
            up = resolve;
          }),
    );
    await supervisor.start();
    core(0).exit(1);
    await settle();

    // The port is the new core's: the epoch says so, before it is up.
    expect(supervisor.epoch).toBe(2);
    const port = {} as Electron.MessagePortMain;
    supervisor.windowGone(7);
    supervisor.connect(7, port);
    let asked: CoreProcess | undefined;
    void supervisor.core.then((answered) => {
      asked = answered;
    });
    await settle();
    expect(asked).toBeUndefined();
    expect(options.restarted).not.toHaveBeenCalled();

    up?.();
    await settle();
    expect(asked).toBe(core(1));
    expect(core(0).connect).not.toHaveBeenCalled();
    expect(core(1).windowGone).toHaveBeenCalledExactlyOnceWith(7);
    expect(core(1).connect).toHaveBeenCalledExactlyOnceWith(7, port);
    expect(options.restarted).toHaveBeenCalledExactlyOnceWith(2);
  });

  it(`gives up once it has restarted ${String(RESTARTS)} times within a minute`, async () => {
    const { supervisor, options, core } = setup();
    await supervisor.start();

    for (let nth = 0; nth < RESTARTS; nth++) {
      core(nth).exit(1);
      await settle();
    }
    expect(options.fork).toHaveBeenCalledTimes(RESTARTS + 1);
    expect(options.gaveUp).not.toHaveBeenCalled();

    core(RESTARTS).exit(1);
    await settle();
    expect(options.fork).toHaveBeenCalledTimes(RESTARTS + 1);
    expect(options.gaveUp).toHaveBeenCalledOnce();
    expect(options.gaveUp.mock.calls[0]?.[0].message).toBe(
      'corrallm’s core keeps stopping: it stopped 4 times within a minute.',
    );
    await expect(supervisor.core).rejects.toThrow('corrallm’s core keeps stopping');
  });

  it('restarts again once its earlier restarts are a minute old', async () => {
    const { supervisor, options, core, later } = setup();
    await supervisor.start();

    for (let nth = 0; nth < RESTARTS; nth++) {
      core(nth).exit(1);
      await settle();
    }
    later(WINDOW_MS);
    core(RESTARTS).exit(1);
    await settle();
    expect(options.gaveUp).not.toHaveBeenCalled();
    expect(options.fork).toHaveBeenCalledTimes(RESTARTS + 2);
    expect(supervisor.epoch).toBe(RESTARTS + 2);
  });

  it('counts a new core that can’t come up as another stop, killing it', async () => {
    const { supervisor, options, core } = setup((_core, nth) =>
      nth === 0 ? Promise.resolve() : Promise.reject(new Error('createCore failed')),
    );
    await supervisor.start();

    core(0).exit(1);
    await settle();
    // The first restart, and two more for the cores that couldn't come up: then it gives up.
    expect(options.fork).toHaveBeenCalledTimes(RESTARTS + 1);
    expect(options.restarting.mock.calls).toEqual([
      ['the core process stopped (code 1)'],
      ['the new core couldn’t come up (createCore failed)'],
      ['the new core couldn’t come up (createCore failed)'],
    ]);
    for (let nth = 1; nth <= RESTARTS; nth++) expect(core(nth).kill).toHaveBeenCalledOnce();
    expect(options.gaveUp).toHaveBeenCalledOnce();
    expect(options.restarted).not.toHaveBeenCalled();
  });

  it('gives up at once when the profile is held meanwhile, saying by whom', async () => {
    const locked = new ProfileLocked({ owner: 'serve', pid: 42, started: 1 });
    const { supervisor, options, core } = setup((_core, nth) =>
      nth === 0 ? Promise.resolve() : Promise.reject(locked),
    );
    await supervisor.start();

    core(0).exit(1);
    await settle();
    expect(options.fork).toHaveBeenCalledTimes(2);
    expect(core(1).kill).toHaveBeenCalledOnce();
    expect(options.gaveUp).toHaveBeenCalledExactlyOnceWith(locked);
  });
});

describe('an exit that is no crash', () => {
  it('restarts nothing for a clean exit', async () => {
    const { supervisor, options, core } = setup();
    await supervisor.start();

    core(0).exit(0);
    await settle();
    expect(options.fork).toHaveBeenCalledOnce();
    expect(options.restarting).not.toHaveBeenCalled();
  });

  it('restarts nothing once main stops it, as the app quits', async () => {
    const { supervisor, options, core } = setup();
    await supervisor.start();

    supervisor.stop();
    core(0).exit(1);
    await settle();
    expect(options.fork).toHaveBeenCalledOnce();
    expect(options.gaveUp).not.toHaveBeenCalled();
  });

  it('keeps a core that comes up after main stopped it, telling no window to reconnect', async () => {
    let up: (() => void) | undefined;
    const { supervisor, options, core } = setup((_core, nth) =>
      nth === 0
        ? Promise.resolve()
        : new Promise((resolve) => {
            up = resolve;
          }),
    );
    await supervisor.start();
    core(0).exit(1);
    await settle();

    supervisor.stop();
    up?.();
    // Closing the app still reaches it, to write out what it keeps and let the profile go.
    expect(await supervisor.core).toBe(core(1));
    expect(options.restarted).not.toHaveBeenCalled();
  });
});

it('owns the initializing process, drops an exited one and never grants a replaced one host authority', async () => {
  const gate = Promise.withResolvers<undefined>();
  const { supervisor, core } = setup(() => gate.promise);
  const starting = supervisor.start();
  expect(supervisor.owns(core(0))).toBe(true);
  gate.resolve(undefined);
  await starting;
  core(0).exit(1);
  await settle();
  expect(supervisor.owns(core(0))).toBe(false);
  expect(supervisor.owns(core(1))).toBe(true);
});
