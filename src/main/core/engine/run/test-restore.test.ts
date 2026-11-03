import { afterEach, expect, it } from 'vitest';
import { engineCatalog } from '../../../../shared/model/catalog';
import { MADE_UP } from '../../../../shared/test-made-up';
import { liveRun, expectRestorable } from './test-restore';

afterEach(expectRestorable);
function heldRun() {
  const run = liveRun(engineCatalog(MADE_UP), {
    send: () => () => undefined,
    tell: () => undefined,
    later: () => () => undefined,
    now: () => 1,
  });
  run.update([
    {
      id: 'a',
      type: 'agent',
      position: { x: 0, y: 0 },
      data: { label: 'A', adapter: 'zed', queue: [{ id: 'ok', approve: 'the work' }] },
    },
  ]);
  run.start();
  return run;
}
it('checks a held run with the same restoration assertion in either test runner', () => {
  heldRun();
  expect(() => {
    expectRestorable();
  }).not.toThrow();
});
it('still rejects a checkpoint that drops the run’s hold', () => {
  const run = heldRun();
  const empty = liveRun(engineCatalog(MADE_UP), {
    send: () => () => undefined,
    tell: () => undefined,
    later: () => () => undefined,
    now: () => 1,
  });
  run.checkpoint = () => empty.checkpoint();
  expect(() => {
    expectRestorable();
  }).toThrow('the run, restored from its checkpoint');
});
