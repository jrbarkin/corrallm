import type { CanvasId } from '../../../shared/canvas';
import type { Implementation, OpContext } from '../call';
import type { Implementations } from '.';

/** Runtime writes declare the topics they can change; the publisher receipts only real changes. */
export function withPublication(ops: Implementations): Implementations {
  for (const name of [
    'message',
    'withdraw',
    'reply',
    'session.open',
    'session.setMode',
    'session.setModel',
    'session.setEffort',
    'session.stopTask',
    'session.restart',
    'session.newConversation',
    'session.continueIn',
    'session.rewind',
    'session.interrupt',
    'run.pause',
    'run.kill',
    'run.unpause',
  ] as const) {
    const effect = ops[name] as Implementation;
    Object.assign(ops, {
      [name]: (args: { canvas?: string }, ctx: OpContext) => {
        // core.call has filled and checked canvas reach before invoking the implementation. A
        // proposal or file review may belong to a canvas with no runtime open yet.
        const canvas = args.canvas as CanvasId | undefined;
        if (canvas !== undefined)
          for (const kind of ['run', 'sessions', 'messages', 'needs'] as const)
            ctx.published(`${kind}:${canvas}`);
        return effect(args as never, ctx);
      },
    });
  }
  return ops;
}
