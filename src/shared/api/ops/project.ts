import { z } from 'zod';

import { MAX_SETUP_COMMAND_BYTES, UNSEEN_IN_COMMAND } from '../../model/worktree-setup';
import { MAX_FILE_MATCHES, MAX_FILE_QUERY_LENGTH } from '../../session';
import { define } from '../define';
import type { OpDef } from '../define';
import { AgentId, OpCanvas, WorktreeId } from '../ids';
import type { OpName } from '../surface';

/** Project files (Core Server §4 B, §7.3), relative to the canvas's chosen folder. */
export const projectOps = {
  'project.files': define('project.files', {
    summary:
      'Files and folders in the canvas’s project folder that best match query, at most 50. ' +
      'With agent, searches its verified worktree instead. Paths are relative to the searched folder; folders end in a slash. Without a project folder or while the workspace is held, ' +
      'returns an empty list. Ignores files git ignores, or dependency and build folders outside git.',
    input: z.strictObject({
      canvas: OpCanvas,
      agent: AgentId.optional(),
      query: z.string().max(MAX_FILE_QUERY_LENGTH),
    }),
    output: z.strictObject({ items: z.array(z.string()).max(MAX_FILE_MATCHES) }),
  }),
  'project.setSetupCommand': define('project.setSetupCommand', {
    summary:
      'Sets the command that sets up each new worktree of the canvas’s project repository, kept ' +
      'for that repository on this computer: one line of at most 4 KiB, with no control or ' +
      'invisible characters, run by the system shell in the worktree; null goes back to the one ' +
      'its lockfile names, if any. Only the user sets it. A changed command clears Always and ' +
      'offers each worktree still waiting for its setup anew, showing the new command before it ' +
      'runs. Returns whether it changed and how many setups were offered anew.',
    input: z.strictObject({
      canvas: OpCanvas,
      command: z
        .string()
        .min(1)
        .max(MAX_SETUP_COMMAND_BYTES)
        .refine((text) => !UNSEEN_IN_COMMAND.test(text), {
          message: 'A setup command is one line, with no control or invisible characters.',
        })
        .nullable(),
    }),
    output: z.strictObject({ changed: z.boolean(), offered: z.int().min(0) }),
  }),
  'project.clearSetupApproval': define('project.clearSetupApproval', {
    summary:
      'Stops running the setup command the user allowed always for the canvas’s project ' +
      'repository by itself: each new worktree asks again. A setup already running goes on. ' +
      'Only the user clears it. Returns whether one was allowed always.',
    input: z.strictObject({ canvas: OpCanvas }),
    output: z.strictObject({ cleared: z.boolean() }),
  }),
} satisfies Partial<Record<OpName, OpDef>>;

/**
 * B9a C7's worktree op, prepared (X12 registers it with worktree.list and its topic): a kept tree
 * removed, safely, or its confirmation raised for you.
 */
export const b9aWorktreeOps = {
  'worktree.remove': define(
    { kind: 'command', rules: ['discard'] },
    {
      summary:
        'Removes a worktree the canvas keeps (its agents gone), with its branch: at once if it is ' +
        'clean, merged and no one writes there, else once the user confirms discarding what it ' +
        'holds. Only the user removes one. Returns whether it was removed, or kept because it ' +
        'changed since.',
      input: z.strictObject({ canvas: OpCanvas, worktree: WorktreeId }),
      output: z.strictObject({ removed: z.boolean(), retained: z.boolean().optional() }),
    },
  ),
};
