import { describe, expect, it } from 'vitest';

import { mergeHistory } from './history';
import type { Entry } from '../../model/session';

const user = (id: string, text: string): Entry => ({ id, kind: 'user', text });
const reply = (id: string, text: string): Entry => ({ id, kind: 'text', text });
const read = (id: string): Entry => ({
  id,
  kind: 'tool',
  tool: 'Read',
  summary: 'README.md',
  status: 'done',
});
const end = (id: string, seconds = 3): Entry => ({ id, kind: 'end', seconds, interrupted: false });

/** Each entry, in short. */
const outline = (entries: readonly Entry[]) =>
  entries.map((entry) => (entry.kind === 'end' ? `end ${String(entry.seconds)}s` : entry.id));

describe('mergeHistory', () => {
  it('puts what a resumed session did before ahead of a transcript that shows none of it', () => {
    expect(
      outline(
        mergeHistory([user('new', 'Now')], [user('u1', 'Before'), reply('m1:0', 'Hi'), end('e1')]),
      ),
    ).toEqual(['u1', 'm1:0', 'end 3s', 'new']);
  });

  it('adds nothing a transcript shows already', () => {
    const shown = [user('u1', 'Before'), reply('m1:0', 'Hi'), end('live-end', 5)];
    // History's ends get ids of their own: its turn is known by its message.
    expect(mergeHistory(shown, [user('u1', 'Before'), reply('m1:0', 'Hi'), end('e1')])).toEqual(
      shown,
    );
  });

  it('inserts the turns it does not show where they happened', () => {
    const shown = [user('u1', 'One'), reply('m1:0', 'A'), end('x1'), user('u3', 'Three')];
    const past = [
      user('u1', 'One'),
      reply('m1:0', 'A'),
      end('e1'),
      user('u2', 'Two'),
      read('t2'),
      end('e2', 7),
      user('u3', 'Three'),
    ];
    expect(outline(mergeHistory(shown, past))).toEqual([
      'u1',
      'm1:0',
      'end 3s',
      'u2',
      't2',
      'end 7s',
      'u3',
    ]);
  });

  it('fills in a turn a Terminal session showed only in short: its message and last reply', () => {
    // The Terminal connection says what was sent and the last reply, under ids of its own.
    const shown = [
      user('u1', 'One'),
      reply('m1:0', 'A'),
      end('x1'),
      user('typed', 'Fix the test'),
      reply('random', 'Fixed it.'),
      { id: 'warn', kind: 'notice', level: 'warning', text: 'Look here' } as Entry,
      end('x2', 40),
    ];
    const past = [
      user('u1', 'One'),
      reply('m1:0', 'A'),
      end('e1'),
      user('u2', 'Fix the test'),
      read('t2'),
      reply('m2:1', 'Fixed it.'),
      end('e2', 38),
    ];
    expect(outline(mergeHistory(shown, past))).toEqual([
      'u1',
      'm1:0',
      'end 3s',
      'u2',
      't2',
      'm2:1',
      'warn',
      'end 40s',
    ]);
  });

  it('leaves a turn going on as it is, even one that reads like an earlier one', () => {
    const shown = [user('live', 'Continue')];
    const past = [user('u1', 'Continue'), reply('m1:0', 'Done'), end('e1')];
    expect(outline(mergeHistory(shown, past))).toEqual(['u1', 'm1:0', 'end 3s', 'live']);
  });
});
