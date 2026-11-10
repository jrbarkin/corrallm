import { render, screen, within } from '@testing-library/react';
import { createRef } from 'react';
import { expect, it, vi } from 'vitest';

import { AgentId, MessageId } from '../../shared/api/ids';
import { NEW_SESSION } from '../../shared/model/session';
import { handoff, partyMessage, runSend } from '../../shared/model/test-b19';
import { sessionView } from '../../shared/model/views';
import { Composer } from '../agent/Composer';
import { sessionDisplay } from './sessions';
import { events } from '../test-render';

/*
 * B19 X2: what is queued for a connected agent. A queue hand-off from another agent's queue is the
 * run's: it is listed with its sender, and the composer offers no way to take it back (the core
 * refuses it, and the run's own Stop is how it comes back). Your own queued messages keep theirs.
 */

const summary = sessionView(AgentId.parse('a'), 'claude-code.sdk', NEW_SESSION).summary;
const names = (agent: string) => (agent === 'lead' ? 'Lead' : agent);

it('lists a pending hand-off with its sender, beside the messages queued by parties', () => {
  const offered = handoff('lead', 'a');
  const typed = partyMessage('you', 'a', { origin: 'manual' });
  const shown = sessionDisplay(
    summary,
    undefined,
    [typed, offered, runSend('a', { state: 'delivered' })],
    {
      agentName: names,
    },
  );
  expect(shown.queued).toEqual([
    { id: typed.id, text: 'Hello' },
    { id: offered.id, text: 'Review this', from: 'Lead' },
  ]);
  // It is the run's, not a message you sent: it is no submission of yours.
  expect(shown.submissions?.map(({ id }) => id)).toEqual([typed.id]);
  expect(MessageId.parse(offered.id)).toBe(offered.id);
});

it('lists a hand-off with its sender’s id when no name is known', () => {
  const offered = handoff('lead', 'a');
  expect(sessionDisplay(summary, undefined, [offered]).queued).toEqual([
    { id: offered.id, text: 'Review this', from: 'lead' },
  ]);
});

it('offers to take back your queued message, and not a hand-off', async () => {
  const unqueue = vi.fn();
  const field = createRef<HTMLTextAreaElement>();
  render(
    <Composer
      agentName="Worker"
      agent="claude-code"
      session={{
        ...NEW_SESSION,
        queued: [
          { id: 'mine', text: 'Third' },
          { id: 'theirs', text: 'Review this', from: 'Lead' },
        ],
      }}
      field={field}
      imageRules={{ declared: null, subject: 'Worker' }}
      controls={{
        send: vi.fn(),
        stop: vi.fn(),
        unqueue,
        setMode: vi.fn(),
        setModel: vi.fn(),
      }}
    />,
  );
  const list = within(screen.getByRole('list', { name: 'Queued messages' }));
  expect(list.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
    'Third',
    'From Lead: Review this',
  ]);
  expect(list.getAllByRole('button')).toHaveLength(1);
  await events.click(list.getByRole('button', { name: 'Edit queued message: Third' }));
  expect(unqueue).toHaveBeenCalledExactlyOnceWith('mine');
});
