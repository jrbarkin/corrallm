import { z } from 'zod';

import { ID_PATTERN } from '../../adapter';
import { define } from '../define';
import type { OpDef } from '../define';
import { AgentId, OpCanvas } from '../ids';
import type { OpName } from '../surface';

/*
 * Who leads (B24 Design §3, C1, C2): an agent you make a lead of the agents nested in it, with what
 * it may answer for them, kept on this machine (the core's database) and never in a canvas file; and
 * the outside orchestrators, by their token's name, you let answer ordinary approvals (Q3). Every
 * one of these is yours alone (the permissions deviation, D9): no token, file, template or command
 * line makes a lead or widens a grant.
 */

/**
 * What a lead may answer for its team, each one request at a time and never "always": questions,
 * plans (only into modes that ask), approvals. All off unless you set them.
 */
export const LeadGrants = z.strictObject({
  questions: z.boolean(),
  plans: z.boolean(),
  approvals: z.boolean(),
});
export type LeadGrants = z.infer<typeof LeadGrants>;

/**
 * What changed of a lead's agent since you made it a lead, holding it (no grants, no team writes)
 * until you confirm it with the same grants: its adapter, its connection or its role.
 */
export const HELD_REASONS = ['adapter', 'connection', 'role'] as const;
export type HeldReason = (typeof HELD_REASONS)[number];

/** An outside token's name: the party it calls as (`outside:<name>`), an id. */
const TokenName = z.string().min(1).max(32).regex(ID_PATTERN);

/** A lead on a canvas, as you read it: its agent, what it may answer, and whether it is held. */
export const LeadView = z.strictObject({
  agent: z.string(),
  grants: LeadGrants,
  held: z.enum(HELD_REASONS).nullable(),
});
export type LeadView = z.infer<typeof LeadView>;

/**
 * An outside orchestrator, by its token's name: one whose live write token reaches the canvas, or
 * one you let answer approvals there; whether you did, and whether a live token has its name.
 */
export const OutsideView = z.strictObject({
  name: z.string(),
  approvals: z.boolean(),
  live: z.boolean(),
});
export type OutsideView = z.infer<typeof OutsideView>;

export const leadOps = {
  'agent.setLead': define('agent.setLead', {
    summary:
      'Makes an agent the lead of the agents nested in it, with what it may answer for them: ' +
      'questions, plans (into modes that ask) and approvals, each one request at a time; or null ' +
      'to make it no lead. Kept on this machine, never in a canvas file. A lead whose role, ' +
      'adapter or connection changed since is held until the same grants are sent again. Only ' +
      'the user makes a lead.',
    input: z.strictObject({
      canvas: OpCanvas,
      agent: AgentId,
      lead: z.strictObject({ grants: LeadGrants }).nullable(),
    }),
    output: z.strictObject({}),
  }),
  'outside.setGrant': define('outside.setGrant', {
    summary:
      'Lets the outside orchestrator whose write token has this name answer the ordinary ' +
      'approvals of the agents it reaches on this canvas, once each, or stops letting it. Kept ' +
      'on this machine; never set by a token, a file or a command line. Only the user grants it.',
    input: z.strictObject({ canvas: OpCanvas, name: TokenName, approvals: z.boolean() }),
    output: z.strictObject({}),
  }),
  'leads.get': define('leads.get', {
    summary:
      'Who leads on a canvas, what each may answer for its team and whether it is held (what ' +
      'changed of it since it was made a lead), and the outside orchestrators whose write tokens ' +
      'reach it or that may answer its approvals. Only the user reads it.',
    input: z.strictObject({ canvas: OpCanvas }),
    output: z.strictObject({ leads: z.array(LeadView), outside: z.array(OutsideView) }),
  }),
} satisfies Partial<Record<OpName, OpDef>>;
