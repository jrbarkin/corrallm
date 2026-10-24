import type { Reason } from './deviations';
import type { RuleRow } from './rules';
import { L, M, R, Y } from './surface';
import type { Rule, Surface } from './surface';

/*
 * B11 C6's and C7's operations, prepared (B11 Design §6, §7, §16.1): the surface each needs, its deviation and
 * the rule row it brings, as plain data beside SURFACE, never in it. Nothing here registers an
 * operation or widens any audience: X9 moves these rows into SURFACE, DEVIATIONS and RULES with their
 * schemas (`b11SessionOps`) and the core's services (core/session-control.ts), and only then are
 * they called. The core's tests register them early (CoreConfig.preparedOps).
 *
 * Their scopes, drains and points of no return:
 * - All run in the agent's scope, one at a time with the agent's other ops.
 * - `session.continueIn` drains the agent through the `agent.setConnection` it calls (ctx.call
 *   drains the inner op's lanes), not by declaring `drains`, which only an op in the app's or a
 *   canvas's scope may: so the CLI starting and the input admitted hold the agent's lane alone,
 *   never the whole canvas's.
 * - Each is past its point of no return just before its first effect on a CLI or a file (the live
 *   change, the close, the restore, the switch's commit), never before its checks: what is refused
 *   changes nothing.
 * - A code rewind also holds the workspace mutation gate (core/workspaces/gate.ts) around its
 *   restore, for every agent working in that tree, never across a person's decision.
 */

export const PREPARED_SURFACE = {
  'session.open': { access: L, kind: 'command', scope: 'agent', self: 'allowed' },
  // D9: the mode an agent runs in is yours alone.
  'session.setMode': { access: Y, kind: 'command', scope: 'agent' },
  'session.setModel': { access: L, kind: 'command', scope: 'agent', self: 'refused' },
  'session.setEffort': { access: L, kind: 'command', scope: 'agent', self: 'refused' },
  'session.stopTask': {
    access: L,
    kind: 'command',
    scope: 'agent',
    self: 'allowed',
    destructive: true,
  },
  'session.restart': { access: L, kind: 'command', scope: 'agent', self: 'refused' },
  'session.newConversation': { access: L, kind: 'command', scope: 'agent', self: 'refused' },
  'session.rewindPreview': { access: R, kind: 'read', scope: 'none', self: 'allowed' },
  // R5: a token's code restore comes to you as a proposal; R6 refuses an agent's own first.
  'session.rewind': {
    access: L,
    kind: 'command',
    scope: 'agent',
    rules: ['restore-code'],
    self: 'refused',
    destructive: true,
  },
  // §16.1: Continue in Terminal, yours alone (how an agent runs is yours).
  'session.continueIn': { access: Y, kind: 'command', scope: 'agent' },
  // B11 C7: `reply` with its typed answers (a run's holds, a session's prompts), the live op's
  // surface: R3 on every token's call, then the reply router's checks (core/replies.ts).
  reply: { access: M, kind: 'command', scope: 'canvas', rules: ['human-choice'] },
  // B9a C7: a kept tree removed, yours alone; one holding work asks you to confirm (`discard`'s
  // proposal envelope, for you).
  'worktree.remove': {
    access: Y,
    kind: 'command',
    scope: 'canvas',
    rules: ['discard'],
    destructive: true,
  },
} as const satisfies Record<string, Surface>;

export type PreparedName = keyof typeof PREPARED_SURFACE;

/** Their deviations: on the GUI alone, and why. */
export const PREPARED_DEVIATIONS = {
  'session.setMode': 'permissions',
  'session.continueIn': 'permissions',
  'worktree.remove': 'trust-gate',
} as const satisfies Partial<Record<PreparedName, Reason>>;

/** The rule row they bring: R5's. */
export const PREPARED_RULES = {
  'restore-code': {
    kind: 'argument',
    sentence:
      'Only you restore an agent’s files to how they were: a token’s code rewind comes to you as a proposal, applied only if nothing it would restore changed since.',
  },
} as const satisfies Partial<Record<Rule, RuleRow>>;
