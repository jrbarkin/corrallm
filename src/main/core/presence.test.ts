import { expect, it } from 'vitest';

import {
  NotificationRequest,
  NotificationResult,
  Presence,
  ShutdownOptions,
  PauseAllResult,
} from './presence';

const idle = {
  revision: 0,
  working: 0,
  runs: 0,
  jobs: 0,
  needs: 0,
  busy: false,
  awake: false,
  notify: true,
};
const notice = {
  handle: 'ad9ee798-f2dc-40cf-a1e2-b0073ddfb316',
  title: 'corrallm',
  body: 'Needs you',
};

it('bounds a whole presence snapshot without names, paths or partial counts', () => {
  expect(Presence.parse(idle)).toEqual(idle);
  expect(Presence.safeParse({ ...idle, working: 9999, busy: true, awake: true }).success).toBe(
    true,
  );
  for (const key of ['working', 'runs', 'jobs', 'needs']) {
    for (const value of [-1, 0.5, 10000, Infinity, NaN]) {
      expect(Presence.safeParse({ ...idle, [key]: value }).success).toBe(false);
    }
  }
  for (const revision of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect(Presence.safeParse({ ...idle, revision }).success).toBe(false);
  }
  expect(Presence.safeParse({ ...idle, busy: true }).success).toBe(false);
  expect(Presence.safeParse({ ...idle, runs: 1 }).success).toBe(false);
  expect(Presence.safeParse({ ...idle, name: 'private' }).success).toBe(false);
  const partial = Object.fromEntries(Object.entries(idle).filter(([key]) => key !== 'needs'));
  expect(Presence.safeParse(partial).success).toBe(false);
});

it('allows only a notification handle and bounded UTF-8 title and body', () => {
  expect(NotificationRequest.parse(notice)).toEqual(notice);
  expect(
    NotificationRequest.safeParse({ ...notice, title: '🐴'.repeat(8), body: '🐴'.repeat(40) })
      .success,
  ).toBe(true);
  for (const extra of [
    { url: 'https://example.com' },
    { canvas: notice.handle },
    { need: 'prompt/secret' },
  ]) {
    expect(NotificationRequest.safeParse({ ...notice, ...extra }).success).toBe(false);
  }
  for (const value of [
    { title: '🐴'.repeat(9) },
    { body: '🐴'.repeat(41) },
    { handle: 'path/to/item' },
  ]) {
    expect(NotificationRequest.safeParse({ ...notice, ...value }).success).toBe(false);
  }
  for (const result of ['shown', 'failed', 'unsupported', 'suppressed'])
    expect(NotificationResult.parse(result)).toBe(result);
  expect(NotificationResult.safeParse('authorized').success).toBe(false);
});

it('admits only the idle reservation option and bounded pause acknowledgements', () => {
  expect(ShutdownOptions.parse({})).toEqual({});
  expect(ShutdownOptions.parse({ ifIdle: true })).toEqual({ ifIdle: true });
  expect(ShutdownOptions.safeParse({ ifIdle: false }).success).toBe(false);
  expect(ShutdownOptions.safeParse({ force: true }).success).toBe(false);
  const result = {
    agents: 2,
    canvases: 1,
    unsaved: [{ canvas: notice.handle, sentence: 'Disk full' }],
  };
  expect(PauseAllResult.parse(result)).toEqual(result);
  expect(
    PauseAllResult.safeParse({ ...result, unsaved: Array(65).fill(result.unsaved[0]) }).success,
  ).toBe(false);
  expect(PauseAllResult.safeParse({ ...result, agents: -1 }).success).toBe(false);
});

it('carries whether notifications are on, as one boolean, in every whole snapshot', () => {
  expect(Presence.parse({ ...idle, notify: false }).notify).toBe(false);
  expect(Presence.parse(idle).notify).toBe(true);
  for (const notify of [undefined, 1, 'true', null]) {
    expect(Presence.safeParse({ ...idle, notify }).success).toBe(false);
  }
});
