// The DCO check CI runs on pull requests from forks (.github/workflows/ci.yml):
//   node scripts/check-dco.mjs <base> <head>
// Every non-merge commit in <base>..<head> must carry a `Signed-off-by:` trailer whose name and
// email are its author's (the email compared without case). Otherwise it names each commit that
// does not, and how to sign off, and exits 1. Needs only git; reads nothing from the network.
import { execFileSync } from 'node:child_process';

const [base, head, ...rest] = process.argv.slice(2);
const revision = /^[0-9a-fA-F]{7,64}$|^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
if (!base || !head || rest.length > 0 || !revision.test(base) || !revision.test(head)) {
  console.error('Usage: node scripts/check-dco.mjs <base> <head>');
  process.exit(2);
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
const range = `${base}..${head}`;
const all = git('rev-list', range).split('\n').filter(Boolean);
const commits = git('rev-list', '--no-merges', range).split('\n').filter(Boolean);
const merges = all.length - commits.length;

const failures = [];
for (const sha of commits) {
  const [name, email, subject] = git('log', '-1', '--format=%an%x00%ae%x00%s', sha)
    .replace(/\n$/, '')
    .split('\0');
  const trailers = git('log', '-1', '--format=%(trailers:key=Signed-off-by,valueonly,unfold)', sha)
    .split('\n')
    .filter(Boolean);
  const signedByAuthor = trailers.some((value) => {
    const match = /^(.*?)\s*<([^<>]*)>$/.exec(value.trim());
    return match !== null && match[1] === name && match[2]?.toLowerCase() === email?.toLowerCase();
  });
  if (!signedByAuthor) failures.push({ sha, name, email, subject });
}

if (failures.length > 0) {
  console.error(
    'These commits are not signed off by their author (the Developer Certificate of Origin):\n',
  );
  for (const { sha, name, email, subject } of failures) {
    console.error(
      `  ${sha.slice(0, 12)}  ${subject}\n      needs: Signed-off-by: ${name} <${email}>`,
    );
  }
  console.error(
    '\nSign off every commit with `git commit -s`. For commits already made:\n' +
      '  git rebase --signoff <base branch>\n  git push --force-with-lease\n' +
      'See CONTRIBUTING.md.',
  );
  process.exit(1);
}
console.log(
  `DCO: ${String(commits.length)} commits signed off by their authors` +
    (merges > 0 ? ` (${String(merges)} merge skipped)` : '') +
    '.',
);
