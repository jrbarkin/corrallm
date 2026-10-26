import { expect, it } from 'vitest';
import { newCanvasId } from '../../shared/canvas';
import type { MirrorSnapshot } from '../api/topic-wire';
import { TopicMirror } from '../api/topics';
import { runtimeCore } from '../test-runtime-core';
import { CanvasSource } from './source';

const rows = {
  meta: { arrange: false, name: null, edited: false, project: null, rev: 1, by: 'you' as const },
};
const states: MirrorSnapshot['state'][] = [
  rows,
  { running: false, agents: {}, groups: {}, notices: [] },
  { items: [] },
  { agents: {} },
  { items: {}, order: [], next: '' },
];
const state = (index: number) => {
  const value = states[index];
  if (!value) throw new Error('Missing fixture state');
  return value;
};
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
it('gates commands on all five snapshots, keeps the view while reconnecting, and gates a new epoch', async () => {
  const core = runtimeCore();
  const mirror = new TopicMirror(core.source);
  const source = new CanvasSource(newCanvasId(), mirror);
  const stop = source.subscribe(() => undefined);
  for (let index = 0; index < 4; index++) core.answer(index, state(index));
  await settle();
  expect(source.available()).toBe(false);
  core.answer(4, state(4));
  await source.ready();
  expect(source.available()).toBe(true);
  const shown = source.read();
  core.epoch('replacement');
  expect(source.available()).toBe(false);
  expect(source.read()).toBe(shown);
  for (let index = 0; index < 5; index++) core.answer(index + 5, state(index));
  await source.ready();
  expect(source.available()).toBe(true);
  stop();
  mirror.dispose();
});
it('never enables a new binding from the old canvas’s late snapshots', async () => {
  const core = runtimeCore();
  const mirror = new TopicMirror(core.source);
  const source = new CanvasSource(newCanvasId(), mirror);
  const stop = source.subscribe(() => undefined);
  const next = newCanvasId();
  source.bind(next);
  for (let index = 0; index < 5; index++) core.answer(index, state(index));
  await settle();
  expect(source.canvas).toBe(next);
  expect(source.available()).toBe(false);
  expect(source.read()).toBeUndefined();
  for (let index = 0; index < 5; index++) core.answer(index + 5, state(index));
  await source.ready();
  expect(source.required().document.id).toBe(next);
  expect(source.available()).toBe(true);
  stop();
  mirror.dispose();
});
it('exposes a refused snapshot while leaving commands disabled', async () => {
  const core = runtimeCore();
  const mirror = new TopicMirror(core.source);
  const source = new CanvasSource(newCanvasId(), mirror);
  const stop = source.subscribe(() => undefined);
  core.pending[1]?.reject(new Error('The run cannot be read.'));
  await settle();
  expect(source.available()).toBe(false);
  expect(source.failure()).toBe('The run cannot be read.');
  stop();
  mirror.dispose();
});
