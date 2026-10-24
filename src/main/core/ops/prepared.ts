import type { z } from 'zod';

import type { OpDef } from '../../../shared/api/define';
import { b11ConversationOps } from '../../../shared/api/ops/conversation';
import { b11SessionOps } from '../../../shared/api/ops/session';
import { PREPARED_SURFACE } from '../../../shared/api/prepared';
import type { PreparedName } from '../../../shared/api/prepared';
import type { Implementation, OpContext, Registry, RuleCheck } from '../call';
import type { TokenCaller } from '../caller';
import type { SessionControl } from '../session-control';

/*
 * B11 C6's and C7's operations as the core implements them, prepared for X9 to register: their
 * schemas are `b11SessionOps` and `b11ConversationOps.reply` (its typed answers), their surfaces
 * PREPARED_SURFACE, and R5's check on a token's session.rewind is `restore-code`'s. `reply`'s
 * implementation is the live one (ops/reply.ts, over the reply router), given the runtime's
 * handlers (OpServices.replies) where these are registered. Nothing composes these into the live
 * registry until then; the core's tests do (CoreConfig.preparedOps).
 */

/** The prepared session ops: those SessionControl implements. */
type SessionName = Exclude<PreparedName, 'reply'>;

type ArgsOf<N extends SessionName> = z.infer<(typeof b11SessionOps)[N]['input']>;

type Prepared = {
  [N in SessionName]: (args: ArgsOf<N>, ctx: OpContext) => unknown;
};

/** Their schemas, by name. */
export const PREPARED_OPS: Readonly<Record<PreparedName, OpDef>> = Object.fromEntries(
  (Object.keys(PREPARED_SURFACE) as PreparedName[]).map((name) => [
    name,
    name === 'reply' ? b11ConversationOps.reply : b11SessionOps[name],
  ]),
) as unknown as Record<PreparedName, OpDef>;

/** The session ops' implementations, by name (reply's is the live one). */
export function preparedOps(control: SessionControl): Readonly<Record<string, Implementation>> {
  const ops: Prepared = {
    'session.open': (args) => control.open(args),
    'session.setMode': (args, ctx) => control.setMode(args, ctx),
    'session.setModel': (args, ctx) => control.setModel(args, ctx),
    'session.setEffort': (args, ctx) => control.setEffort(args, ctx),
    'session.stopTask': (args, ctx) => control.stopTask(args, ctx),
    'session.restart': (args, ctx) => control.restart(args, ctx),
    'session.newConversation': (args, ctx) => control.newConversation(args, ctx),
    'session.rewindPreview': (args) => control.rewindPreview(args),
    'session.rewind': (args, ctx) => control.rewind(args, ctx),
    'session.continueIn': (args, ctx) => control.continueIn(args, ctx),
  };
  return ops;
}

/** R5's argument check, `restore-code` on session.rewind: a token's code restore proposes. */
export function preparedRules(control: SessionControl): Registry['rules'] {
  const restoreCode = ((args: ArgsOf<'session.rewind'>, call: { caller: TokenCaller }) =>
    control.restoreCode(args, call)) as RuleCheck;
  return { 'restore-code': { 'session.rewind': restoreCode } };
}
