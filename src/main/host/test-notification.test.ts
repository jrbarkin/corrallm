import { beforeEach, expect, it } from 'vitest';

import { FakeNotification } from './test-notification';

/* The fake main's notification adapter is tested against (B14 X6) holds it to C8's fields. */

beforeEach(() => {
  FakeNotification.reset();
});

it('takes the core’s title, body and opaque handle, and records what the OS is asked', () => {
  const handle = crypto.randomUUID();
  const clicks: unknown[] = [];
  const made = new FakeNotification({
    title: 'corrallm',
    body: 'Worker is waiting for you',
    id: handle,
  });
  made.on('click', () => clicks.push(made.id));
  made.show();
  made.click();
  made.close();
  expect(FakeNotification.made).toEqual([made]);
  expect({ shown: made.shown, closed: made.closed, clicks }).toEqual({
    shown: 1,
    closed: 1,
    clicks: [handle],
  });
  expect(FakeNotification.isSupported()).toBe(true);
  FakeNotification.supported = false;
  expect(FakeNotification.isSupported()).toBe(false);
  expect(FakeNotification.asked).toBe(2);
});

it.each([
  { subtitle: 'curl https://evil.example' },
  { actions: [{ type: 'button', text: 'Approve' }] },
  { hasReply: true },
  { replyPlaceholder: 'Answer' },
  { icon: '/tmp/x.png' },
  { sound: 'Basso' },
  { silent: true },
  { urgency: 'critical' },
  { groupId: 'canvas' },
  { toastXml: '<toast/>' },
  { closeButtonText: 'Dismiss' },
  { timeoutType: 'never' },
  { id: 'prompt/worker/1/abc' },
  { body: 'x'.repeat(161) },
  { title: 'x'.repeat(33) },
])('refuses what a notification may not carry: %j', (extra) => {
  expect(
    () => new FakeNotification({ title: 'corrallm', body: 'Worker is waiting for you', ...extra }),
  ).toThrow();
  expect(FakeNotification.made).toEqual([]);
});
