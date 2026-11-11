import { describe, expect, it } from 'vitest';

import type { QueueItem } from './queue';
import { topLevelOf } from './queue';
import { evidenceFor, handoff, partyMessage, runSend } from './test-b19';
import { queueRows } from './views';

/*
 * B19 X2's shared half: the rows a queue shows beside its authored items. A queue hand-off for the
 * agent is one (read-only, from its sender); the run's own direct sends and a hand-off's evidence
 * are not, and nothing here changes what the queue holds.
 */

const QUEUE: QueueItem[] = [
  { id: 'one', action: 'Read' },
  {
    id: 'check',
    if: { kind: 'outputContains', text: 'ok' },
    then: [{ id: 'inner', message: 'Then this' }],
  },
  {
    id: 'loop',
    repeat: [{ id: 'step', action: 'Bash' }],
    until: { kind: 'outputContains', text: 'done' },
    rounds: 3,
    otherwise: 'ask',
  },
];

describe('the rows beside a queue', () => {
  it('include a queue hand-off for the agent, and neither the run’s direct sends nor evidence', () => {
    const offered = handoff('lead', 'a', { display: { after: 'one' } });
    const rows = queueRows(QUEUE, [
      offered,
      runSend('a', { display: { after: 'one' } }),
      evidenceFor(offered),
      partyMessage('you', 'a', { display: { after: 'one' } }),
    ]);
    expect(rows.map((row) => row.key)).toEqual([
      'item/one',
      `message/${offered.id}`,
      expect.stringMatching(/^message\//),
      'item/check',
      'item/loop',
    ]);
    expect(rows.filter((row) => row.kind === 'message')).toHaveLength(2);
  });

  it('leave the queue as it was', () => {
    const before = JSON.stringify(QUEUE);
    queueRows(QUEUE, [handoff('lead', 'a')]);
    expect(JSON.stringify(QUEUE)).toBe(before);
  });
});

describe('where an item sits at the top of a queue', () => {
  it('is the item itself, or the if-then or repeat that holds it', () => {
    expect(topLevelOf(QUEUE, 'one')).toBe('one');
    expect(topLevelOf(QUEUE, 'inner')).toBe('check');
    expect(topLevelOf(QUEUE, 'step')).toBe('loop');
    expect(topLevelOf(QUEUE, 'loop')).toBe('loop');
  });

  it('is nothing for an item the queue does not hold', () => {
    expect(topLevelOf(QUEUE, 'gone')).toBeUndefined();
    expect(topLevelOf(QUEUE, undefined)).toBeUndefined();
  });
});
