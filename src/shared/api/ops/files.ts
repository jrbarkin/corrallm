import { z } from 'zod';

import { ID_PATTERN } from '../../adapter';
import { MAX_NODE_ID } from '../../model/canvas';
import { define } from '../define';
import type { OpDef } from '../define';
import { CanvasId, OpCanvas } from '../ids';
import { MAX_TEMPLATE_AGENTS, MAX_TEMPLATE_FIELDS, MAX_TEMPLATE_VALUE } from '../limits';
import type { OpName } from '../surface';

/*
 * A canvas's lifetime and where it is kept (Core Server §4 B, B9 Design §1, §5, §6): making one,
 * from a template or empty; opening a file; saving it, to its file or to one you pick; closing it,
 * keeping its edits or discarding them; and choosing its project folder. A path comes only from a
 * dialog you complete (D1, trust-gate): no argument names one. A token's call that would discard
 * work (its edits, a file's agents) or close a canvas a window shows comes to you as a proposal
 * (R4).
 */

/** A map's worst case is bounded by its keys' count, which its JSON Schema says. */
function most<T extends z.ZodType>(map: T, count: number, what: string): T {
  return map
    .refine((value) => Object.keys(value as object).length <= count, {
      message: `At most ${String(count)} ${what}`,
    })
    .meta({ maxProperties: count });
}

/** A template agent, by its id in the template (templates.list's `agents`). */
const TemplateAgent = z.string().min(1).max(MAX_NODE_ID);
/** An adapter's or a connection's id, as the catalog names it. */
const CatalogId = z.string().min(1).max(32).regex(ID_PATTERN);

/** The canvas a call replaces: closed once the new one is made, its edits kept unless discarded. */
const Replace = z.strictObject({
  canvas: CanvasId,
  discard: z
    .boolean()
    .optional()
    .meta({ description: 'Discard its edits not saved: back to its file, or a draft forgotten.' }),
});

/** A canvas's project folder, by its name and path: none if it has none. */
const Project = z.strictObject({ name: z.string(), path: z.string() }).nullable();

export const filesOps = {
  'canvas.create': define('canvas.create', {
    summary:
      'Makes a canvas: empty, or from a template (its id from templates.list), its blanks filled ' +
      'with `values`, its open agents given `agents`’ adapters and `connections` (else each ' +
      'adapter’s first). Text a token’s values fill in is marked as that token’s. With `replace`, ' +
      'that canvas is closed once this one is made. A token’s canvas has no project folder until ' +
      'the user picks one in the app: nothing runs on it till then. Returns the new canvas’s id.',
    input: z.strictObject({
      template: z.uuid().optional(),
      values: most(
        z.record(z.string().min(1).max(128), z.string().max(MAX_TEMPLATE_VALUE)),
        MAX_TEMPLATE_FIELDS,
        'values',
      ).optional(),
      agents: most(z.record(TemplateAgent, CatalogId), MAX_TEMPLATE_AGENTS, 'agents').optional(),
      connections: most(
        z.record(TemplateAgent, CatalogId),
        MAX_TEMPLATE_AGENTS,
        'connections',
      ).optional(),
      replace: Replace.optional(),
    }),
    output: z.strictObject({ canvas: z.uuid() }),
  }),
  'canvas.open': define('canvas.open', {
    summary:
      'Opens a canvas file the user picks in the Open dialog, in the calling window, closing ' +
      '`replace` once it opened. Null if the dialog was cancelled.',
    input: z.strictObject({ replace: Replace.optional() }),
    output: z.strictObject({ canvas: z.uuid().nullable() }),
  }),
  'canvas.save': define('canvas.save', {
    summary:
      'Saves a canvas to its file. A canvas never saved has none: the user saves it in the app, ' +
      'choosing where. Returns its file’s name.',
    input: z.strictObject({ canvas: OpCanvas }),
    output: z.strictObject({ name: z.string() }),
  }),
  'canvas.saveAs': define('canvas.saveAs', {
    summary:
      'Saves a canvas to a file the user picks in the Save dialog, which becomes its file; the ' +
      'canvas keeps its id. Null if the dialog was cancelled.',
    input: z.strictObject({ canvas: OpCanvas }),
    output: z.strictObject({ name: z.string().nullable() }),
  }),
  'canvas.close': define('canvas.close', {
    summary:
      'Closes a canvas: its run held and kept, its sessions ended, its windows showing another. ' +
      'Its edits not saved are kept for when it opens again, unless `discard`, which reverts it ' +
      'to its file, or forgets a canvas never saved.',
    input: z.strictObject({
      canvas: OpCanvas,
      discard: z
        .boolean()
        .optional()
        .meta({ description: 'Discard its edits not saved: back to its file, or forgotten.' }),
    }),
    output: z.strictObject({}),
  }),
  'project.choose': define('project.choose', {
    summary:
      'Asks the user, in the folder dialog, for the folder a canvas’s agents work in; its ' +
      'sessions end once another is chosen. Null if the dialog was cancelled.',
    input: z.strictObject({ canvas: OpCanvas }),
    output: z.strictObject({ project: Project }),
  }),
} satisfies Partial<Record<OpName, OpDef>>;
