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

/** A worktree's base: the branch it was made from (none: a detached HEAD) and its commit. */
const Base = z.strictObject({ ref: z.string().nullable(), oid: z.string() });

/** An agent's working directory, as worktree.list says it. */
const ListedState = z.enum([
  'no-project',
  'unmade',
  'creating',
  'setup',
  'ready',
  'pending-change',
  'missing',
  'error',
]);

/** An agent's worktree, as worktree.list says it (src/main/core/workspaces/list.ts). */
const ListedWorktree = z.strictObject({
  agent: z.string(),
  mode: z.enum(['own', 'group', 'shared-folder']),
  group: z.string().optional(),
  workspace: z.uuid().nullable(),
  generation: z.int().min(0),
  branch: z.string().nullable(),
  base: Base.nullable(),
  state: ListedState,
  // The user's alone: the card waiting on it, why it failed, where it is and its setup.
  need: z.string().optional(),
  error: z.string().optional(),
  location: z.string().optional(),
  setup: z
    .strictObject({
      state: z.enum(['pending', 'running', 'done', 'skipped', 'failed', 'interrupted']),
      command: z.string().nullable(),
      source: z.enum(['configured', 'detected', 'none']),
      exitCode: z.int().nullable(),
    })
    .optional(),
});

/** A worktree the canvas keeps, its agents gone: the user's alone (Kept worktrees). */
const KeptWorktree = z.strictObject({
  workspace: z.uuid(),
  owner: z.string(),
  name: z.string().nullable(),
  branch: z.string(),
  base: Base,
  state: z.enum(['retained', 'removing']),
  error: z.string().nullable(),
  location: z.string(),
  createdAt: z.int().min(0),
});

/**
 * B9a's worktrees (§7): who works where, read by every caller as far as it reaches (the GUI through
 * `worktrees:<c>`); an agent's worktree tried again; a kept tree removed, safely, or its
 * confirmation raised for you.
 */
export const b9aWorktreeOps = {
  'worktree.list': define('worktree.list', {
    summary:
      'Where each agent you reach works: its own worktree, its group’s, or the shared project ' +
      'folder (not a Git repository), with its branch, the commit it was made from and whether ' +
      'it is ready, being made or set up, waiting for the user to switch it, lost or failed. ' +
      'With agent, that agent alone. Agents sharing a worktree have the same workspace. What ' +
      'it runs to set up, where it is and the worktrees kept are the user’s alone.',
    input: z.strictObject({ canvas: OpCanvas, agent: AgentId.optional() }),
    output: z.strictObject({ items: z.array(ListedWorktree), kept: z.array(KeptWorktree) }),
  }),
  'worktree.retry': define('worktree.retry', {
    summary:
      'Tries an agent’s worktree again as it was recorded: makes it again if making it failed, ' +
      'finds it again if it was lost, or makes its first one. Never forces, resets or deletes ' +
      'anything; a setup it reaches still asks the user on its card. Only the user retries one. ' +
      'Returns its state then, and the card waiting on it, if one does.',
    input: z.strictObject({ canvas: OpCanvas, agent: AgentId }),
    output: z.strictObject({ state: ListedState, need: z.string().optional() }),
  }),
  'worktree.remove': define('worktree.remove', {
    summary:
      'Removes a worktree the canvas keeps (its agents gone), with its branch: at once if it is ' +
      'clean, merged and no one writes there, else once the user confirms discarding what it ' +
      'holds. Only the user removes one. Returns whether it was removed, or kept because it ' +
      'changed since.',
    input: z.strictObject({ canvas: OpCanvas, worktree: WorktreeId }),
    output: z.strictObject({ removed: z.boolean(), retained: z.boolean().optional() }),
  }),
} satisfies Partial<Record<OpName, OpDef>>;
