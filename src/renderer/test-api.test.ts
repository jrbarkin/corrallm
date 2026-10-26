import { afterEach, expect, it, vi } from 'vitest';

import { api } from './api/client';
import { topics } from './api/topics';
import { fakeCore, expectOneOp, expectOneRead } from './test-api';

afterEach(() => {
  topics.dispose();
});

it('feeds the real renderer client and mirror when installed, restoring the previous bridge on cleanup', async () => {
  const previous = window.api;
  const core = fakeCore();
  core.snapshot('usage', { readings: [], rules: {} });
  core.respond('usage.setRule', { revs: { usage: 1 } });
  core.install();
  const done = vi.fn();
  const call = api.usageSetRule({ backend: 'codex', rule: null }).then(done);
  await vi.waitFor(() => {
    expectOneOp(core, 'usage.setRule', { backend: 'codex', rule: null });
  });
  expect(done).not.toHaveBeenCalled();
  core.change({ topic: 'usage', rev: 1, replace: { readings: [], rules: {} } });
  await call;
  expect(topics.snapshot('usage')).toEqual({ readings: [], rules: {} });
  core.dispose();
  expect(window.api).toBe(previous);
  expect(topics.snapshot('usage')).toBeUndefined();
});

it('fails a one-operation assertion for an extra intent or different arguments', async () => {
  const core = fakeCore();
  await core.api.linkOpen({ url: 'https://example.com' });
  expectOneOp(core, 'link.open', { url: 'https://example.com' });
  expect(() => {
    expectOneOp(core, 'link.open', {});
  }).toThrow();
  await core.api.linkReveal({ url: 'file:///tmp/x' });
  expect(() => {
    expectOneOp(core, 'link.open', { url: 'https://example.com' });
  }).toThrow();
  core.dispose();
});

it('keeps what a view reads apart from a gesture’s intents', async () => {
  const core = fakeCore();
  await core.api.appInfo();
  expect(core.operations).toEqual([]);
  expectOneRead(core, 'app.info', undefined);
  expect(() => {
    expectOneRead(core, 'app.info', {});
  }).toThrow();
  core.dispose();
});
