import { EventEmitter } from 'node:events';

import { MAX_NOTIFICATION_BODY_BYTES, MAX_NOTIFICATION_TITLE_BYTES } from '../core/presence';

/*
 * For main's tests (B14 X6): Electron's main-process `Notification`, faked, holding main's adapter
 * to what C8 and C9 allow. Mock electron with it (`vi.mock('electron', () => ({ Notification:
 * FakeNotification, ... }))`), then drive what the OS would do (`click()`, `fail()`, `dismiss()`).
 *
 * The contract it checks as each one is made: only the core's `title` and `body`, within their
 * bounds, and at most an `id` that is the core's opaque UUID handle. No subtitle, action, reply
 * field, icon, sound, urgency, group or toastXml (C8: nothing excluded rides in another field, and
 * nothing a notification offers acts). `isSupported()` counts its calls (`asked`): it creates the
 * OS presenter, which on macOS asks for authorization (F5), so C9's timing is testable: never at
 * launch, the first time presence shows an agent working while notifications are on, never again.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ALLOWED = new Set(['title', 'body', 'id']);

export class FakeNotification extends EventEmitter {
  /** What `isSupported()` answers (Linux without libnotify: false). */
  static supported = true;
  /** How often `isSupported()` was asked: each may create the OS presenter. */
  static asked = 0;
  /** Every notification made, in order. */
  static made: FakeNotification[] = [];
  /** The ids `Notification.remove` was given. */
  static removed: string[] = [];

  static isSupported(): boolean {
    FakeNotification.asked += 1;
    return FakeNotification.supported;
  }

  static remove(id: string | string[]): void {
    FakeNotification.removed.push(...(Array.isArray(id) ? id : [id]));
  }

  /** Forgets every notification and count: in each test's `beforeEach`. */
  static reset(): void {
    FakeNotification.supported = true;
    FakeNotification.asked = 0;
    FakeNotification.made = [];
    FakeNotification.removed = [];
  }

  readonly title: string;
  readonly body: string;
  readonly id: string | undefined;
  shown = 0;
  closed = 0;

  constructor(options: Record<string, unknown> = {}) {
    super();
    for (const key of Object.keys(options)) {
      if (!ALLOWED.has(key)) throw new Error(`A notification carries no ${key} (B14 C8).`);
    }
    const { title, body, id } = options;
    if (
      typeof title !== 'string' ||
      Buffer.byteLength(title, 'utf8') > MAX_NOTIFICATION_TITLE_BYTES
    )
      throw new Error('A notification’s title is the core’s, within 32 bytes.');
    if (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > MAX_NOTIFICATION_BODY_BYTES)
      throw new Error('A notification’s body is the core’s, within 160 bytes.');
    if (id !== undefined && (typeof id !== 'string' || !UUID.test(id)))
      throw new Error('A notification’s id is only the core’s opaque handle.');
    this.title = title;
    this.body = body;
    this.id = id;
    FakeNotification.made.push(this);
  }

  show(): void {
    this.shown += 1;
  }

  close(): void {
    this.closed += 1;
  }

  /** The OS showed it. */
  appear(): void {
    this.emit('show', {});
  }

  /** You clicked it. */
  click(): void {
    this.emit('click', {});
  }

  /** You dismissed it (not guaranteed to be heard on every platform: F5). */
  dismiss(): void {
    this.emit('close', {});
  }

  /** The OS couldn't show it (an unsigned macOS app, no notification server). */
  fail(error = 'failed'): void {
    this.emit('failed', {}, error);
  }
}
