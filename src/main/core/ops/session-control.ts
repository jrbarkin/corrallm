import type { b11SessionOps } from '../../../shared/api/ops/session';
import type { z } from 'zod';
import type { SessionControl } from '../session-control';
import type { Registry, RuleCheck } from '../call';
import type { TokenCaller } from '../caller';
import type { Implementations } from '.';

type SessionName =
  | 'session.open'
  | 'session.setMode'
  | 'session.setModel'
  | 'session.setEffort'
  | 'session.stopTask'
  | 'session.restart'
  | 'session.newConversation'
  | 'session.rewindPreview'
  | 'session.rewind'
  | 'session.continueIn';
type ArgsOf<N extends SessionName> = z.infer<(typeof b11SessionOps)[N]['input']>;

/** The registered session operations delegate every refusal and effect to the core service. */
export function sessionControlOps(control: SessionControl): Pick<Implementations, SessionName> {
  return {
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
}
/** R5's argument check, `restore-code` on session.rewind: a token's code restore proposes. */
export function sessionRules(control: SessionControl): Registry['rules'] {
  const restoreCode = ((args: ArgsOf<'session.rewind'>, call: { caller: TokenCaller }) =>
    control.restoreCode(args, call)) as RuleCheck;
  return { 'restore-code': { 'session.rewind': restoreCode } };
}
