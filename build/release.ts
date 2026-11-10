// The decisions scripts/release.sh makes, as pure functions under test (src/main/release.test.ts).
// scripts/release-decide.mjs runs them under Node as it is, so this file imports only Node's
// built-ins and its sibling with an explicit extension, and uses erasable TypeScript only.
import { rpmVersion } from './linux-version.ts';

export const REPOSITORY = 'jrbarkin/corrallm';

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-beta\.(0|[1-9]\d*))?$/;

/** `<major>.<minor>.<patch>`, or a beta of it: `<version>-beta.<n>`. */
export function isReleaseVersion(version: string): boolean {
  return VERSION.test(version);
}

export function isPrerelease(version: string): boolean {
  return version.includes('-beta.');
}

export interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
}

export interface PreflightFacts {
  version: string;
  /** The full hash of the commit to release. */
  commit: string;
  /** The `version` in package.json at that commit. */
  packageVersion: string;
  /** Whether the commit is on origin/main. */
  onMain: boolean;
  /** Whether a release or a tag named `v<version>` exists. */
  tagExists: boolean;
  /** The commit's check runs, as the API lists them. */
  checkRuns: CheckRun[];
  /** The advisories `pnpm audit` reports in the clone; left out until the clone exists. */
  auditAdvisories?: number;
  dockerRuns: boolean;
  dryRun: boolean;
  env: Readonly<Record<string, string | undefined>>;
}

/**
 * The CI jobs that block a merge (.github/workflows/ci.yml): each must have concluded `success`
 * for the commit. Windows runs on main only and is held; it never counts.
 */
export const BLOCKING_CHECKS: readonly string[] = [
  'macos-latest',
  'ubuntu-24.04',
  'ubuntu-24.04-arm',
  'e2e macos-latest (1/2)',
  'e2e macos-latest (2/2)',
  'e2e ubuntu-24.04 (1/2)',
  'e2e ubuntu-24.04 (2/2)',
];

const set = (value: string | undefined): boolean => value !== undefined && value !== '';

/** Whether the environment holds a signing identity naming its team, and a notarization login. */
function signingProblems(env: PreflightFacts['env']): string[] {
  const problems: string[] = [];
  if (!set(env.APPLE_SIGNING_IDENTITY)) {
    problems.push('APPLE_SIGNING_IDENTITY is not set: a release is never unsigned.');
  } else if (!/\([A-Z0-9]{10}\)$/.test(env.APPLE_SIGNING_IDENTITY ?? '')) {
    problems.push(
      'APPLE_SIGNING_IDENTITY names no team in parentheses: the release check needs it.',
    );
  }
  const apiKey = set(env.APPLE_API_KEY) && set(env.APPLE_API_KEY_ID);
  const appleId =
    set(env.APPLE_ID) && set(env.APPLE_APP_SPECIFIC_PASSWORD) && set(env.APPLE_TEAM_ID);
  if (!apiKey && !appleId) {
    problems.push(
      'No notarization credentials: set APPLE_API_KEY and APPLE_API_KEY_ID (and APPLE_API_ISSUER for ' +
        'a team key), or APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID.',
    );
  }
  return problems;
}

/**
 * Every reason a release must not start; none means it may. Facts left out are not checked.
 * Messages name variables, never their values. A dry run allows a commit off main and an unsigned
 * build, and checks nothing that needs GitHub.
 */
export function preflight(facts: PreflightFacts): string[] {
  const problems: string[] = [];
  const { version, dryRun, env } = facts;
  if (!isReleaseVersion(version)) {
    problems.push(`The version “${version}” is not <major>.<minor>.<patch> or <version>-beta.<n>.`);
  }
  if (!/^[0-9a-f]{40}$/.test(facts.commit)) {
    problems.push('The commit is not a full 40-character hash.');
  }
  if (facts.packageVersion !== version) {
    problems.push(
      `package.json says ${facts.packageVersion} at that commit, not ${version}: change it in a commit on main first.`,
    );
  }
  if (!dryRun) {
    if (!facts.onMain) problems.push('The commit is not on origin/main.');
    if (facts.tagExists) problems.push(`A release or tag named v${version} already exists.`);
    for (const name of BLOCKING_CHECKS) {
      const run = facts.checkRuns.find((candidate) => candidate.name === name);
      if (!run) problems.push(`CI has no “${name}” job for this commit.`);
      else if (run.status !== 'completed' || run.conclusion !== 'success') {
        problems.push(
          `CI job “${name}” is ${run.status === 'completed' ? (run.conclusion ?? 'unfinished') : run.status}, not success.`,
        );
      }
    }
    for (const run of facts.checkRuns) {
      if (/windows/i.test(run.name) || BLOCKING_CHECKS.includes(run.name)) continue;
      if (['failure', 'cancelled', 'timed_out', 'action_required'].includes(run.conclusion ?? '')) {
        problems.push(`CI job “${run.name}” is ${run.conclusion ?? ''}.`);
      }
    }
    problems.push(...signingProblems(env));
  }
  if (facts.auditAdvisories !== undefined && facts.auditAdvisories > 0) {
    problems.push(
      `pnpm audit reports ${String(facts.auditAdvisories)} advisories: fix them first, never exclude one.`,
    );
  }
  if (env.CORRALLM_DISTRIBUTION !== undefined && env.CORRALLM_DISTRIBUTION !== 'local') {
    problems.push('CORRALLM_DISTRIBUTION must be unset or local for a release.');
  }
  for (const name of ['CORRALLM_UNSIGNED', 'CORRALLM_E2E_BUILD']) {
    if (env[name] !== undefined) problems.push(`${name} must not be set for a release.`);
  }
  if (!facts.dockerRuns)
    problems.push('Docker is not running: the Linux packages are checked in it.');
  return problems;
}

/** The version the deb carries: the installer's own conversion, which puts a `~` before a beta. */
export function debVersion(version: string): string {
  return version.replace(/(\d)[_.+-]?((RC|rc|pre|dev|beta|alpha)[_.+-]?\d*)$/, '$1~$2');
}

/** Exactly the files a release has, sorted: macOS for Apple silicon, Linux for both, the sums. */
export function assetNames(version: string): string[] {
  const deb = debVersion(version);
  const rpm = rpmVersion(version);
  return [
    `corrallm-darwin-arm64-${version}.zip`,
    `corrallm-${version}-arm64.dmg`,
    `corrallm_${deb}_amd64.deb`,
    `corrallm_${deb}_arm64.deb`,
    `corrallm-${rpm}-1.x86_64.rpm`,
    `corrallm-${rpm}-1.arm64.rpm`,
    'SHA256SUMS',
  ].sort();
}

/**
 * What update.electronjs.org needs of the macOS zip's name: a `.zip` naming `-darwin` (or `-mac`
 * or `-osx`) and an architecture (`-arm64`, `-x64` or `-universal`; none is served to Intel).
 */
export function zipNameProblems(name: string): string[] {
  const problems: string[] = [];
  if (!name.endsWith('.zip')) problems.push(`${name} is not a .zip.`);
  if (!/-(darwin|mac|osx)/.test(name)) problems.push(`${name} does not name -darwin.`);
  if (!/-(arm64|x64|universal)/.test(name)) problems.push(`${name} does not name -arm64.`);
  return problems;
}

/** What is wrong with the files a release is about to attach: missing, extra or misnamed. */
export function checkAssets(version: string, names: readonly string[]): string[] {
  const wanted = assetNames(version);
  const problems: string[] = [];
  for (const name of wanted) if (!names.includes(name)) problems.push(`Missing asset: ${name}`);
  for (const name of names) {
    if (wanted.includes(name)) continue;
    problems.push(
      /win32|\.exe$|\.nupkg$|squirrel/i.test(name)
        ? `Unexpected Windows asset (Windows is held): ${name}`
        : `Unexpected asset: ${name}`,
    );
  }
  const zip = wanted.find((name) => name.endsWith('.zip'));
  if (zip) problems.push(...zipNameProblems(zip));
  return problems;
}

const CREDENTIAL_NAME = /(^|\/)(\.env(\.(?!example$|sample$)[^/]*)?|[^/]+\.(p8|p12|pfx|pem|key))$/;

/** The entries of an asset's file listing that are named like a credential. */
export function credentialLike(listing: readonly string[]): string[] {
  return listing.filter((entry) => CREDENTIAL_NAME.test(entry));
}

/** The notice files every asset holds in its resources, as the packaged app lays them out. */
export const REQUIRED_NOTICES: readonly string[] = [
  'NOTICE',
  'LICENSE',
  'THIRD-PARTY-NOTICES.txt',
  'claude-agent-sdk-LICENSE.md',
];

/** The required notices an asset's listing lacks (Electron's own LICENSE beside the app is not ours). */
export function missingNotices(listing: readonly string[]): string[] {
  return REQUIRED_NOTICES.filter(
    (name) =>
      !listing.some(
        (entry) => entry.endsWith(`/resources/${name}`) || entry.endsWith(`/Resources/${name}`),
      ),
  );
}

/** `sha256sum -c` input: the hash, two spaces, the name; sorted by name. */
export function sha256sums(files: readonly { name: string; sha256: string }[]): string {
  return [...files]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map(({ name, sha256 }) => `${sha256}  ${name}\n`)
    .join('');
}
