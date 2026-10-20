import type { CanvasDocument } from '../../../shared/model/canvas';
import { OpFailure } from '../call';
import type { Built } from '../canvas/documents';
import type { Implementations } from '.';

/*
 * canvas.batch (Core Server §4 B, B9 Design §5): several doc ops as one commit. Each inner op is
 * prepared as a call of the caller's own (its audience, arguments, reach, self and argument rules:
 * ctx.prepare), then their builds run in order over the live document, each over what the one
 * before left, as one change, which ctx.commit checks whole against every change rule: refused
 * whole if any part is, a proposal for you of the whole if it deletes an agent (R4), and otherwise
 * committed at one revision. A failure names the inner op it came from.
 */

export function batchOps(): Pick<Implementations, 'canvas.batch'> {
  return {
    'canvas.batch': async ({ canvas, ops }, ctx) => {
      const builds: ((document: CanvasDocument) => Built<unknown>)[] = [];
      for (const [at, { op, args }] of ops.entries()) {
        try {
          builds.push(await ctx.prepare(op, { ...args, canvas }));
        } catch (error) {
          throw named(error, at, op);
        }
      }
      return ctx.commit(canvas, (document) => {
        let next = document;
        const results: Record<string, unknown>[] = [];
        const copies = new Map<string, string>();
        for (const [at, build] of builds.entries()) {
          const built = inner(at, ops[at]?.op ?? '', () => build(next));
          next = built.next;
          results.push(built.result as Record<string, unknown>);
          for (const [copy, source] of built.copies ?? []) copies.set(copy, source);
        }
        return { next, result: { results }, copies };
      });
    },
  };
}

/** What `run` gives for the batch's op `at`, `op`: its failure saying which op it was. */
function inner<T>(at: number, op: string, run: () => T): T {
  try {
    return run();
  } catch (error) {
    throw named(error, at, op);
  }
}

/** `error`, an inner op's, saying which: as it is, if it isn't an op's failure. */
function named(error: unknown, at: number, op: string): unknown {
  if (!(error instanceof OpFailure)) return error;
  return new OpFailure(error.code, `ops[${String(at)}] (${op}): ${error.message}`, error.current);
}
