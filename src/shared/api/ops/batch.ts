import { z } from 'zod';

import { define } from '../define';
import type { OpDef } from '../define';
import { OpCanvas } from '../ids';
import { MAX_BATCH_BYTES, MAX_BATCH_OPS } from '../limits';
import { SURFACE } from '../surface';
import type { OpName } from '../surface';
import { agentOps } from './agent';
import { canvasOps } from './canvas';
import { queueOps } from './queue';

/*
 * `canvas.batch` (Core Server §4 B, B9 Design §5): several of a canvas's document edits as one
 * commit, at one revision, all or nothing. Each inner op is a doc op's arguments but the canvas and
 * the request, which the batch's are, and the revisions it expects of entities, which the batch's
 * `expect` holds for all of them: what the caller read before the batch. An inner op can't name
 * what an earlier one creates (the core mints ids as it commits), so a new agent's role comes with
 * `canvas.addAgent`'s own `role`; each inner op's result comes back, in order, its new ids with it.
 */

/** The ops a batch may hold: every doc op but the batch itself. */
export type DocOpName = Exclude<
  { [N in OpName]: (typeof SURFACE)[N]['kind'] extends 'doc' ? N : never }[OpName],
  'canvas.batch'
>;

/** Where the doc ops' schemas are defined: every one of them, the compiler says. */
const DEFINED = { ...canvasOps, ...agentOps, ...queueOps } satisfies Partial<
  Record<OpName, OpDef>
> &
  Record<DocOpName, OpDef>;

/** Every op a batch may hold, by name, in the registry's order. */
export const DOC_OPS = (Object.keys(SURFACE) as OpName[]).filter(
  (name): name is DocOpName => SURFACE[name].kind === 'doc' && name !== 'canvas.batch',
);

/** An inner op: which doc op, and its arguments but the batch's own. */
export interface BatchOp {
  op: DocOpName;
  args: Record<string, unknown>;
}

const InnerOp = z.discriminatedUnion(
  'op',
  DOC_OPS.map((name) =>
    z.strictObject({
      op: z.literal(name),
      args: (DEFINED[name].input as z.ZodObject).omit({
        canvas: true,
        request: true,
        expect: true,
      }),
    }),
  ) as unknown as [z.ZodObject, ...z.ZodObject[]],
) as unknown as z.ZodType<BatchOp>;

const utf8 = (text: string) => new TextEncoder().encode(text).length;

export const batchOps = {
  'canvas.batch': define('canvas.batch', {
    summary:
      'Makes several edits of a canvas’s document as one change, at one revision, all or ' +
      'nothing. Each of `ops` is a document edit: `op` names it (canvas.rename for the ' +
      'canvas_rename tool, agent.setRole for agent_setRole, and so on) and `args` are its ' +
      'arguments but canvas, request and expect, which the batch’s are. Each is checked as if ' +
      'called alone, then they apply in order, and every rule is checked on the whole change, so ' +
      'it is refused whole if any part is. ' +
      'Returns each edit’s result, in order (new ids among them); an edit can’t name what an ' +
      'earlier one creates. A batch deleting an agent comes to the user as one proposal.',
    input: z.strictObject({
      canvas: OpCanvas,
      ops: z
        .array(InnerOp)
        .min(1)
        .max(MAX_BATCH_OPS)
        .refine((ops) => utf8(JSON.stringify(ops)) <= MAX_BATCH_BYTES, {
          message: `At most ${String(MAX_BATCH_BYTES / 1024 / 1024)} MB of ops in one batch`,
        })
        .meta({ maxBytes: MAX_BATCH_BYTES }),
    }),
    output: z.strictObject({ results: z.array(z.looseObject({})) }),
  }),
} satisfies Partial<Record<OpName, OpDef>>;
