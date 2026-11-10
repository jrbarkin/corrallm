import { cleanup, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';

import type { LeadGrants } from '../../shared/api/ops/leads';
import { newCanvasId } from '../../shared/canvas';
import { expectOneOp, fakeCore } from '../test-api';
import { events, renderReady } from '../test-render';
import { LeadBadge, LeadSection, OutsideGrants } from './Leads';

/*
 * B24 X2, X3: the settings sheet's Lead section, the card's badge and the canvas menu's outside
 * orchestrators, each a gesture of exactly one operation (`agent.setLead`, `outside.setGrant`),
 * read from the `leads:<c>` topic alone; looking at them sends nothing.
 */

const canvas = newCanvasId();
const cores: ReturnType<typeof fakeCore>[] = [];
afterEach(() => {
  cleanup();
  cores.splice(0).forEach((core) => {
    core.dispose();
  });
});

const QUESTIONS: LeadGrants = { questions: true, plans: false, approvals: false };

async function setup(
  leads: { agent: string; grants: LeadGrants; held: 'role' | 'adapter' | 'connection' | null }[],
  outside: { name: string; approvals: boolean; live: boolean }[] = [],
) {
  const core = fakeCore();
  cores.push(core);
  core.snapshot(`leads:${canvas}`, { leads, outside });
  await renderReady(
    <>
      <LeadBadge canvas={canvas} agent="boss" mirror={core.topics} />
      <LeadSection canvas={canvas} agent="boss" mirror={core.topics} client={core.api} />
      <OutsideGrants canvas={canvas} mirror={core.topics} client={core.api} />
    </>,
  );
  return core;
}

it('shows no badge and offers to make a lead, sending nothing until you do', async () => {
  const core = await setup([]);
  expect(screen.queryByLabelText('Lead badge')).toBeNull();
  expect(core.operations).toEqual([]);
  await events.click(screen.getByRole('button', { name: 'Make a lead' }));
  expectOneOp(core, 'agent.setLead', {
    canvas,
    agent: 'boss',
    lead: { grants: { questions: false, plans: false, approvals: false } },
  });
});

it('badges a lead and flips one grant per gesture, with the others as they are', async () => {
  const core = await setup([{ agent: 'boss', grants: QUESTIONS, held: null }]);
  expect(screen.getByLabelText('Lead badge').textContent).toBe('Lead');
  expect(
    screen.getByRole<HTMLInputElement>('checkbox', { name: 'Answers questions' }).checked,
  ).toBe(true);
  await events.click(screen.getByRole('checkbox', { name: 'Answers approvals' }));
  expectOneOp(core, 'agent.setLead', {
    canvas,
    agent: 'boss',
    lead: { grants: { questions: true, plans: false, approvals: true } },
  });
});

it('removes a lead with one operation', async () => {
  const core = await setup([{ agent: 'boss', grants: QUESTIONS, held: null }]);
  await events.click(screen.getByRole('button', { name: 'Remove lead' }));
  expectOneOp(core, 'agent.setLead', { canvas, agent: 'boss', lead: null });
});

it('says why a lead is held, takes no grant change meanwhile, and confirms with the same grants', async () => {
  const core = await setup([{ agent: 'boss', grants: QUESTIONS, held: 'role' }]);
  expect(screen.getByLabelText('Lead badge').textContent).toBe('Lead · held');
  expect(screen.getByRole('status').textContent).toContain('its role changed');
  expect(
    screen.getByRole<HTMLInputElement>('checkbox', { name: 'Answers approvals' }).disabled,
  ).toBe(true);
  expect(core.operations).toEqual([]);
  await events.click(screen.getByRole('button', { name: 'Confirm' }));
  expectOneOp(core, 'agent.setLead', { canvas, agent: 'boss', lead: { grants: QUESTIONS } });
});

it('lists outside orchestrators and lets approvals through one operation, only with a live token', async () => {
  const core = await setup(
    [],
    [
      { name: 'planner', approvals: false, live: true },
      { name: 'gone', approvals: true, live: false },
    ],
  );
  const grant = screen.getByRole<HTMLInputElement>('checkbox', {
    name: 'planner may answer approvals',
  });
  expect(grant.disabled).toBe(false);
  // One whose token is gone can only be taken back.
  const kept = screen.getByRole<HTMLInputElement>('checkbox', {
    name: 'gone may answer approvals',
  });
  expect(kept.checked).toBe(true);
  await events.click(grant);
  expectOneOp(core, 'outside.setGrant', { canvas, name: 'planner', approvals: true });
});

it('takes a grant back from an orchestrator whose token is gone', async () => {
  const core = await setup([], [{ name: 'gone', approvals: true, live: false }]);
  await events.click(screen.getByRole('checkbox', { name: 'gone may answer approvals' }));
  expectOneOp(core, 'outside.setGrant', { canvas, name: 'gone', approvals: false });
});

it('offers no grant to a gone token that has none', async () => {
  const core = await setup([], [{ name: 'idle', approvals: false, live: false }]);
  expect(
    screen.getByRole<HTMLInputElement>('checkbox', { name: 'idle may answer approvals' }).disabled,
  ).toBe(true);
  expect(core.operations).toEqual([]);
});

it('says a lead’s tools appear when it next starts, and restarts it with exactly one operation', async () => {
  const core = await setup([{ agent: 'boss', grants: QUESTIONS, held: null }]);
  expect(screen.getByText('Its lead tools appear when it next starts.')).toBeTruthy();
  expect(core.operations).toEqual([]);
  await events.click(screen.getByRole('button', { name: 'Restart' }));
  expectOneOp(core, 'session.restart', { canvas, agent: 'boss' });
});

it('offers no restart for an agent that leads nobody, or is held', async () => {
  await setup([{ agent: 'boss', grants: QUESTIONS, held: 'role' }]);
  expect(screen.queryByRole('button', { name: 'Restart' })).toBeNull();
});
