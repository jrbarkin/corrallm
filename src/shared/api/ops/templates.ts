import { z } from 'zod';

import { JOBS } from '../../adapter';
import { MAX_NODE_ID } from '../../model/canvas';
import { define } from '../define';
import type { OpDef } from '../define';
import type { OpName } from '../surface';

const Template = z.strictObject({
  id: z.uuid(),
  name: z.string().min(1).max(1024),
  description: z.string().max(8192),
  fields: z
    .array(
      z.strictObject({
        key: z.string().min(1).max(128),
        label: z.string().max(1024),
        example: z.string().max(16_384),
      }),
    )
    .max(128),
  agents: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(MAX_NODE_ID),
        name: z.string().max(1024),
        jobs: z.array(z.enum(JOBS)).max(JOBS.length),
      }),
    )
    .max(256),
});

export const templatesOps = {
  'templates.list': define('templates.list', {
    summary:
      'The shipped canvas templates: their names, descriptions, fields to fill and agent roles, with the jobs each role receives.',
    input: z.strictObject({}),
    output: z.strictObject({ items: z.array(Template).max(128) }),
  }),
} satisfies Partial<Record<OpName, OpDef>>;
