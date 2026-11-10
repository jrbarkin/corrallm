import { afterEach, beforeEach, expect, it } from 'vitest';

import { migrate } from './migrations';
import { settleRestored } from './restored';
import { connect } from './sqlite';
import type { Connection } from './sqlite';

let disk: Connection;
beforeEach(() => {
  disk = connect(':memory:');
  migrate(disk);
  disk.prepare("INSERT INTO canvas (id, used_at) VALUES ('canvas', 1)").run();
});
afterEach(() => {
  disk.close();
});

function pending(id: string, purpose: unknown = null): void {
  disk
    .prepare(
      `INSERT INTO message (id, canvas_id, from_party, to_party, kind, origin, body,
         state, sent_at, purpose)
       VALUES (?, 'canvas', 'agent:lead', 'agent:worker', 'text', 'run', 'Review this',
         'pending', 1, ?)`,
    )
    .run(id, purpose === null ? null : JSON.stringify(purpose));
}

it('restores a pending queue hand-off as uncertain work without a sender notice', () => {
  pending('handoff', { v: 1, type: 'handoff' });
  pending('party');
  settleRestored(disk, 2);
  expect(
    disk.prepare("SELECT id, state FROM message WHERE kind = 'text' ORDER BY seq").all(),
  ).toEqual([
    { id: 'handoff', state: 'unresolved' },
    { id: 'party', state: 'unresolved' },
  ]);
  // The run holds its own item. Only the ordinary message tells its sender.
  expect(
    disk.prepare("SELECT to_party, reply_to FROM message WHERE kind = 'notice'").all(),
  ).toEqual([{ to_party: 'agent:lead', reply_to: 'party' }]);
});

it('leaves a pending row with an unreadable purpose intact when restoring a snapshot', () => {
  pending('newer', { v: 2, type: 'handoff' });
  pending('party');
  const before = disk.prepare("SELECT * FROM message WHERE id = 'newer'").get();
  settleRestored(disk, 2);
  expect(disk.prepare("SELECT * FROM message WHERE id = 'newer'").get()).toEqual(before);
  // A row this core cannot interpret produces no derived record either.
  expect(disk.prepare("SELECT reply_to FROM message WHERE kind = 'notice'").all()).toEqual([
    { reply_to: 'party' },
  ]);
  expect(disk.prepare("SELECT state FROM message WHERE id = 'party'").get()).toEqual({
    state: 'unresolved',
  });
});
