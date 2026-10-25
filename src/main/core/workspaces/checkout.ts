import { lstatSync } from 'node:fs';
import path from 'node:path';

import { mintTrustedPath } from '../host';
import type { TrustedPath } from '../host';
import { agrees, gitdirOf, realOrNone, registrations, repositoryIdentity } from './discovery';
import { GitError } from './git';
import type { GitRunner } from './git';
import { OwnedRootError, verifyOwnedRoot } from './owned';
import type { RepositoryRecord, WorktreeRecord } from './store';

/*
 * A workspace's checkout, checked to be the one the core made (B9a Design §2: "revalidate its owned
 * location, Git identity and registration before minting it again"), and the TrustedPath minted
 * for it: the one mint site of the workspaces (src/main/boundaries.test.ts pins it). A path read
 * back from the store is a record, never trusted as it is: each use checks, as Git and the file
 * system say now, that
 *
 * - the repository is the one recorded: its checkout at its real path, its common Git directory
 *   with the identity recorded;
 * - the owned root verifies (real folders of the user's from the checkout down, no symlink,
 *   private, marked as this repository's), and the checkout is the folder of it named by the
 *   workspace's id: a real folder, not a symlink;
 * - its `.git` names a registration in the common directory whose back-pointer names it back, Git
 *   finds it as its own top level with that common directory, and Git lists it as registered.
 *
 * Only then is its path minted. The project folder picked is the trust gate; this checkout is
 * that repository's, made by the core in the folder it owns there. A failed check is never taken
 * for a safe one: it says what failed, and nothing is minted.
 */

/** Why a checkout isn't the one made. */
export type CheckoutFault =
  /** Its folder is gone. */
  | 'checkout-missing'
  /** The picked checkout, or its Git directory, is gone. */
  | 'repository-missing'
  /** Another repository is there now. */
  | 'repository-changed'
  /** Its folder, `.git`, registration or top level isn't what was made. */
  | 'checkout-changed'
  /** The owned root doesn't verify. */
  | 'owned-root'
  /** Git couldn't check it: unknown, so never taken for safe. */
  | 'git-failed';

/** What a checkout is, as checked. */
export interface CheckedCheckout {
  path: string;
  /** Its registration in the common directory. */
  gitDir: string;
  /** The branch checked out there now (none: detached), and its commit. */
  branch: string | null;
  head: string | null;
}

export type Check =
  { ok: true; checkout: CheckedCheckout } | { ok: false; fault: CheckoutFault; detail: string };

function fail(fault: CheckoutFault, detail: string): Check {
  return { ok: false, fault, detail };
}

/** Checks that the workspace's checkout is the one made: mints nothing. */
export async function checkCheckout(
  git: GitRunner,
  repository: RepositoryRecord,
  worktree: WorktreeRecord,
): Promise<Check> {
  if (worktree.repository !== repository.id) {
    return fail('checkout-changed', 'It is recorded as another repository’s.');
  }
  if (realOrNone(repository.realRoot) !== repository.realRoot) {
    return fail('repository-missing', `The checkout ${repository.realRoot} is gone.`);
  }
  let identity: string;
  try {
    identity = repositoryIdentity(repository.commonDir);
  } catch {
    return fail('repository-missing', `The Git directory ${repository.commonDir} is gone.`);
  }
  if (identity !== repository.identity) {
    return fail('repository-changed', 'Another repository is at the project folder now.');
  }
  try {
    verifyOwnedRoot(repository);
  } catch (error) {
    if (!(error instanceof OwnedRootError)) throw error;
    return error.code === 'missing'
      ? fail('checkout-missing', error.message)
      : fail('owned-root', error.message);
  }
  const at = worktree.path;
  if (path.dirname(at) !== repository.ownedRoot || path.basename(at) !== worktree.id) {
    return fail('checkout-changed', 'Its path isn’t its folder of the owned root.');
  }
  try {
    const found = lstatSync(at);
    if (found.isSymbolicLink() || !found.isDirectory()) {
      return fail('checkout-changed', 'Its folder is a symlink, or no folder.');
    }
    if (process.platform !== 'win32' && found.uid !== process.getuid?.()) {
      return fail('checkout-changed', 'Its folder is another user’s.');
    }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? fail('checkout-missing', `${at} is gone.`)
      : fail('checkout-changed', `${at} can’t be read.`);
  }
  if (realOrNone(at) !== at) return fail('checkout-changed', 'Its folder isn’t its real path.');
  const gitDir = gitdirOf(path.join(at, '.git'));
  const registered = gitDir === undefined ? undefined : realOrNone(gitDir);
  if (registered === undefined || !agrees(at, registered, repository.commonDir)) {
    return fail('checkout-changed', 'Its .git and the worktree Git registered don’t agree.');
  }
  try {
    const { stdout } = await git.run({
      cwd: at,
      args: [
        'rev-parse',
        '--path-format=absolute',
        '--show-toplevel',
        '--git-common-dir',
        '--git-dir',
      ],
    });
    const [top = '', common = '', own = ''] = stdout.split('\n');
    if (
      realOrNone(top) !== at ||
      realOrNone(common) !== repository.commonDir ||
      realOrNone(own) !== registered
    ) {
      return fail('checkout-changed', 'Git doesn’t find it as the checkout made.');
    }
    const listed = await git.run({ cwd: at, args: ['worktree', 'list', '--porcelain', '-z'] });
    const entry = registrations(listed.stdout).find(
      (candidate) => !candidate.bare && realOrNone(candidate.path) === at,
    );
    if (entry === undefined) {
      return fail('checkout-changed', 'Git hasn’t registered it as a checkout.');
    }
    return {
      ok: true,
      checkout: { path: at, gitDir: registered, branch: entry.branch, head: entry.head },
    };
  } catch (error) {
    if (!(error instanceof GitError)) throw error;
    return error.fault === 'failed' && error.stderr.includes('not a git repository')
      ? fail('checkout-changed', 'Git doesn’t find a checkout there.')
      : fail('git-failed', error.message);
  }
}

/** A checkout checked, and its path minted: the folder agents of the workspace work in. */
export type Verified =
  | { ok: true; cwd: TrustedPath; checkout: CheckedCheckout }
  | { ok: false; fault: CheckoutFault; detail: string };

/**
 * The workspaces' mint site: the workspace's checkout path as a TrustedPath, only once
 * `checkCheckout` says it is the checkout the core made of the picked repository, in the folder it
 * owns there. Never a path a caller names: the path is the workspace record's, checked again.
 */
export async function verifiedCheckout(
  git: GitRunner,
  repository: RepositoryRecord,
  worktree: WorktreeRecord,
): Promise<Verified> {
  const checked = await checkCheckout(git, repository, worktree);
  if (!checked.ok) return checked;
  return { ok: true, cwd: mintTrustedPath(checked.checkout.path), checkout: checked.checkout };
}
