import type { HostServices, WindowId } from './host';
import type { LockHolder } from './lock';
import type { CheckResult } from './selftest';

/*
 * What main and the core process ask and tell each other, over CoreLink on the core's parentPort
 * (entry.ts in the core, host/core-process.ts in main). Main asks the app's core up (`init`), or,
 * in the native self-test, only for its checks; it answers what the core asks of the desktop
 * (HostServices) and tells it when a window is gone, or gains focus. Each window's port crosses the same
 * parentPort beside the link, in a message of its own (WindowMessage), its port transferred.
 */

/** Why the core's shutdown barrier is prepared: the app quits, or restarts to install an update. */
export type ShutdownReason = 'quit' | 'update';

/** What preparing the shutdown barrier says: done, or what it couldn't write (the barrier held). */
export type ShutdownPrepared = { ok: true } | { failed: true; sentence: string };

/** How a draft flush went: the windows that didn't answer in time, or answered with an error. */
export interface DraftsFlushed {
  unanswered: WindowId[];
}

/** What the core process answers and sends. */
export interface CoreSide {
  requests: {
    /**
     * Takes the profile (core.lock) and composes the app's core on it: windows' ports are served
     * once it has, and its outside endpoint (MCP on 127.0.0.1, api.json) is started.
     */
    init: { args: [config: CoreInit]; result: CoreInitAnswer };
    /** Which windows have a canvas to freeze/save before closing (until B11 X12's cutover). */
    shown: { args: [windows: WindowId[]]; result: WindowId[] };
    /** A link chosen in main's native UI, dispatched as link.open at a connected window. */
    openLink: { args: [window: WindowId, url: string]; result: null };
    /**
     * Asks each window, over its own port, to finish the drafts it is composing (`drafts.flush`),
     * at most DRAFTS_MS each: those that didn't. A window with no port (crashed, gone, still
     * loading) is skipped.
     */
    flushDrafts: { args: [windows: WindowId[]]; result: DraftsFlushed };
    /**
     * Finishes fallible writes before a window's close is approved, leaving the core usable on
     * failure (until B11 X12: a window then owns its canvas's run).
     */
    flush: { args: []; result: null };
    /**
     * Prepares the shutdown barrier (B11 Design §16.5): no new dispatch, no write admitted, every
     * journal and store forced; sessions stay usable. Idempotent until cancelled.
     */
    prepareShutdown: { args: [reason: ShutdownReason]; result: ShutdownPrepared };
    /** Lifts the barrier (Keep corrallm open): everything goes on as before. */
    cancelShutdown: { args: []; result: null };
    /**
     * Commits: the endpoint closed (requests going on ended, api.json removed), then every session
     * ended, children and the database closed, then the profile let go. Idempotent.
     */
    commitShutdown: { args: []; result: null };
    /** Whether a canvas the core runs has work going on: a run running, or a turn. */
    active: { args: []; result: boolean };
    /** Runs the native self-test's checks (`packaged`: whether the app is) and reports them. */
    selftest: { args: [options: { packaged: boolean }]; result: SelfTestReport };
  };
  events: {
    /** The core is up and listening, using this much memory. */
    ready: [memory: string];
  };
}

/**
 * What `init` answers: null once the core holds the profile and is composed; or, while another
 * process holds the profile (`corrallm serve`), who does, as its lock says (null if it can't be
 * read), the core having composed nothing.
 */
export type CoreInitAnswer = null | { profileLocked: { holder: LockHolder | null } };

/** What the app's core is composed with. */
export interface CoreInit {
  /** Which app this is, as app.info says. */
  app: { name: string; version: string };
  profile: string;
  distribution: typeof CORRALLM_DISTRIBUTION;
  locale: string;
  /** Main admits CORRALLM_FAKE_SESSIONS only in an unpackaged build. */
  fakeSessions: boolean;
}

/**
 * What main answers and sends the core process. Each of HostServices, answered by main's own
 * (host/services.ts): a path a dialog picked crosses as a plain string, which the core's side
 * brands (core/host/app.ts).
 */
export interface HostSide {
  requests: {
    [K in keyof HostServices]: {
      args: Parameters<HostServices[K]>;
      result: K extends 'pickCanvasToOpen' | 'pickCanvasToSave' | 'pickFolder'
        ? string | null
        : Awaited<ReturnType<HostServices[K]>>;
    };
  };
  events: {
    /** The window closed, crashed or reloaded: its port to the core is done. */
    windowGone: [window: WindowId, closed?: boolean];
    /** The window gained focus: the canvas it shows has its file checked (B9 Design §5). */
    windowFocused: [window: WindowId];
    /** The machine woke: recheck silent turns with a short fresh grace period. */
    resumed: [];
  };
}

/** A window's port, handed to the core beside the link: the port is the message's one transfer. */
export interface WindowMessage {
  kind: 'window';
  window: WindowId;
}

/** Whether what main posted on the core's parentPort is a window's port rather than the link's. */
export function isWindowMessage(data: unknown): data is WindowMessage {
  if (typeof data !== 'object' || data === null) return false;
  const { kind, window } = data as Record<string, unknown>;
  return kind === 'window' && Number.isInteger(window);
}

export interface SelfTestReport {
  checks: CheckResult[];
  /** The core's memory once the checks have run. */
  memory: string;
}
