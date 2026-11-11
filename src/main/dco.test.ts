import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, expect, it } from 'vitest';

const exec = promisify(execFile);
const SCRIPT = path.resolve(import.meta.dirname, '../../scripts/check-dco.mjs');
const folders: string[] = [];
afterEach(async () => {
  await Promise.all(
    folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
  );
});

const ALEX = { name: 'Alex Contributor', email: 'alex@example.com' };
const SAM = { name: 'Sam Other', email: 'sam@example.com' };

/** A throwaway repository: a first commit, then whatever commits a test makes on a branch. */
async function repository() {
  const dir = await mkdtemp(path.join(tmpdir(), 'dco-'));
  folders.push(dir);
  const base: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'Maintainer',
    GIT_AUTHOR_EMAIL: 'maintainer@example.com',
    GIT_COMMITTER_NAME: 'Maintainer',
    GIT_COMMITTER_EMAIL: 'maintainer@example.com',
  };
  const git = async (args: string[], env: NodeJS.ProcessEnv = {}) =>
    (await exec('git', args, { cwd: dir, env: { ...base, ...env } })).stdout.trim();
  await git(['init', '--quiet', '--initial-branch=main']);
  await writeFile(path.join(dir, 'a.txt'), 'a');
  await git(['add', '.']);
  await git(['commit', '--quiet', '-m', 'Base']);
  const start = await git(['rev-parse', 'HEAD']);
  let counter = 0;
  async function commit(
    message: string,
    author = ALEX,
    committer: { name: string; email: string } = author,
  ): Promise<string> {
    counter += 1;
    await writeFile(path.join(dir, 'a.txt'), String(counter));
    await git(['commit', '--quiet', '-a', '-m', message], {
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
      GIT_COMMITTER_NAME: committer.name,
      GIT_COMMITTER_EMAIL: committer.email,
    });
    return git(['rev-parse', 'HEAD']);
  }
  const check = async (args?: string[]) => {
    const head = await git(['rev-parse', 'HEAD']);
    return exec('node', [SCRIPT, ...(args ?? [start, head])], {
      cwd: dir,
      env: { ...base, GIT_CONFIG_GLOBAL: '/dev/null' },
    });
  };
  return { dir, git, commit, check, start };
}

const signed = (who: { name: string; email: string }) =>
  `Change\n\nSigned-off-by: ${who.name} <${who.email}>`;

it('passes commits that carry their author’s sign-off, the email compared without case', async () => {
  const { commit, check } = await repository();
  await commit(signed(ALEX));
  await commit(`Another\n\nSigned-off-by: ${ALEX.name} <ALEX@Example.COM>`);
  const { stdout } = await check();
  expect(stdout).toContain('2 commits');
});

it('fails a commit with no sign-off, naming it and how to sign off', async () => {
  const { commit, check } = await repository();
  await commit(signed(ALEX));
  const bad = await commit('No sign-off here');
  await expect(check()).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining(bad.slice(0, 12)) as string,
  });
  await expect(check()).rejects.toMatchObject({
    stderr: expect.stringContaining('git rebase --signoff') as string,
  });
  await expect(check()).rejects.toMatchObject({
    stderr: expect.stringContaining('No sign-off here') as string,
  });
});

it('fails a sign-off for another person', async () => {
  const { commit, check } = await repository();
  const bad = await commit(signed(SAM), ALEX);
  await expect(check()).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining(bad.slice(0, 12)) as string,
  });
});

it('fails a matching email under another name, and a matching name under another email', async () => {
  const { commit, check } = await repository();
  await commit(`x\n\nSigned-off-by: Someone Else <${ALEX.email}>`);
  await expect(check()).rejects.toMatchObject({ code: 1 });
  const second = await repository();
  await second.commit(`x\n\nSigned-off-by: ${ALEX.name} <other@example.com>`);
  await expect(second.check()).rejects.toMatchObject({ code: 1 });
});

it('takes any one of several trailers that matches the author', async () => {
  const { commit, check } = await repository();
  await commit(
    `x\n\nSigned-off-by: ${SAM.name} <${SAM.email}>\nSigned-off-by: ${ALEX.name} <${ALEX.email}>`,
  );
  await check();
});

it('does not take a co-author line or the committer for a sign-off', async () => {
  const { commit, check } = await repository();
  await commit(`x\n\nCo-authored-by: ${ALEX.name} <${ALEX.email}>`);
  await expect(check()).rejects.toMatchObject({ code: 1 });
  const second = await repository();
  // Signed off by the committer, not the author.
  await second.commit(signed(SAM), ALEX, SAM);
  await expect(second.check()).rejects.toMatchObject({ code: 1 });
});

it('skips merge commits, which carry no author’s work', async () => {
  const { git, commit, check, start } = await repository();
  await git(['checkout', '--quiet', '-b', 'side', start]);
  await writeFile(path.join(await git(['rev-parse', '--show-toplevel']), 'b.txt'), 'b');
  await git(['add', 'b.txt']);
  await git(['commit', '--quiet', '-m', signed(ALEX)], {
    GIT_AUTHOR_NAME: ALEX.name,
    GIT_AUTHOR_EMAIL: ALEX.email,
  });
  await git(['checkout', '--quiet', 'main']);
  await commit(signed(ALEX));
  // The merge has no trailer: GitHub's own merge of the base into a branch looks like this.
  await git(['merge', '--quiet', '--no-ff', '-m', 'Merge branch side', 'side']);
  const { stdout } = await check();
  expect(stdout).toContain('2 commits');
  expect(stdout).toContain('1 merge');
});

it('passes a range with no commits in it', async () => {
  const { check, git } = await repository();
  const head = await git(['rev-parse', 'HEAD']);
  const { stdout } = await check([head, head]);
  expect(stdout).toContain('0 commits');
});

it('refuses wrong arguments', async () => {
  const { check } = await repository();
  await expect(check([])).rejects.toMatchObject({ code: 2 });
  await expect(check(['one'])).rejects.toMatchObject({ code: 2 });
  await expect(check(['--flag', 'HEAD'])).rejects.toMatchObject({ code: 2 });
});

it('does not read a revision as an option', async () => {
  const { check } = await repository();
  await expect(check(['--output=x', 'HEAD'])).rejects.toMatchObject({ code: 2 });
});
