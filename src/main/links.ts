import { readFile, rename, rm, writeFile } from 'node:fs/promises';

import type { WebContents } from 'electron';

import { EXTERNAL_URL_ALLOWLIST, linkTarget } from './url-policy';

/*
 * Links the user clicks in the app (a transcript's Markdown, a terminal's links) open in their
 * browser, once main has said so: the renderer only names the URL (link:open). Main normalizes it
 * and opens it only if it is https, or http to this machine (url-policy.ts). A site on
 * EXTERNAL_URL_ALLOWLIST opens at once; any other asks first, in a native dialog ("Open
 * docs.example.com in your browser?", with "Always for this site"); a site the user said to
 * always open is remembered, by origin, in the app's user data:
 *
 *   { "version": 1, "sites": ["https://docs.example.com", …] }
 */

/** What the user answered: whether to open the link, and to open its site's links from now on. */
export interface LinkAnswer {
  open: boolean;
  always: boolean;
}

export interface LinkOpenerDeps {
  /** Where the sites the user always opens are kept. */
  file: string;
  /** Asks the user whether to open `url`, on `host`, in their browser (a dialog on the window). */
  ask: (contents: WebContents, host: string, url: string) => Promise<LinkAnswer>;
  /** Opens a URL in the user's default browser. */
  openExternal: (url: string) => Promise<void>;
  allowlist?: ReadonlySet<string>;
}

const VERSION = 1;
/** How many sites it remembers: the ones allowed most recently. */
const LIMIT = 500;

export class LinkOpener {
  readonly #deps: Required<LinkOpenerDeps>;
  #sites: Promise<Set<string>> | undefined;
  #writing: Promise<void> = Promise.resolve();
  /** Renderers asked something right now: one question at a time each. */
  readonly #asking = new WeakSet<WebContents>();

  constructor({ allowlist = EXTERNAL_URL_ALLOWLIST, ...deps }: LinkOpenerDeps) {
    this.#deps = { ...deps, allowlist };
  }

  /**
   * Opens the link `raw` a renderer's user clicked, if it may, asking first unless its site is
   * allowlisted or always opened. Resolves with whether it opened. A link clicked while the
   * renderer's dialog is up is dropped.
   */
  async open(contents: WebContents, raw: string): Promise<boolean> {
    const target = linkTarget(raw, this.#deps.allowlist);
    if (target === null) return false;
    if (!target.allowlisted && !(await this.#load()).has(target.origin)) {
      if (this.#asking.has(contents)) return false;
      this.#asking.add(contents);
      let answer: LinkAnswer;
      try {
        answer = await this.#deps.ask(contents, target.host, target.url);
      } finally {
        this.#asking.delete(contents);
      }
      if (!answer.open) return false;
      if (answer.always) await this.#allow(target.origin);
    }
    await this.#deps.openExternal(target.url);
    return true;
  }

  /** Resolves once the sites allowed so far are written: before the app quits. */
  flush(): Promise<void> {
    return this.#writing;
  }

  #load(): Promise<Set<string>> {
    this.#sites ??= readFile(this.#deps.file, 'utf8').then(parse, () => new Set<string>());
    return this.#sites;
  }

  async #allow(origin: string): Promise<void> {
    const sites = await this.#load();
    sites.delete(origin);
    sites.add(origin);
    for (const oldest of sites) {
      if (sites.size <= LIMIT) break;
      sites.delete(oldest);
    }
    const text = `${JSON.stringify({ version: VERSION, sites: [...sites] }, null, 2)}\n`;
    // A failed write is logged: the site is still allowed until the app quits.
    this.#writing = this.#writing
      .then(() => write(this.#deps.file, text))
      .catch((error: unknown) => {
        console.error('Could not remember the site:', error);
      });
    await this.#writing;
  }
}

/** Writes the file whole: beside it, then moved over it. */
async function write(file: string, text: string): Promise<void> {
  const partial = `${file}.${String(process.pid)}.partial`;
  try {
    await writeFile(partial, text, 'utf8');
    await rename(partial, file);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}

/** The sites a file remembers: those that are a site a link may open, each its own origin. */
function parse(text: string): Set<string> {
  let file: unknown;
  try {
    file = JSON.parse(text);
  } catch {
    return new Set();
  }
  if (typeof file !== 'object' || file === null || !('sites' in file) || !('version' in file)) {
    return new Set();
  }
  const { version, sites } = file;
  if (version !== VERSION || !Array.isArray(sites)) return new Set();
  return new Set(
    sites.filter(
      (site): site is string => typeof site === 'string' && linkTarget(site)?.origin === site,
    ),
  );
}
