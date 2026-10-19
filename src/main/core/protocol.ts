import type { HostServices, WindowId } from './host';
import type { LockHolder } from './lock';
import type { CheckResult } from './selftest';

/*
 * What main and the core process ask and tell each other, over CoreLink on the core's parentPort
 * (entry.ts in the core, host/core-process.ts in main). Main asks the app's core up (`init`), or,
 * in the native self-test, only for its checks; it answers what the core asks of the desktop
 * (HostServices) and tells it when a window is gone. Each window's port crosses the same
 * parentPort beside the link, in a message of its own (WindowMessage), its port transferred.
 */

/** What the core process answers and sends. */
export interface CoreSide {
  requests: {
    /**
     * Takes the profile (core.lock) and composes the app's core on it: windows' ports are served
     * once it has.
     */
    init: { args: [config: CoreInit]; result: CoreInitAnswer };
    /** Which windows have a canvas to freeze/save before closing. */
    shown: { args: [windows: WindowId[]]; result: WindowId[] };
    /** Finishes fallible writes before closing is approved, leaving the core usable on failure. */
    flush: { args: []; result: null };
    /**
     * Stops the core and writes out everything it owns before the app quits, then lets the profile
     * go.
     */
    close: { args: []; result: null };
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
