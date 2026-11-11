// What scripts/release.sh asks build/release.ts, run under plain Node:
//   preflight <facts.json> [checks.jsonl]
//                               refusals for the facts and the CI check runs, one JSON object a
//                               line (the environment is read here, never from a file)
//   repository                  the repository releases are made in
//   origin <url>                refuses a remote URL that is not that repository
//   prerelease <version>        true or false
//   rename <folder>             renames files to the names GitHub will store them under
//   audit <audit.json>          the number of advisories in `pnpm audit --json`'s output
//   versions <version>          the deb and rpm versions the installers give it, on one line
//   assets <version> <folder>   what is wrong with the files in the folder
//   scan <name> <listing>       credential-like names and missing notices in one asset's listing
//   sums <folder>               writes <folder>/SHA256SUMS over its files (sha256sum -c format)
// Prints problems, one per line, and exits 1 when there are any.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  checkAssets,
  credentialLike,
  REPOSITORY,
  debVersion,
  isPrerelease,
  isReleaseOrigin,
  missingNotices,
  preflight,
  publishedName,
  sha256sums,
} from '../build/release.ts';
import { rpmVersion } from '../build/linux-version.ts';

const [command, ...args] = process.argv.slice(2);
const lines = (file) =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '');

let problems = [];
switch (command) {
  case 'preflight': {
    const facts = JSON.parse(readFileSync(args[0] ?? '', 'utf8'));
    const checkRuns = args[1] ? lines(args[1]).map((line) => JSON.parse(line)) : [];
    problems = preflight({ ...facts, checkRuns, env: process.env });
    break;
  }
  case 'audit': {
    const { metadata } = JSON.parse(readFileSync(args[0] ?? '', 'utf8'));
    const counts = Object.values(metadata?.vulnerabilities ?? { unreadable: NaN });
    console.log(counts.reduce((sum, count) => sum + count, 0));
    break;
  }
  case 'repository':
    console.log(REPOSITORY);
    break;
  case 'origin':
    if (!isReleaseOrigin(args[0] ?? '')) problems = [`origin is not github.com/${REPOSITORY}.`];
    break;
  case 'prerelease':
    console.log(isPrerelease(args[0] ?? ''));
    break;
  case 'rename':
    for (const name of readdirSync(args[0] ?? '')) {
      const published = publishedName(name);
      if (published !== name)
        renameSync(path.join(args[0] ?? '', name), path.join(args[0] ?? '', published));
    }
    break;
  case 'versions':
    console.log(debVersion(args[0] ?? ''), rpmVersion(args[0] ?? ''));
    break;
  case 'assets':
    problems = checkAssets(args[0] ?? '', readdirSync(args[1] ?? ''));
    break;
  case 'scan': {
    const listing = lines(args[1] ?? '');
    problems = [
      ...credentialLike(listing).map(
        (entry) => `${args[0]} holds a credential-like file: ${entry}`,
      ),
      ...missingNotices(listing).map((name) => `${args[0]} lacks ${name} in its resources`),
    ];
    break;
  }
  case 'sums': {
    const folder = args[0] ?? '';
    const files = readdirSync(folder)
      .filter((name) => name !== 'SHA256SUMS')
      .map((name) => ({
        name,
        sha256: createHash('sha256')
          .update(readFileSync(path.join(folder, name)))
          .digest('hex'),
      }));
    writeFileSync(path.join(folder, 'SHA256SUMS'), sha256sums(files));
    break;
  }
  default:
    console.error(
      'Usage: release-decide.mjs preflight|repository|origin|prerelease|rename|versions|assets|scan|sums ...',
    );
    process.exit(2);
}
for (const problem of problems) console.error(problem);
process.exit(problems.length > 0 ? 1 : 0);
