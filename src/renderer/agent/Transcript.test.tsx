import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';

import { AgentId } from '../../shared/api/ids';
import { newCanvasId } from '../../shared/canvas';
import { recordEntryFor } from '../../shared/model/records';
import { NEW_SESSION } from '../../shared/model/session';
import { sessionView } from '../../shared/model/views';
import type { SessionView } from '../../shared/model/views';
import { sessionDisplay } from '../run/sessions';
import { Transcript } from './Transcript';

/*
 * The transcript's empty state, as its session topic gives it (B19 C3): the settled records that
 * lead an agent's entries are no turn of its conversation, so a transcript of records alone still
 * asks what the agent should do.
 */

const canvas = newCanvasId();
const base = sessionView(AgentId.parse('a'), 'claude-code.sdk', NEW_SESSION);
const record = recordEntryFor(
  {
    id: '11111111-2222-4333-8444-555555555555',
    canvas,
    from: 'corrallm',
    to: 'you',
    kind: 'settled',
    body: 'You answered “Your OK on the spec?”: Approve.',
    state: 'delivered',
    by: 'you',
    at: 1,
  },
  { v: 1, agent: 'a', need: 'hold/a/0a1b2c3d/ok', hold: { choice: 'approve' } },
);

function shown(view: SessionView) {
  render(
    <Transcript
      session={sessionDisplay(view.summary, view)}
      agentName="Worker"
      note="It runs on its CLI."
      answers={{}}
    />,
  );
}

it('asks what the agent should do while its transcript holds settled records alone', () => {
  shown({ ...base, entries: { [record.id]: record }, order: [record.id] });
  expect(screen.getByText('What should Worker do?')).toBeTruthy();
  expect(screen.getByText('It runs on its CLI.')).toBeTruthy();
});

it('asks nothing once its conversation has a turn beside them', () => {
  const user = { id: 'u1', kind: 'user' as const, text: 'Write the spec' };
  shown({
    ...base,
    entries: { [record.id]: record, [user.id]: user },
    order: [record.id, user.id],
  });
  expect(screen.queryByText('What should Worker do?')).toBeNull();
  expect(screen.getByText('Write the spec')).toBeTruthy();
});
