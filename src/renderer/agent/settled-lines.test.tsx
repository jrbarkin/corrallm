import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AgentId } from '../../shared/api/ids';
import { UNRESOLVED_ANSWER } from '../../shared/model/records';
import { NEW_SESSION } from '../../shared/model/session';
import { askRecord, holdRecord } from '../../shared/model/test-b19';
import { sessionView } from '../../shared/model/views';
import type { EntryView } from '../../shared/model/views';
import { sessionDisplay } from '../run/sessions';
import { Transcript } from './Transcript';

/*
 * B19 X3: the core's settled records in the transcript. One shared line draws each: how it ended and
 * who decided, in the core's words, with nothing to answer, approve or send. An owner entry for the
 * same decision, settled in place, is the one line there is.
 */

const NAMES = (party: string) =>
  party === 'you' ? 'you' : party.replace(/^agent:/, '').toUpperCase();

function shown(
  entries: readonly EntryView[],
  answers: Parameters<typeof Transcript>[0]['answers'] = {},
) {
  const view = {
    ...sessionView(AgentId.parse('a'), 'claude-code.sdk', NEW_SESSION),
    entries: Object.fromEntries(entries.map((entry) => [entry.id, entry])),
    order: entries.map(({ id }) => id),
  };
  render(
    <Transcript
      session={sessionDisplay(view.summary, view)}
      agentName="Worker"
      note=""
      answers={{ names: NAMES, ...answers }}
    />,
  );
}

const USER: EntryView = { id: 'u1', kind: 'user', text: 'Write the spec' };

describe('a settled record in the transcript', () => {
  it('reads as one line in the core’s words, ahead of the conversation it leads', () => {
    shown([holdRecord('a'), USER]);
    const line = screen.getByRole('note');
    expect(line.textContent).toBe('Approved by you.');
    expect(line.dataset.record).toBe('hold');
    expect(line.dataset.state).toBe('settled');
    expect(line.compareDocumentPosition(screen.getByText('Write the spec'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('names an ask’s asker by the reader’s names', () => {
    shown([askRecord('a', 'agent:planner'), USER]);
    expect(screen.getByRole('note').textContent).toBe(
      'PLANNER’s question was dismissed, unanswered.',
    );
  });

  it('says a decision corrallm was cut off answering may not have reached the CLI', () => {
    const cut = {
      ...holdRecord('a'),
      state: 'unresolved' as const,
      record: {
        type: 'prompt' as const,
        prompt: { kind: 'approval' as const },
        outcome: { type: 'choice' as const, value: 'yes', hint: 'allow_once' as const },
      },
    };
    shown([cut, USER]);
    const line = screen.getByRole('note');
    expect(line.dataset.state).toBe('unresolved');
    expect(line.textContent).toBe(`Allowed once by you, but ${UNRESOLVED_ANSWER}`);
  });

  it('offers nothing to answer, approve or send', () => {
    shown([holdRecord('a'), askRecord('a'), USER]);
    for (const line of screen.getAllByRole('note'))
      expect(line.querySelector('button, a, input, textarea, select')).toBeNull();
    expect(screen.queryAllByRole('button')).toEqual([]);
  });

  it('is not a turn, so a transcript of records alone still asks what to do', () => {
    shown([holdRecord('a')]);
    expect(screen.getByText('What should Worker do?')).toBeTruthy();
    expect(screen.getByRole('note').textContent).toBe('Approved by you.');
  });

  it('is the owner entry’s alone when both show one decision', () => {
    const decided = holdRecord('a');
    const need = 'prompt/a/0f1e2d3c';
    const owner = {
      id: 'p1',
      kind: 'prompt',
      need,
      prompt: {
        id: '0f1e2d3c-4b5a-4968-8776-655443322110',
        agent: 'a',
        raised: 1,
        kind: 'approval',
        title: 'Run the tests?',
        answerIn: 'api',
      },
      outcome: { type: 'answered-in-terminal', by: 'terminal' },
    } as unknown as EntryView;
    shown([{ ...decided, need }, owner]);
    expect(screen.queryAllByRole('note')).toEqual([]);
    expect(screen.getAllByText('Answered in the terminal.')).toHaveLength(1);
  });
});
