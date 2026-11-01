import { BranchDiffInput, BranchDiffOutput, BranchMergeInput, BranchMergeOutput } from '../branch';
import { define } from '../define';
import type { OpDef } from '../define';
import type { OpName } from '../surface';

/** Review and local merge over the core's verified workspace services (B9b). */
export const branchOps = {
  'branch.diff': define('branch.diff', {
    summary:
      'Reviews an agent’s branch against its recorded base, with committed and uncommitted ' +
      'changes apart and the picked checkout’s current branch. Shared names only members you ' +
      'reach; the patch covers their whole worktree. Pages are bounded and revalidated; a changed ' +
      'review must be read again. Reads only, making and fetching nothing.',
    input: BranchDiffInput,
    output: BranchDiffOutput,
  }),
  // X1's strict contracts already include the required request and receipts on each outcome.
  // Keep them intact: define's ordinary write envelope makes request optional and takes one
  // object result, while this command has two object outcomes and requires a durable job key.
  'branch.merge': {
    summary:
      'Merges an agent’s generated branch into the picked checkout’s pinned current branch, ' +
      'locally, once every member is idle. Source and destination must match what you reviewed. ' +
      'For uncommitted work, choose leave or commit with its reviewed digest. Conflicts and ' +
      'unsafe checkouts are refused; no push or cleanup. Answers once settled; repeat the same ' +
      'request to retrieve its first result. Only you and outside write tokens allowed to merge.',
    input: BranchMergeInput,
    output: BranchMergeOutput,
  },
} satisfies Partial<Record<OpName, OpDef>>;
