import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { vi } from 'vitest';

import { GitRunner } from './git';
import type { GitCall, GitOutput } from './git';

/**
 * Workspace policy tests keep real files, registrations and records, but need no Git process.
 * One fixed commit is already in main; notes.md is the only untracked file in the fixture.
 * Unexpected commands fail instead of silently pretending a write succeeded.
 */
export function fakeWorkspaceGit(app: string, oid: string): () => void {
  const common = path.join(app, '.git');
  const trees = new Map<string, { gitDir: string; branch: string }>();
  const refs = new Map([['refs/heads/main', oid]]);
  mkdirSync(common, { recursive: true });
  writeFileSync(path.join(common, 'HEAD'), 'ref: refs/heads/main\n');
  const output = (stdout = '', code = 0): GitOutput => ({ code, stdout, stderr: '' });
  function answer(call: GitCall): GitOutput {
    const { cwd, args } = call;
    const tree = trees.get(cwd);
    const gitDir = tree?.gitDir ?? common;
    const branch = tree?.branch ?? 'refs/heads/main';
    if (args[0] === 'rev-parse') {
      if (args.includes('--show-toplevel')) {
        return output(
          args
            .slice(2)
            .map((arg) => {
              switch (arg) {
                case '--show-toplevel':
                  return cwd;
                case '--git-dir':
                  return gitDir;
                case '--git-common-dir':
                  return common;
                case '--show-object-format':
                  return 'sha1';
                default:
                  throw new Error(`Unexpected rev-parse flag: ${arg}`);
              }
            })
            .join('\n') + '\n',
        );
      }
      return output(`${oid}\n`);
    }
    if (args[0] === 'symbolic-ref') return output(`${branch}\n`);
    if (args[0] === 'for-each-ref') {
      return output(
        [...refs]
          .filter(([ref]) => ref === args.at(-1))
          .map(([ref, value]) => `${ref}\0${value}\n`)
          .join(''),
      );
    }
    if (args[0] === 'merge-base') return output();
    if (args[0] === 'status') {
      // File reads stay real, including the fingerprint used by workspace-safety's proposal.
      try {
        readFileSync(path.join(cwd, 'notes.md'));
        return output('?? notes.md\0');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return output();
      }
    }
    if (args[0] === 'ls-files') return output();
    // This fixture has neither a copy manifest nor dependency metadata in its base commit.
    if (args[0] === 'ls-tree') return output();
    if (args[0] === 'update-ref') {
      const index = args.indexOf('--end-of-options');
      const ref = args[index + 1];
      if (index < 0 || !ref) throw new Error('A ref must follow --end-of-options.');
      if (args.includes('-d')) refs.delete(ref);
      else refs.set(ref, args[index + 2] ?? '');
      return output();
    }
    if (args[0] === 'worktree' && args[1] === 'add') {
      const at = args.at(-2);
      const ref = args.at(-1);
      if (!at || !ref) throw new Error('A worktree needs a path and ref.');
      const registration = path.join(common, 'worktrees', path.basename(at));
      mkdirSync(registration, { recursive: true });
      mkdirSync(at, { recursive: true });
      writeFileSync(path.join(at, '.git'), `gitdir: ${registration}\n`);
      writeFileSync(path.join(registration, 'gitdir'), `${path.join(at, '.git')}\n`);
      writeFileSync(path.join(registration, 'HEAD'), `ref: refs/heads/${ref}\n`);
      writeFileSync(path.join(registration, 'commondir'), '../..\n');
      trees.set(at, { gitDir: registration, branch: `refs/heads/${ref}` });
      return output();
    }
    if (args[0] === 'worktree' && args[1] === 'list') {
      return output(
        [
          `worktree ${app}\0HEAD ${oid}\0branch refs/heads/main\0\0`,
          ...[...trees].map(
            ([at, entry]) => `worktree ${at}\0HEAD ${oid}\0branch ${entry.branch}\0\0`,
          ),
        ].join(''),
      );
    }
    if (args[0] === 'worktree' && args[1] === 'remove') {
      const at = args.at(-1);
      const entry = at === undefined ? undefined : trees.get(at);
      if (!at || !entry) throw new Error('No such fake worktree.');
      rmSync(at, { recursive: true });
      rmSync(entry.gitDir, { recursive: true });
      trees.delete(at);
      return output();
    }
    if (args[0] === 'read-tree') return output();
    throw new Error(`Unexpected workspace Git call: ${JSON.stringify(args)}`);
  }
  const run = vi
    .spyOn(GitRunner.prototype, 'run')
    .mockImplementation((call) => Promise.resolve(answer(call)));
  const inspect = vi.spyOn(GitRunner.prototype, 'inspect').mockResolvedValue({
    drivers: [],
    mergeDrivers: [],
    refusals: [],
  });
  return () => {
    run.mockRestore();
    inspect.mockRestore();
  };
}
