import type { LinkAnswer, WindowId } from './core/host';
import { readWhole, writeWhole } from './memory';
import { EXTERNAL_URL_ALLOWLIST, linkTarget } from './url-policy';

/*
 * Links the user clicks in the app (a transcript's Markdown, a terminal's links) open in their
 * browser, once the core has said so: the renderer only names the URL (link.open). The core normalizes it
 * and opens it only if it is https, or http to this machine (url-policy.ts). A site on
 * EXTERNAL_URL_ALLOWLIST opens at once; any other asks first, in a native dialog ("Open
 * docs.example.com in your browser?", with "Always for this site"); a site the user said to
 * always open is remembered, by origin, in the app's user data:
 *
 *   { "version": 1, "sites": ["https://docs.example.com", …] }
 *
 * A file of another version, or one that isn't JSON, reads as no site and is set aside
 * (readWhole); one that can't be read fails the link that needed it, and is read again next time.
 */

export type { LinkAnswer } from './core/host';
export interface LinkOpenerDeps {
  /** Where the sites the user always opens are kept. */
  file: string;
  /** Asks the user whether to open `url`, on `host`, in their browser (a dialog on the window). */
  ask: (window: WindowId, host: string, url: string) => Promise<LinkAnswer>;
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
  readonly #asking = new Set<WindowId>();

  constructor({ allowlist = EXTERNAL_URL_ALLOWLIST, ...deps }: LinkOpenerDeps) {
    this.#deps = { ...deps, allowlist };
  }

  /**
   * Opens the link `raw` a renderer's user clicked, if it may, asking first unless its site is
   * allowlisted or always opened. Resolves with whether it opened. A link clicked while the
   * renderer's dialog is up is dropped.
   */
  async open(window: WindowId, raw: string): Promise<boolean> {
    const target = linkTarget(raw, this.#deps.allowlist);
    if (target === null) return false;
    if (!target.allowlisted && !(await this.#load()).has(target.origin)) {
      if (this.#asking.has(window)) return false;
      this.#asking.add(window);
      let answer: LinkAnswer;
      try {
        answer = await this.#deps.ask(window, target.host, target.url);
      } finally {
        this.#asking.delete(window);
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
    this.#sites ??= readWhole(this.#deps.file, VERSION).then(parse, (error: unknown) => {
      // Never read as no site, nor written over: read again next time.
      this.#sites = undefined;
      throw error;
    });
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
      .then(() => writeWhole(this.#deps.file, text))
      .catch((error: unknown) => {
        console.error('Could not remember the site:', error);
      });
    await this.#writing;
  }
}

/** The sites a file remembers: those that are a site a link may open, each its own origin. */
function parse(file: Record<string, unknown> | undefined): Set<string> {
  const sites = file?.sites;
  if (!Array.isArray(sites)) return new Set();
  return new Set(
    sites.filter(
      (site): site is string => typeof site === 'string' && linkTarget(site)?.origin === site,
    ),
  );
}
