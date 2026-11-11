import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import type { Plugin } from 'vite';

/**
 * Third-party notices (THIRD-PARTY-NOTICES.txt). Every Vite bundle records which packages' modules
 * end up in it (`noticesPlugin`); forge.config.mts joins the records into one file shipped beside
 * NOTICE (`joinNotices`). A bundled package with no license file, or a license off the allowlist,
 * fails the build.
 */

/**
 * The bundles that make up the app and its command. Main and core are told apart by their entry
 * chunk's name (one config makes both); the others by the name their config gives the plugin.
 */
export const BUNDLES = ['main', 'core', 'preload', 'renderer', 'corrallm'] as const;

/** Extended only as the build finds a license, and only deliberately. */
export const ALLOWED_LICENSES: ReadonlySet<string> = new Set([
  'MIT',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
  '0BSD',
  'BlueOak-1.0.0',
  'CC0-1.0',
  'Unlicense',
]);

/** The one package under its own terms: its license is shipped as its own file (see NOTICE). */
const NAMED_EXCEPTIONS: Readonly<Record<string, string>> = {
  '@anthropic-ai/claude-agent-sdk':
    'Not covered by corrallm’s license. Its own LICENSE.md is shipped as claude-agent-sdk-LICENSE.md, beside NOTICE.',
};

/** Where the records live between the Vite builds and the join (not shipped). */
export const NOTICES_CACHE = path.join(
  import.meta.dirname,
  '../node_modules/.cache/corrallm-notices',
);

/** The package a module belongs to: its name and folder, by the last `node_modules/` in its id. */
export function packageOfModule(id: string): { name: string; dir: string } | undefined {
  if (id.startsWith('\0')) return undefined;
  const file = id.split('?')[0] ?? id;
  const marker = `${path.sep === '\\' ? '\\' : '/'}node_modules${path.sep === '\\' ? '\\' : '/'}`;
  const at = file.lastIndexOf(marker);
  if (at < 0) return undefined;
  const parts = file.slice(at + marker.length).split(/[\\/]/);
  const name = parts[0]?.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  if (!name || name.startsWith('.')) return undefined;
  const dir = file.slice(0, at + marker.length) + name.split('/').join(path.sep);
  return { name, dir };
}

interface OutputChunk {
  type: 'chunk';
  name?: string;
  isEntry?: boolean;
  modules: Record<string, { renderedLength: number }>;
}
type Bundle = Record<string, OutputChunk | { type: 'asset' }>;

/** The folders of the packages with a module that is actually part of the output. */
export function bundledPackages(bundle: Bundle): string[] {
  const dirs = new Set<string>();
  for (const output of Object.values(bundle)) {
    if (output.type !== 'chunk') continue;
    for (const [id, module] of Object.entries(output.modules)) {
      if (module.renderedLength === 0) continue;
      const found = packageOfModule(id);
      if (found) dirs.add(found.dir);
    }
  }
  return [...dirs].sort();
}

/** Writes this build's package list under its name, or else its entry chunk's. */
export function recordBundle(folder: string, bundle: Bundle, name?: string): void {
  const entry = Object.values(bundle).find(
    (output): output is OutputChunk => output.type === 'chunk' && output.isEntry === true,
  );
  const named = name ?? entry?.name;
  if (!named) return;
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, `${named}.json`), JSON.stringify(bundledPackages(bundle)));
}

/** A Vite plugin for each bundle's config: records the packages the production output holds. */
export function noticesPlugin(name?: string, folder = NOTICES_CACHE): Plugin {
  return {
    name: 'corrallm:notices',
    apply: 'build',
    generateBundle(_options, bundle) {
      recordBundle(folder, bundle, name);
    },
  };
}

interface Manifest {
  name?: string;
  version?: string;
  license?: string | { type?: string };
  licenses?: { type?: string }[];
  repository?: string | { url?: string };
}

function licenseOf(manifest: Manifest): string | undefined {
  if (typeof manifest.license === 'string') return manifest.license;
  if (manifest.license?.type) return manifest.license.type;
  const types = (manifest.licenses ?? []).flatMap((entry) => (entry.type ? [entry.type] : []));
  return types.length > 0 ? types.join(' OR ') : undefined;
}

/**
 * Whether an SPDX expression is covered by the allowlist: OR needs one side, AND needs both, AND
 * binds tighter than OR, and parentheses group. An expression that does not parse is refused.
 */
function allowed(expression: string): boolean {
  const tokens = expression.match(/\(|\)|[^\s()]+/g) ?? [];
  let at = 0;
  const peek = (): string | undefined => tokens[at];
  const isWord = (token: string | undefined, word: string): boolean =>
    token?.toUpperCase() === word;
  function or(): boolean {
    let result = and();
    while (isWord(peek(), 'OR')) {
      at += 1;
      const right = and();
      result = result || right;
    }
    return result;
  }
  function and(): boolean {
    let result = primary();
    while (isWord(peek(), 'AND')) {
      at += 1;
      const right = primary();
      result = result && right;
    }
    return result;
  }
  function primary(): boolean {
    const token = peek();
    at += 1;
    if (token === '(') {
      const inner = or();
      if (peek() !== ')') throw new SyntaxError('unbalanced');
      at += 1;
      return inner;
    }
    if (token === undefined || token === ')' || isWord(token, 'AND') || isWord(token, 'OR')) {
      throw new SyntaxError('unexpected token');
    }
    return ALLOWED_LICENSES.has(token);
  }
  try {
    const result = or();
    return at === tokens.length && result;
  } catch {
    return false;
  }
}

async function textsOf(dir: string, kind: RegExp): Promise<string[]> {
  const names = (await readdir(dir)).filter((name) => kind.test(name)).sort();
  return Promise.all(names.map((name) => readFile(path.join(dir, name), 'utf8')));
}

const LICENSE_FILE = /^(licen[sc]e|copying)([-.][a-z0-9]+)*$/i;
const NOTICE_FILE = /^notice(\.[a-z]+)?$/i;

/**
 * Packages built from another package's repository that publish no license file of their own.
 * Their scope sibling carries the repository's, and is used only when both manifests name the same
 * repository and the same license (xterm.js's addons, beside @xterm/xterm).
 */
const REPOSITORY_LICENSE_HOLDERS: Readonly<Record<string, { holder: string; repository: string }>> =
  {
    '@xterm/': { holder: '@xterm/xterm', repository: 'https://github.com/xtermjs/xterm.js' },
  };

function repositoryOf(manifest: Manifest): string {
  const repository = manifest.repository;
  const url = typeof repository === 'string' ? repository : (repository?.url ?? '');
  return url.replace(/^[a-z]+\+/, '').replace(/\.git$/, '');
}

/** The license text a package without a file of its own may use, or none. */
async function repositoryLicense(
  dir: string,
  name: string,
  manifest: Manifest,
): Promise<string[] | undefined> {
  const entry = Object.entries(REPOSITORY_LICENSE_HOLDERS).find(([prefix]) =>
    name.startsWith(prefix),
  );
  if (!entry || !repositoryOf(manifest).startsWith(entry[1].repository)) return undefined;
  const holderDir = path.join(path.dirname(dir), entry[1].holder.split('/')[1] ?? '');
  if (!existsSync(path.join(holderDir, 'package.json'))) return undefined;
  const holder = JSON.parse(
    await readFile(path.join(holderDir, 'package.json'), 'utf8'),
  ) as Manifest;
  if (
    licenseOf(holder) !== licenseOf(manifest) ||
    !repositoryOf(holder).startsWith(entry[1].repository)
  )
    return undefined;
  const texts = await textsOf(holderDir, LICENSE_FILE);
  return texts.length === 0
    ? undefined
    : texts.map(
        (text) =>
          `(The license of the ${entry[1].holder} repository, which this package is built from.)\n\n${text}`,
      );
}

/**
 * The notices text for the recorded bundles. Refuses a missing record, a bundled package with no
 * license file, and a license off the allowlist (the Agent SDK is the one named exception); every
 * problem is reported together.
 */
export async function joinNotices(folder = NOTICES_CACHE): Promise<string> {
  const dirs = new Set<string>();
  for (const bundle of BUNDLES) {
    const record = path.join(folder, `${bundle}.json`);
    if (!existsSync(record)) {
      throw new Error(
        `No notices record for the “${bundle}” bundle (${record}): its build did not run noticesPlugin.`,
      );
    }
    for (const dir of JSON.parse(await readFile(record, 'utf8')) as string[]) dirs.add(dir);
  }
  const entries: { name: string; text: string }[] = [];
  const problems: string[] = [];
  for (const dir of dirs) {
    const manifest = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')) as Manifest;
    const name = packageOfModule(path.join(dir, 'x'))?.name ?? manifest.name ?? dir;
    const label = `${name} ${manifest.version ?? '(no version)'}`;
    const exception = NAMED_EXCEPTIONS[name];
    if (exception !== undefined) {
      entries.push({ name, text: `${label}\nLicense: ${exception}\n` });
      continue;
    }
    const license = licenseOf(manifest);
    if (license === undefined || !allowed(license)) {
      problems.push(
        `${label} is bundled under ${license === undefined ? 'no license field' : `the license “${license}”`}, ` +
          'which is not on the allowlist (build/notices.ts ALLOWED_LICENSES).',
      );
      continue;
    }
    const own = await textsOf(dir, LICENSE_FILE);
    const licenses = own.length > 0 ? own : await repositoryLicense(dir, name, manifest);
    if (licenses === undefined) {
      problems.push(`${label} is bundled but ships no license file (${dir}).`);
      continue;
    }
    const notices = await textsOf(dir, NOTICE_FILE);
    entries.push({
      name,
      text: `${label}\nLicense: ${license}\n\n${[...licenses, ...notices].map((text) => text.trim()).join('\n\n')}\n`,
    });
  }
  if (problems.length > 0) throw new Error(problems.join('\n'));
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const rule = '='.repeat(78);
  return (
    'corrallm bundles the packages below in its app and its command. Each is listed with its\n' +
    'license and that license’s text.\n\n' +
    entries.map(({ text }) => `${rule}\n${text}`).join('\n') +
    `${rule}\n`
  );
}
