import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { EntryView } from '../../shared/model/views';
import { NEW_SESSION } from '../../shared/model/session';
import type { Session } from '../../shared/model/session';
import { askRecord, handoff, holdRecord } from '../../shared/model/test-b19';
import { events } from '../test-render';
import { NO_TERMINAL } from './backend';
import { fakeScreens } from './test-screen';
import { TerminalPane } from './TerminalPane';

// jsdom cannot draw xterm.js: a fake terminal stands in (test-screen.ts).
vi.mock('./screen', async () => {
  const { fakeScreens: screens } = await import('./test-screen');
  return { createScreen: screens.create };
});

/*
 * B19 X3 and X2 in a Terminal agent's bar: its live prompts as ever, its settled lines beside them
 * (a record the core kept, an owner entry that has ended), told apart and offering nothing to
 * answer, and the messages queued for it: a hand-off from another agent's queue is the run's, with
 * no way to take it back.
 */

beforeEach(() => {
  fakeScreens.made.length = 0;
});

const ENDED = {
  id: 'p1',
  kind: 'prompt',
  need: 'prompt/a/0f1e2d3c',
  prompt: {
    id: '0f1e2d3c-4b5a-4968-8776-655443322110',
    agent: 'a',
    raised: 1,
    kind: 'approval',
    title: 'Run the tests?',
    answerIn: 'api',
  },
  outcome: { type: 'dismissed' },
} as unknown as EntryView;

function bar(entries: readonly EntryView[], session: Partial<Session> = {}) {
  const onUnqueue = vi.fn();
  render(
    <TerminalPane
      agentId="a"
      cli="Claude Code"
      backend={NO_TERMINAL}
      session={{ ...NEW_SESSION, entries: [...entries] as Session['entries'], ...session }}
      note=""
      onStart={vi.fn()}
      onUnqueue={onUnqueue}
      names={(party) => (party === 'you' ? 'you' : party.replace(/^agent:/, ''))}
      screens={fakeScreens.create}
    />,
  );
  return { onUnqueue };
}

describe('settled lines in a Terminal agent’s bar', () => {
  it('shows a record and an ended owner entry, as the transcript does, apart from live prompts', () => {
    bar([ENDED, holdRecord('a')]);
    const settled = screen.getByRole('group', { name: 'Settled' });
    expect(within(settled).getByText('Not waiting.')).toBeTruthy();
    expect(within(settled).getByRole('note').textContent).toBe('Approved by you.');
    expect(settled.querySelector('input, textarea, select')).toBeNull();
    // Hiding is this view's: no answer goes anywhere.
    expect(screen.queryByRole('button', { name: /Allow|Approve|Send|Reply/ })).toBeNull();
  });

  it('keeps the newest few and draws no group without any', () => {
    bar([]);
    expect(screen.queryByRole('group', { name: 'Settled' })).toBeNull();
  });

  it('shows no more than the newest three', () => {
    bar([
      holdRecord('a', 'stop'),
      holdRecord('a', 'goOn'),
      askRecord('a'),
      holdRecord('a', 'retry'),
    ]);
    const lines = within(screen.getByRole('group', { name: 'Settled' })).getAllByRole('note');
    expect(lines.map((line) => line.textContent)).toEqual([
      'Told to go on by you.',
      'you’s question was dismissed, unanswered.',
      'Retried by you.',
    ]);
  });

  it('hides a line for this view alone, with no operation', async () => {
    bar([holdRecord('a')]);
    await events.click(screen.getByRole('button', { name: 'Hide' }));
    expect(screen.queryByRole('group', { name: 'Settled' })).toBeNull();
  });

  it('shows one decision once, when an owner entry holds its Needs item too', () => {
    const decided = { ...holdRecord('a'), need: 'prompt/a/0f1e2d3c' };
    bar([ENDED, decided]);
    expect(screen.queryByRole('note')).toBeNull();
    expect(screen.getAllByText('Not waiting.')).toHaveLength(1);
  });
});

describe('queued messages in a Terminal agent’s bar', () => {
  it('offers to take back your own, and not a hand-off from a queue, which is the run’s', async () => {
    const offered = handoff('lead', 'a');
    const { onUnqueue } = bar([], {
      queued: [
        { id: 'mine', text: 'Write the docs' },
        { id: offered.id, text: offered.body, from: 'Lead' },
      ],
    });
    const list = within(screen.getByRole('list', { name: 'Queued messages' }));
    const items = list.getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual([
      'Write the docs',
      'From Lead: Review this',
    ]);
    const theirs = items.at(1);
    if (!theirs) throw new Error('No hand-off listed');
    expect(within(theirs).queryByRole('button')).toBeNull();
    await events.click(
      list.getByRole('button', { name: /Take back queued message: Write the docs/ }),
    );
    expect(onUnqueue).toHaveBeenCalledExactlyOnceWith('mine');
  });
});
