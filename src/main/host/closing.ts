import type { MessageBoxOptions } from 'electron';

import type { WindowId } from '../core/host';
import { SYSTEM_DRAFTS_MS } from '../core/presence';
import type { Presence, ShutdownOptions } from '../core/presence';
import type { DraftsFlushed, ShutdownPrepared, ShutdownReason } from '../core/protocol';

/*
 * How corrallm ends (B14 C2, C4; B11 Design §8, §16.5): one coordinator for every way it may, by
 * reason. `user` is a quit you ask for (Cmd+Q and the app menu, the Dock's Quit, the menu-bar
 * item's or tray's Quit, and any before-quit it didn't start itself: main can't tell its own
 * signal from Cmd+Q); `last-window`, on Linux and Windows, the last window's close, decided before
 * that window is destroyed; `update`, Restart to update; `system`, the system's shutdown or logout
 * (powerMonitor's 'shutdown', the core closing itself on a signal, `exiting`, or exiting 0 unasked).
 *
 * While its agents work (the core's presence, `busy`, or none: a core coming up) it asks first,
 * and holds nothing while it asks: the question, worded from the core's bounded counts alone, is
 * always a sheet on a corrallm window (on macOS with none open, the reopen service makes one), so
 * the system can withdraw it (a parentless box on macOS runs synchronously, holding main's loop).
 * Quit and pause (Restart and pause, for an update) is the save below, work not rechecked; Keep
 * running closes every window on macOS and minimizes every one elsewhere, the core, its endpoint
 * and sessions untouched, and stays Keep running if the work ended while it asked; Cancel changes
 * nothing. Any of the three but Quit and pause clears an update's restart. With nothing at work it
 * saves at once, the core holding its barrier only if still nothing is (`ifIdle`, in one step),
 * else answering busy, and it asks then: work that started since main last heard is never cut off
 * unasked.
 *
 * Saving is Closing below: each window's drafts, then the core's barrier; a failure asks whether to
 * quit anyway (a sheet too), Keep corrallm open lifting the barrier. Then the core closes, and only
 * then does the app quit, or an update install. While it asks, another user, last-window or update
 * request joins the question (it focuses the sheet); while it saves, a second user quit is the
 * explicit five-second escape, and an update or last window waits; once approved, before-quit and
 * window closes stay prevented until the core has closed.
 *
 * The system's path asks nothing: it withdraws any question, gives drafts at most a second, then
 * the core's barrier for `system` and its close, saying a failure without values, and quits; a quit
 * already approved finishes instead. Five seconds after the signal main exits whatever is left: 0 if
 * the core closed, else 1, saying so once. A CLI the core couldn't end in time is ended as the next
 * core starts (Children recovery), and by the OS before that.
 *
 * Reopening (C10) is one service: Dock activation, the menus' Open, a second instance and a
 * notification's click restore a minimized window, else show the first, else make one (one at a
 * time); while it asks, they focus the question; once a quit is saving or approved, nothing. A click
 * then has the core resolve its opaque handle at that window (`activate`): the core tells that
 * window, over its port, what to show.
 */

export interface ClosingDeps {
  /** Presentation follows state changes; it never decides how this close proceeds. */
  changed?: () => void;
  /**
   * Saves the run while keeping the core usable: rejects saying why it could not; resolves false if
   * it decided not to close after all (nothing held), so it stays open.
   */
  save: () => Promise<unknown>;
  /** Closes without saving; only an explicit second-close escape may bound cleanup. Never rejects. */
  abandon: (escape?: true) => Promise<void>;
  /** Asks whether to close anyway, saying why saving failed: true if the user says so. */
  ask: (why: string) => Promise<boolean>;
  /** Closes: quits the app, or closes the window. */
  done: () => void;
}

/*
 * Quitting, or closing a window: first the run is saved (each renderer freezes it, the core
 * journals it). If that fails, the user is asked whether to close anyway, losing what wasn't
 * saved, or keep the app open and try again later. Asking to close again while it saves closes
 * without waiting for the save, as a way out of a save that hangs. The app's quit (QuitCoordinator)
 * keeps the same way out once closing is approved: quitting again bounds a core close that hangs.
 */
export class Closing {
  readonly #deps: ClosingDeps;
  #state: 'open' | 'saving' | 'asking' | 'closing' = 'open';

  constructor(deps: ClosingDeps) {
    this.#deps = deps;
  }

  /** Whether it is saving, or asking what to do after it could not. */
  get busy(): boolean {
    return this.#state === 'saving' || this.#state === 'asking';
  }

  /** Whether it may close now: once true, closing goes through. */
  get approved(): boolean {
    return this.#state === 'closing';
  }

  /** Asked to close: true if it may close now; otherwise it saves first, then closes itself. */
  request(): boolean {
    switch (this.#state) {
      case 'closing':
        return true;
      case 'saving':
        void this.#close(this.#deps.abandon(true));
        return false;
      case 'asking':
        return false;
      case 'open':
        this.#set('saving');
        this.#deps.save().then(
          (saved) => {
            if (saved !== false) void this.#close(Promise.resolve());
            else if (this.#state === 'saving') this.#set('open');
          },
          (error: unknown) => {
            void this.#failed(error);
          },
        );
        return false;
    }
  }

  async #failed(error: unknown): Promise<void> {
    if (this.#state !== 'saving') return;
    this.#set('asking');
    // While it asks, nothing else closes it (request() waits for the answer).
    const anyway = await this.#deps
      .ask(error instanceof Error ? error.message : String(error))
      .catch(() => false);
    if (anyway) await this.#close(this.#deps.abandon());
    else this.#set('open');
  }

  async #close(closed: Promise<void>): Promise<void> {
    if (this.#state === 'closing') return;
    this.#set('closing');
    await closed;
    this.#deps.done();
  }

  #set(state: 'open' | 'saving' | 'asking' | 'closing'): void {
    this.#state = state;
    try {
      this.#deps.changed?.();
    } catch {
      console.error('Could not update native close presentation.');
    }
  }
}

/** How long the system's shutdown or logout leaves corrallm, from its signal, before main exits. */
export const SYSTEM_BUDGET_MS = 5000;
/** How long an explicit second-quit escape waits for the core to close. */
export const ABANDON_MS = 5000;

export type QuitReason = 'user' | 'last-window' | 'update' | 'system';

/** A corrallm window, as quitting uses it: an Electron BrowserWindow in the app. */
export interface QuitWindow {
  readonly webContents: { readonly id: WindowId };
  isMinimized(): boolean;
  restore(): void;
  minimize(): void;
  show(): void;
  focus(): void;
  close(): void;
}

/** What quitting asks of the core main runs now (in the app, over its link). */
export interface QuitCore {
  /** What it last said it does (B14 C5): none before it says, or while a new one comes up. */
  presence(): Presence | undefined;
  /** Asks `windows` to finish their drafts: for `system`, at most a second in all. */
  flushDrafts(windows: WindowId[], reason?: 'system'): Promise<DraftsFlushed>;
  prepare(reason: ShutdownReason, options?: ShutdownOptions): Promise<ShutdownPrepared>;
  cancel(): Promise<unknown>;
  /** Closes it: resolves once it has closed, rejects if it couldn't (or it is gone). */
  commit(): Promise<unknown>;
  /** Has it resolve a notification's opaque handle at `window`, telling that window what to show. */
  activate(window: WindowId, handle: string): Promise<unknown>;
  /** Its process's exit code, once it has exited. */
  exited(): Promise<number>;
  /** Main is done with it: no exit from now on restarts it. */
  stop(): void;
}

/** What quitting needs of the app's updates (updates.ts). */
export interface QuitUpdates {
  /** Whether the quit asked for is Restart to update's. */
  readonly restarting: boolean;
  /** Installs, once the core has closed: true if it does (it quits the app itself). */
  finishQuit(): boolean;
  cancelRestart(): void;
}

export interface QuitDeps<W extends QuitWindow> {
  /** The native menu re-reads approved/saving/asking; no polling or lifecycle effect. */
  changed?: () => void;
  platform: NodeJS.Platform;
  /** The unpackaged e2e app: no window shown, and a failed save exits 1 rather than ask. */
  hidden: boolean;
  core: QuitCore;
  /** Every corrallm window open, and the focused one. */
  windows(): readonly W[];
  focused(): W | null;
  /** Makes a window, with the app's security and preload: resolves once it has loaded. */
  open(): Promise<W>;
  /** A message box, a sheet on `window` (its `signal` withdraws it): the button chosen. */
  ask(window: W, options: MessageBoxOptions): Promise<number>;
  quit(): void;
  exit(code: number): void;
  updates(): QuitUpdates | undefined;
  /** Says something on stderr. */
  log(...args: unknown[]): void;
  /**
   * What macOS's 'shutdown' (a logout, restart or power off) does: `wait`, prevented while
   * corrallm closes within its budget, then it quits itself (the default); or `at-once`, C4's
   * fallback if the signed logout check finds macOS cancels rather than waits: not prevented, the
   * core asked to save without waiting, and the quit let through at once, leaving the rest to the
   * core's own SIGTERM handling and the next start's recovery.
   */
  macShutdown?: 'wait' | 'at-once';
}

interface Question<W> {
  /** Restart to update's two-button question, rather than a quit's three. */
  readonly update: boolean;
  /** The window it is a sheet on, once it has one. */
  window: W | undefined;
}

type Answer = 'quit' | 'keep' | 'cancel';
const QUIT_ANSWERS: readonly Answer[] = ['quit', 'keep', 'cancel'];

/** One coordinator for how corrallm ends (above). */
export class QuitCoordinator<W extends QuitWindow> {
  readonly #deps: QuitDeps<W>;
  /** The app's quit: its drafts and barrier, a failed save's question, then the core's close. */
  readonly #quit: Closing;
  /** Each window's own close: its drafts, then the window (B11 Design §8). */
  #windows = new WeakMap<W, Closing>();
  /** Withdraws every question quitting puts up, once the system's shutdown takes over. */
  readonly #withdraw = new AbortController();
  #question: Question<W> | undefined;
  /** Why the quit now asked for was: a question for `update` has two buttons. */
  #reason: QuitReason = 'user';
  /** Whether the quit's next save has the core hold its barrier only if idle. */
  #ifIdle = false;
  /** A window being made, which every reopen meanwhile shares. */
  #making: Promise<W | undefined> | undefined;
  /** The core's close, once begun: whether it closed. */
  #closing: Promise<boolean> | undefined;
  #closeError: unknown;
  #coreClosed = false;
  /** Whether main is done with the core (its supervision stopped). */
  #stopped = false;
  /** An approved quit's wait for the core's close, which only an explicit second quit bounds. */
  #finishing: Promise<void> | undefined;
  readonly #escaped = Promise.withResolvers<undefined>();
  #escapeTimer: ReturnType<typeof setTimeout> | undefined;
  #failed = false;
  /** Whether the quit may go through now: before-quit and window closes are let be. */
  #ready = false;
  /** The system's path, once begun. */
  #system: Promise<void> | undefined;
  #budget: ReturnType<typeof setTimeout> | undefined;
  /** Whether the system's path has ended, quitting or exiting. */
  #systemEnded = false;

  constructor(deps: QuitDeps<W>) {
    this.#deps = deps;
    this.#quit = new Closing({
      changed: () => {
        this.#changed();
      },
      save: () => this.#save(),
      abandon: (escape) => this.#abandon(escape),
      ask: (why) => this.#askAnyway(why, 'Quit'),
      done: () => {
        this.#done();
      },
    });
  }

  #changed(): void {
    try {
      this.#deps.changed?.();
    } catch {
      this.#deps.log('Could not update native quit presentation.');
    }
  }

  /** Whether the system's shutdown or logout has taken over (read afresh after each await). */
  #systemShutdown(): boolean {
    return this.#system !== undefined;
  }

  /** Whether corrallm is closing for good: an approved quit, or the system's path. */
  get approved(): boolean {
    return this.#quit.approved || this.#system !== undefined;
  }

  /** Whether a quit is saving, or asking what to do after it could not (Pause all waits). */
  get saving(): boolean {
    return this.#quit.busy;
  }

  /** Whether the quit question is up. */
  get asking(): boolean {
    return this.#question !== undefined;
  }

  /** A quit asked for, for `reason`. */
  request(reason: QuitReason): void {
    if (reason === 'system') {
      this.#systemPath();
      return;
    }
    if (this.approved) return;
    if (this.#question) {
      this.#focus(this.#question.window);
      return;
    }
    if (this.#quit.busy) {
      // Only you quitting again is the escape; an update or the last window waits for this quit.
      if (reason === 'user') this.#quit.request();
      return;
    }
    this.#reason = reason;
    const presence = this.#deps.core.presence();
    if (presence === undefined || presence.busy) {
      void this.#ask(presence);
      return;
    }
    this.#ifIdle = true;
    this.#quit.request();
  }

  /** The app's before-quit: prevented unless this quit is ready to go. */
  beforeQuit(event: { preventDefault(): void }): void {
    if (this.#ready) return;
    event.preventDefault();
    if (this.#system) return;
    // Quitting again while the approved close hangs gives it the escape's last few seconds.
    if (this.#quit.approved) {
      void this.#abandon(true);
      return;
    }
    this.request('user');
  }

  /** A window's close: a view close, unless it is the last on Linux or Windows. */
  windowClosing(window: W, event: { preventDefault(): void }): void {
    if (this.#ready) return;
    // Closing for good, or saving to: every window waits for it.
    if (this.approved || this.#quit.busy) {
      event.preventDefault();
      return;
    }
    // The window the question is a sheet on stays while it asks: closing it joins the question.
    if (this.#question !== undefined && this.#question.window === window) {
      event.preventDefault();
      this.#focus(window);
      return;
    }
    if (this.#deps.platform !== 'darwin' && this.#last(window)) {
      event.preventDefault();
      // Decided before the window is destroyed, so Cancel can keep it. Its next close, if another
      // window has come meanwhile, saves its drafts again.
      if (this.#windows.get(window)?.approved === true) this.#windows.delete(window);
      this.request('last-window');
      return;
    }
    if (!this.#closer(window).request()) event.preventDefault();
  }

  /** Every window is gone, one without its close (destroyed): on Linux and Windows, the last. */
  allClosed(): void {
    if (this.#deps.platform === 'darwin' || this.#ready) return;
    this.request('last-window');
  }

  /** powerMonitor's 'shutdown' (macOS: logout, restart, power off; Linux: reboot, power off). */
  shutdown(event?: { preventDefault(): void }): void {
    if (this.#deps.platform === 'darwin' && this.#deps.macShutdown === 'at-once') {
      this.#atOnce();
      return;
    }
    event?.preventDefault();
    this.request('system');
  }

  /** Shows a window (C10): the one asking, a minimized one, the first, or a new one. */
  reopen(): Promise<W | undefined> {
    if (this.approved || this.#quit.busy || this.#ready) return Promise.resolve(undefined);
    if (this.#question) {
      this.#focus(this.#question.window);
      return Promise.resolve(this.#question.window);
    }
    const windows = this.#deps.windows();
    const window = windows.find((one) => one.isMinimized()) ?? windows[0];
    if (window !== undefined) {
      this.#focus(window);
      return Promise.resolve(window);
    }
    return this.#make();
  }

  /** A notification clicked: a window shown, then the core resolves its handle at that window. */
  async activate(handle: string): Promise<void> {
    const window = await this.reopen();
    if (window === undefined) return;
    await this.#deps.core.activate(window.webContents.id, handle).catch((error: unknown) => {
      this.#deps.log('Could not show what the notification was about:', error);
    });
  }

  /** A failure that makes the approved quit exit 1, said on stderr. */
  fail(why: string, error: unknown): void {
    const alreadyFailed = this.#failed;
    this.#failed = true;
    this.#deps.log(why, error);
    if (this.#ready && !alreadyFailed) this.#deps.exit(1);
  }

  /** Whether `window` is the last: every other window is closing or gone. */
  #last(window: W): boolean {
    return this.#deps.windows().every((other) => other === window || this.#leaving(other));
  }

  /** Whether `window` is closing: saving its drafts, asking about them, or approved. */
  #leaving(window: W): boolean {
    const close = this.#windows.get(window);
    return close !== undefined && (close.busy || close.approved);
  }

  /** `window`'s own close: its drafts, then the window; quitting meanwhile owns it. */
  #closer(window: W): Closing {
    let close = this.#windows.get(window);
    if (close === undefined) {
      close = new Closing({
        save: () => this.#flush([window]),
        abandon: () => Promise.resolve(),
        // A window's earlier save can settle after the app has taken over shutdown. Its result
        // cannot reopen a question or turn that approved quit into a save failure.
        ask: (why) =>
          this.approved ? Promise.resolve(false) : this.#askAnyway(why, 'Close', window),
        done: () => {
          if (!this.approved) window.close();
        },
      });
      this.#windows.set(window, close);
    }
    return close;
  }

  /** Each of `windows` finishes its drafts, over its own port: rejects if one didn't. */
  async #flush(windows: readonly W[]): Promise<void> {
    const { unanswered } = await this.#deps.core.flushDrafts(
      windows.map((window) => window.webContents.id),
    );
    if (unanswered.length > 0) {
      throw new Error(
        unanswered.length === 1
          ? 'A window did not finish saving what was being typed in it before closing'
          : `${String(unanswered.length)} windows did not finish saving what was being typed in them before closing`,
      );
    }
  }

  /**
   * The quit's save: every window's drafts, then the core's barrier: no new dispatch or write,
   * everything forced to disk, sessions still usable. Every run is the core's (B11 §8). False, the
   * question asked, if the core found work at it.
   */
  async #save(): Promise<boolean> {
    const ifIdle = this.#ifIdle;
    this.#ifIdle = false;
    await this.#flush(this.#deps.windows());
    const reason = this.#deps.updates()?.restarting === true ? 'update' : 'quit';
    const prepared = await (ifIdle
      ? this.#deps.core.prepare(reason, { ifIdle: true })
      : this.#deps.core.prepare(reason));
    if ('busy' in prepared) {
      if (!this.approved) void this.#ask(prepared.busy);
      return false;
    }
    if ('failed' in prepared) throw new Error(prepared.sentence);
    return true;
  }

  /** Asks whether to quit while work goes on (`presence`, or none known), and does what it says. */
  async #ask(presence: Presence | undefined): Promise<void> {
    if (this.approved) return;
    const question: Question<W> = { update: this.#reason === 'update', window: undefined };
    this.#question = question;
    this.#changed();
    let answer: Answer = 'cancel';
    try {
      const window = await this.#sheet();
      if (window !== undefined && !this.#system) {
        question.window = window;
        const response = await this.#deps.ask(window, {
          ...quitQuestion(question.update, presence, this.#deps.platform),
          signal: this.#withdraw.signal,
        });
        answer = question.update
          ? response === 0
            ? 'quit'
            : 'cancel'
          : (QUIT_ANSWERS[response] ?? 'cancel');
      }
    } catch (error) {
      this.#deps.log('Could not ask before quitting:', error);
    } finally {
      this.#question = undefined;
      this.#changed();
    }
    // Withdrawn: the system's shutdown goes on.
    if (this.#system) return;
    if (answer === 'quit') {
      this.#quit.request();
      return;
    }
    this.#deps.updates()?.cancelRestart();
    if (answer === 'keep') this.#keepRunning();
  }

  /** Keep running: the views go (closed on macOS, minimized elsewhere); everything else goes on. */
  #keepRunning(): void {
    for (const window of this.#deps.windows()) {
      if (this.#deps.platform === 'darwin') window.close();
      else window.minimize();
    }
  }

  /**
   * The window a question is a sheet on: the focused one, else the first, never one closing (the
   * last window's close asks on it), else a new one.
   */
  #sheet(): Promise<W | undefined> {
    const focused = this.#deps.focused();
    const window =
      focused !== null && !this.#leaving(focused)
        ? focused
        : this.#deps.windows().find((one) => !this.#leaving(one));
    if (window === undefined) return this.#make();
    this.#focus(window);
    return Promise.resolve(window);
  }

  #focus(window: W | undefined): void {
    if (window === undefined) return;
    if (window.isMinimized()) window.restore();
    if (!this.#deps.hidden) window.show();
    window.focus();
  }

  /** Makes a window, one at a time: every reopen meanwhile shares it. */
  #make(): Promise<W | undefined> {
    this.#making ??= this.#deps
      .open()
      .then(
        (window) => window,
        (error: unknown) => {
          this.#deps.log('Could not open corrallm’s window:', error);
          return undefined;
        },
      )
      .finally(() => {
        this.#making = undefined;
      });
    return this.#making;
  }

  /** Whether to quit (or close the window) anyway after a failed save: a sheet, withdrawable. */
  async #askAnyway(why: string, verb: 'Quit' | 'Close', window?: W): Promise<boolean> {
    this.#deps.log('Could not save before closing:', why);
    // The system's shutdown has taken over: it closes whatever was saved, asking nothing.
    if (this.#systemShutdown()) return false;
    if (this.#deps.hidden) {
      await this.#abandon();
      this.#deps.exit(1);
      return false;
    }
    const parent = window ?? (await this.#sheet());
    const response =
      parent === undefined
        ? 0
        : await this.#deps.ask(parent, {
            type: 'warning',
            message: 'The run could not be saved',
            // A window only views its canvas: closing it ends no session (B11 Design §8).
            detail:
              verb === 'Quit'
                ? `${why}\n\nQuit anyway? What wasn't saved is lost, and the agents' sessions end.`
                : `${why}\n\nClose anyway? What wasn't saved is lost; the agents go on working.`,
            buttons: ['Keep corrallm open', `${verb} anyway`],
            defaultId: 0,
            cancelId: 0,
            signal: this.#withdraw.signal,
          });
    // Withdrawn: the system's shutdown goes on, lifting nothing.
    if (this.#systemShutdown()) return false;
    if (verb === 'Quit' && response !== 1) {
      this.#deps.updates()?.cancelRestart();
      // Keep corrallm open: the barrier lifts, and the endpoint and every turn go on.
      await this.#deps.core.cancel().catch((error: unknown) => {
        this.#deps.log('Could not keep the core going:', error);
      });
    }
    return response === 1;
  }

  /** The approved quit: once the core has closed, quit, or install an update. */
  #done(): void {
    void this.#abandon().then(() => {
      // The system's shutdown took over meanwhile: it quits, and installs nothing.
      if (this.#system) return;
      this.#ready = true;
      this.#changed();
      if (this.#failed) {
        this.#deps.exit(1);
        return;
      }
      // quitAndInstall closes windows before before-quit: call it only after saving and core
      // shutdown have been approved here, never straight from the update dialog.
      if (this.#deps.updates()?.finishQuit() !== true) this.#deps.quit();
    });
  }

  /**
   * Waits for the core's close (once). An approved quit waits for all of it: only a second quit,
   * while saving or the core's close is stuck, bounds that wait, as your explicit escape.
   */
  #abandon(escape?: true): Promise<void> {
    this.#finishing ??= this.#finish();
    if (escape && !this.#ready) {
      this.#escapeTimer ??= setTimeout(() => {
        this.#escaped.resolve(undefined);
      }, ABANDON_MS);
    }
    return this.#finishing;
  }

  async #finish(): Promise<void> {
    const closed = this.#closeCore().then((ok) => {
      if (!ok && !this.#system) this.fail('Could not finish closing the core:', this.#closeError);
    });
    try {
      await Promise.race([closed, this.#escaped.promise]);
    } finally {
      clearTimeout(this.#escapeTimer);
    }
  }

  /**
   * The shutdown barrier committed, once: the endpoint closes, then every session and the stores.
   * Supervision stops first, so the core's exit restarts nothing. Whether it closed.
   */
  #closeCore(): Promise<boolean> {
    this.#closing ??= (async () => {
      this.#stopCore();
      try {
        await this.#deps.core.commit();
        this.#coreClosed = true;
        return true;
      } catch (error) {
        this.#closeError = error;
        return false;
      }
    })();
    return this.#closing;
  }

  /** Main is done with the core, once: no exit from now on restarts it. */
  #stopCore(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#deps.core.stop();
  }

  /** The system's shutdown or logout (C4): no question, a bounded save, then quit. */
  #systemPath(): void {
    if (this.#system !== undefined) return;
    this.#stopCore();
    this.#withdraw.abort();
    this.#budget = setTimeout(() => {
      this.#outOfTime();
    }, SYSTEM_BUDGET_MS);
    this.#system = this.#closeForSystem();
    this.#changed();
  }

  async #closeForSystem(): Promise<void> {
    // A quit already approved finishes; otherwise drafts land before the barrier refuses them.
    if (!this.#quit.approved) {
      await this.#flushForSystem();
      try {
        const prepared = await this.#deps.core.prepare('system');
        // No question on this path: what is on disk stands, and the close goes on.
        if ('failed' in prepared)
          this.#deps.log('corrallm: not everything could be saved as it closed.');
      } catch {
        // The core is gone: it closed itself (exiting), or its exit says how it went.
      }
    }
    let closed = await this.#closeCore();
    if (!closed) {
      // A core that closed itself (a signal) and exited 0 has closed; any other exit hasn't.
      closed = (await this.#deps.core.exited().catch(() => 1)) === 0;
      if (closed) this.#coreClosed = true;
    }
    this.#endSystem(closed);
  }

  /** Every window's drafts, at most a second in all: what didn't land is said, without values. */
  async #flushForSystem(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<'late'>((resolve) => {
      timer = setTimeout(() => {
        resolve('late');
      }, SYSTEM_DRAFTS_MS);
    });
    try {
      const flushed = await Promise.race([
        this.#deps.core.flushDrafts(
          this.#deps.windows().map((window) => window.webContents.id),
          'system',
        ),
        late,
      ]);
      if (flushed === 'late' || flushed.unanswered.length > 0)
        this.#deps.log('corrallm: what was being typed in a window may not have been saved.');
    } catch {
      // The core is gone: it closed itself, its windows' drafts first.
    } finally {
      clearTimeout(timer);
    }
  }

  #endSystem(closed: boolean): void {
    if (this.#systemEnded) return;
    this.#systemEnded = true;
    clearTimeout(this.#budget);
    if (closed) {
      this.#ready = true;
      this.#deps.quit();
      return;
    }
    this.#deps.log(
      'corrallm: its core didn’t close cleanly; it ends what was left as it next starts.',
    );
    this.#deps.exit(1);
  }

  /** The system's budget is spent: main exits, 0 if the core closed, else 1, saying so. */
  #outOfTime(): void {
    if (this.#systemEnded) return;
    this.#systemEnded = true;
    if (this.#coreClosed) {
      this.#deps.exit(0);
      return;
    }
    this.#deps.log(
      'corrallm: its core didn’t close within five seconds of the system’s shutdown or logout; it ends what was left as it next starts.',
    );
    this.#deps.exit(1);
  }

  /** macOS's fallback (`at-once`): the logout goes on now; the core is asked, not waited for. */
  #atOnce(): void {
    if (this.#system === undefined) {
      this.#stopCore();
      this.#withdraw.abort();
      const windows = this.#deps.windows().map((window) => window.webContents.id);
      void this.#deps.core.flushDrafts(windows, 'system').catch(() => undefined);
      void this.#deps.core.prepare('system').catch(() => undefined);
      this.#system = Promise.resolve();
    }
    this.#systemEnded = true;
    clearTimeout(this.#budget);
    this.#ready = true;
    this.#changed();
    this.#deps.quit();
  }
}

/** A count as main shows it: at most "99+". */
function shown(count: number): string {
  return count > 99 ? '99+' : String(count);
}

/**
 * The quit question (C2), from the core's bounded counts alone (no name, path or text): the first
 * cause that applies, never "0 agents". A job (a worktree's setup, creation or removal, or a
 * message being handed to an idle session) is said generically, the counts not saying which.
 */
export function quitQuestion(
  update: boolean,
  presence: Presence | undefined,
  platform: NodeJS.Platform,
): MessageBoxOptions {
  const message =
    presence === undefined
      ? 'corrallm couldn’t check whether its agents are working.'
      : presence.working === 1
        ? 'An agent is working.'
        : presence.working > 1
          ? `${shown(presence.working)} agents are working.`
          : presence.runs === 1
            ? 'A run is going on a canvas.'
            : presence.runs > 1
              ? `A run is going on ${shown(presence.runs)} canvases.`
              : 'corrallm is finishing some work for its agents.';
  if (update) {
    return {
      type: 'question',
      message,
      detail: 'Restart and pause ends their sessions, and each run opens paused next time.',
      buttons: ['Restart and pause', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    };
  }
  const keep =
    platform === 'darwin'
      ? 'Keep running closes the windows; the agents go on, shown in the menu bar and the Dock.'
      : 'Keep running minimizes corrallm; the agents go on.';
  return {
    type: 'question',
    message,
    detail: `Quit and pause ends their sessions, and each run opens paused next time. ${keep}`,
    buttons: ['Quit and pause', 'Keep running', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  };
}
