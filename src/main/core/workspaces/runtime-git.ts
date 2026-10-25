import { GitError, GitRunner } from './git';
import type { GitCall, GitOutput } from './git';

/** The composed runner stops admitting phases before Children ends its owned processes. */
export class WorkspaceGit extends GitRunner {
  #stopped = false;

  #isStopped(): boolean {
    return this.#stopped;
  }

  stop(): void {
    this.#stopped = true;
  }

  override async run(call: GitCall): Promise<GitOutput> {
    if (this.#stopped) throw interrupted();
    let result: GitOutput;
    try {
      result = await super.run(call);
    } catch (error) {
      if (this.#isStopped()) throw interrupted();
      throw error;
    }
    // Preserve the create job's interrupted intent even when SIGTERM just ended its child.
    if (this.#isStopped()) throw interrupted();
    return result;
  }
}
function interrupted(): GitError {
  return new GitError('refused', 'corrallm is closing: its workspace job will continue next time.');
}
