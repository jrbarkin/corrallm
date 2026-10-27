import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { NativeNotifications, NOTIFICATION_SHOW_MS } from './notifications';
import type { NotificationBackend, NotificationHandle } from './notifications';

const REQUEST = {
  handle: 'a766d650-cfb7-453f-9be4-f1e83de67fd5',
  title: 'corrallm',
  body: 'A worktree’s setup is waiting for you',
};
class FakeNotification extends EventEmitter implements NotificationHandle {
  show = vi.fn();
  close = vi.fn();
}
class FakeNotifications implements NotificationBackend {
  supported = vi.fn(() => true);
  made: { options: { title: string; body: string }; notification: FakeNotification }[] = [];
  create(options: { title: string; body: string }): NotificationHandle {
    const notification = new FakeNotification();
    this.made.push({ options, notification });
    return notification;
  }
}
function world(hidden = false) {
  const backend = new FakeNotifications();
  const state = { focused: false, current: true };
  const activate = vi.fn(() => Promise.resolve());
  const notifications = new NativeNotifications({
    hidden,
    backend,
    focused: () => state.focused,
    current: () => state.current,
    activate,
    log: vi.fn(),
  });
  return { backend, state, activate, notifications };
}
afterEach(() => {
  vi.useRealTimers();
});

describe('native notifications', () => {
  it('rechecks focus immediately before show, after native construction', async () => {
    const w = world();
    w.notifications.prepare(1, true);
    const create = w.backend.create.bind(w.backend);
    vi.spyOn(w.backend, 'create').mockImplementation((options) => {
      const native = create(options);
      w.state.focused = true;
      return native;
    });
    const shown = w.notifications.notify(REQUEST);
    try {
      expect(w.backend.made[0]?.notification.show).not.toHaveBeenCalled();
      expect(await shown).toBe('suppressed');
    } finally {
      w.notifications.close();
      await shown;
    }
  });

  it('holds at most 256 native objects and deduplicates a repeated live handle even at that bound', async () => {
    const w = world();
    w.notifications.prepare(1, true);
    const handles: string[] = [];
    for (let i = 0; i < 256; i += 1) {
      const handle = crypto.randomUUID();
      handles.push(handle);
      const shown = w.notifications.notify({ ...REQUEST, handle });
      w.backend.made.at(-1)?.notification.emit('show');
      expect(await shown).toBe('shown');
    }
    const first = handles[0];
    if (first === undefined) throw new Error('no held notification');
    expect(await w.notifications.notify({ ...REQUEST, handle: first })).toBe('shown');
    expect(await w.notifications.notify({ ...REQUEST, handle: crypto.randomUUID() })).toBe(
      'failed',
    );
    expect(w.backend.made).toHaveLength(256);
    w.notifications.close();
    expect(
      w.backend.made.every(({ notification }) => notification.close.mock.calls.length === 1),
    ).toBe(true);
  });

  it('prepares authorization once, only for enabled notifications and a working agent', () => {
    const w = world();
    w.notifications.prepare(0, true);
    w.notifications.prepare(1, false);
    expect(w.backend.supported).not.toHaveBeenCalled();
    w.notifications.prepare(1, true);
    w.notifications.prepare(5, true);
    expect(w.backend.supported).toHaveBeenCalledOnce();
    expect(w.backend.made).toEqual([]);
    w.notifications.close();
  });

  it('the hidden e2e host asks for no native authorization and shows no notification', async () => {
    const w = world(true);
    w.notifications.prepare(1, true);
    expect(await w.notifications.notify(REQUEST)).toBe('suppressed');
    expect(w.backend.supported).not.toHaveBeenCalled();
    expect(w.backend.made).toEqual([]);
    w.notifications.close();
  });

  it('holds each notification by opaque handle, forwards only title/body, and activates once through C4', async () => {
    const w = world();
    w.notifications.prepare(1, true);
    const shown = w.notifications.notify(REQUEST);
    const native = w.backend.made[0];
    if (native === undefined) throw new Error('no native notification');
    expect(native.options).toEqual({ title: REQUEST.title, body: REQUEST.body });
    native.notification.emit('show');
    expect(await shown).toBe('shown');
    native.notification.emit('click');
    expect(w.activate).toHaveBeenCalledExactlyOnceWith(REQUEST.handle);
    w.notifications.unnotify(REQUEST.handle);
    expect(native.notification.close).toHaveBeenCalledOnce();
    native.notification.emit('click');
    expect(w.activate).toHaveBeenCalledOnce();
    w.notifications.close();
  });

  it('rechecks focus and core ownership, and never constructs a suppressed or unsupported notification', async () => {
    const w = world();
    w.notifications.prepare(1, true);
    w.state.focused = true;
    expect(await w.notifications.notify(REQUEST)).toBe('suppressed');
    w.state.focused = false;
    w.state.current = false;
    expect(await w.notifications.notify(REQUEST)).toBe('suppressed');
    expect(w.backend.made).toEqual([]);
    w.notifications.close();
    const unsupported = world();
    unsupported.backend.supported.mockReturnValue(false);
    unsupported.notifications.prepare(1, true);
    expect(await unsupported.notifications.notify(REQUEST)).toBe('unsupported');
    expect(unsupported.backend.made).toEqual([]);
    unsupported.notifications.close();
  });

  it('returns native failure without retrying, bounds a missing delivery event, and closes everything on core exit', async () => {
    vi.useFakeTimers();
    const w = world();
    w.notifications.prepare(1, true);
    const failed = w.notifications.notify(REQUEST);
    w.backend.made[0]?.notification.emit('failed', new Error('secret URL'));
    expect(await failed).toBe('failed');
    const late = w.notifications.notify({
      ...REQUEST,
      handle: 'de0f235a-be5c-4724-8460-fcf20162129b',
    });
    await vi.advanceTimersByTimeAsync(NOTIFICATION_SHOW_MS);
    expect(await late).toBe('failed');
    const pending = w.notifications.notify(REQUEST);
    const last = w.backend.made.at(-1)?.notification;
    if (last === undefined) throw new Error('no native notification');
    w.notifications.close();
    expect(await pending).toBe('suppressed');
    expect(last.close).toHaveBeenCalledOnce();
    last.emit('click');
    expect(w.activate).not.toHaveBeenCalled();
  });
});
