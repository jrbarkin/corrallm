import type { HostServices } from '../core/host';
import { NotificationRequest } from '../core/presence';
import type { NotificationResult } from '../core/presence';

/** A missing native delivery event is a failed attempt, never an unbounded core request. */
export const NOTIFICATION_SHOW_MS = 5000;
const MAX_HELD = 256;

export interface NotificationHandle {
  on(event: 'show' | 'failed' | 'click' | 'close', listener: () => void): unknown;
  show(): void;
  close(): void;
}
export interface NotificationBackend {
  supported(): boolean;
  create(options: { title: string; body: string }): NotificationHandle;
}
interface Held {
  native: NotificationHandle;
  result: Promise<NotificationResult>;
  settle(result: NotificationResult): void;
}
export interface NativeNotificationsDeps {
  hidden?: boolean;
  backend: NotificationBackend;
  focused(): boolean;
  current(): boolean;
  activate(handle: string): Promise<void>;
  log(message: string): void;
}

/** Native delivery only: the core owns preference checks, eligibility, text and destinations. */
export class NativeNotifications {
  readonly #deps: NativeNotificationsDeps;
  readonly #held = new Map<string, Held>();
  #prepared = false;
  #supported = false;
  #closed = false;

  constructor(deps: NativeNotificationsDeps) {
    this.#deps = deps;
  }

  /** C9's trusted cue: the first working presence while notifications are enabled. */
  prepare(working: number, enabled: boolean): void {
    if (
      this.#deps.hidden ||
      this.#closed ||
      this.#prepared ||
      working <= 0 ||
      !enabled ||
      !this.#deps.current()
    )
      return;
    this.#prepared = true;
    try {
      this.#supported = this.#deps.backend.supported();
    } catch {
      this.#deps.log('corrallm could not prepare native notifications.');
    }
  }

  notify(request: NotificationRequest): Promise<NotificationResult> {
    if (this.#deps.hidden || this.#closed || !this.#deps.current() || this.#deps.focused())
      return Promise.resolve('suppressed');
    if (!this.#supported) return Promise.resolve('unsupported');
    const parsed = NotificationRequest.safeParse(request);
    if (!parsed.success) return Promise.resolve('failed');
    const { handle, title, body } = parsed.data;
    const previous = this.#held.get(handle);
    if (previous !== undefined) return previous.result;
    if (this.#held.size >= MAX_HELD) return Promise.resolve('failed');
    let native: NotificationHandle;
    try {
      native = this.#deps.backend.create({ title, body });
    } catch {
      return Promise.resolve('failed');
    }
    const result = Promise.withResolvers<NotificationResult>();
    const timer = setTimeout(() => {
      this.#remove(handle, held, 'failed');
    }, NOTIFICATION_SHOW_MS);
    let clicked = false;
    const held: Held = {
      native,
      result: result.promise,
      settle: (status) => {
        clearTimeout(timer);
        result.resolve(status);
      },
    };
    this.#held.set(handle, held);
    native.on('show', () => {
      held.settle('shown');
    });
    native.on('failed', () => {
      this.#remove(handle, held, 'failed');
    });
    native.on('close', () => {
      this.#remove(handle, held, 'failed', false);
    });
    native.on('click', () => {
      if (clicked || this.#closed || !this.#deps.current() || this.#held.get(handle) !== held)
        return;
      clicked = true;
      void this.#deps.activate(handle).catch(() => {
        this.#deps.log('corrallm could not open a notification.');
      });
    });
    try {
      if (!this.#deps.current() || this.#deps.focused()) this.#remove(handle, held, 'suppressed');
      else native.show();
    } catch {
      this.#remove(handle, held, 'failed');
    }
    return result.promise;
  }

  unnotify(handle: string): void {
    const held = this.#held.get(handle);
    if (held !== undefined) this.#remove(handle, held, 'suppressed');
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const [handle, held] of this.#held) this.#remove(handle, held, 'suppressed');
  }

  #remove(handle: string, held: Held, result: NotificationResult, close = true): void {
    if (this.#held.get(handle) !== held) return;
    this.#held.delete(handle);
    held.settle(result);
    if (close) {
      try {
        held.native.close();
      } catch {
        this.#deps.log('corrallm could not close a notification.');
      }
    }
  }
}

/**
 * What main hands the core's host services of the native notifications (B14 §9.4): the presence
 * snapshot's `working` and `notify` as C9's authorization cue, and the core's notify and unnotify.
 * The one place the three are joined, so main's wiring and its tests are the same.
 */
export function nativePresentation(
  native: NativeNotifications,
): Pick<HostServices, 'presence' | 'notify' | 'unnotify'> {
  return {
    presence: (snapshot) => {
      native.prepare(snapshot.working, snapshot.notify);
    },
    notify: (request) => native.notify(request),
    unnotify: (handle) => {
      native.unnotify(handle);
    },
  };
}
