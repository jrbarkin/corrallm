import { cleanup, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { expectOneOp, fakeCore } from '../test-api';
import { events, renderReady } from '../test-render';
import { ApprovedOrchestrators, OrchestratorRequests } from './Orchestrators';
afterEach(cleanup);
const id = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
function setup() {
  const core = fakeCore();
  const old = core.state('settings');
  if (old === undefined) throw new Error('No settings');
  core.snapshot('settings', {
    ...old.state,
    orchestrators: {
      pending: [
        {
          id,
          folder: '/work/project',
          into: '/home/user/.corrallm/project.token',
          requester: 'an agent',
          expires: Date.now() + 60000,
        },
      ],
      approved: [
        {
          id,
          canvas: id,
          folder: '/work/project',
          created: 1,
          lastUsed: 2,
          withoutApprovals: false,
        },
      ],
    },
  });
  return core;
}
it('requires an explicit Allow and sends its unticked allowance in one operation', async () => {
  const core = setup();
  try {
    await renderReady(<OrchestratorRequests client={core.api} mirror={core.topics} />);
    expect(screen.getByText('/work/project')).toBeTruthy();
    expect(
      screen.getByRole<HTMLInputElement>('checkbox', { name: 'may run agents without approvals' })
        .checked,
    ).toBe(false);
    await events.click(screen.getByRole('button', { name: 'Allow' }));
    expectOneOp(core, 'settings.set', {
      orchestrator: { action: 'allow', id, withoutApprovals: false },
    });
  } finally {
    core.dispose();
  }
});
it('declines without granting any allowance', async () => {
  const core = setup();
  try {
    await renderReady(<OrchestratorRequests client={core.api} mirror={core.topics} />);
    await events.click(screen.getByRole('button', { name: 'Decline' }));
    expectOneOp(core, 'settings.set', { orchestrator: { action: 'decline', id } });
  } finally {
    core.dispose();
  }
});
it('revokes in one operation and explains that agents and their canvas stay', async () => {
  const core = setup();
  try {
    await renderReady(<ApprovedOrchestrators client={core.api} mirror={core.topics} />);
    expect(screen.getByText('Revoking keeps the canvas and its agents.')).toBeTruthy();
    await events.click(screen.getByRole('button', { name: 'Revoke' }));
    expectOneOp(core, 'settings.set', { orchestrator: { action: 'revoke', id } });
  } finally {
    core.dispose();
  }
});
