import { MAX_REMEMBERED_SITES } from '../shared/api/limits';
import type { LinkAnswer, WindowId } from './core/host';
import { SettingsFailure } from './settings';
import { readWhole, unknownFields, writeWhole } from './whole-file';
import { canonicalOrigin, EXTERNAL_URL_ALLOWLIST, linkTarget } from './url-policy';

/*
 * Links the user clicks in the app (a transcript's Markdown, a terminal's links) open in their
 * browser, once the core has said so: the renderer only names the URL (link.open). The core normalizes it
 * and opens it only if it is https, or http to this machine (url-policy.ts). A site on
 * EXTERNAL_URL_ALLOWLIST opens at once; any other asks first, in a native dialog ("Open
 * docs.example.com in your browser?", with "Always for this site"); a site the user said to
 * always open is remembered, by origin, in the app's user data (at most the newest
 * MAX_REMEMBERED_SITES), until you take it back in Settings (`forget`, B22a C5):
 *
 *   { "version": 1, "sites": ["https://docs.example.com", …] }
 *
 * What it holds that this corrallm doesn't know (a newer one's fields) is written back as it was.
 * A file of another version, or one that isn't JSON, reads as no site and is set aside
 * (readWhole); one that can't be read fails the link that needed it, and is read again next time.
 *
 * What it remembers is replaced whole at each change, never changed in place, in one lane: a site
 * remembered (kept for this run even if its save fails, as it always was) and a site taken back
 * (strictly: written first). Taking a site back moves the generation of any dialog up for it, so
 * an Always answered in a dialog asked before is not remembered: that click still opens once, and
 * the next asks again.
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
  /** Writes its file whole (whole-file.ts' writeWhole; a test may hold it). */
  write?: (file: string, text: string) => Promise<void>;
}

const VERSION = 1;

/** The dialogs up for a site now, and the generation they asked at (B22a C5). */
interface Pending {
  generation: number;
  count: number;
}

export class LinkOpener {
  readonly #deps: Required<LinkOpenerDeps>;
  #sites: Promise<ReadonlySet<string>> | undefined;
  /** What its file holds that this corrallm doesn't know. */
  #unknown: Record<string, unknown> = {};
  #writing: Promise<void> = Promise.resolve();
  /** Renderers asked something right now: one question at a time each. */
  readonly #asking = new Set<WindowId>();
  /** The sites a dialog is up for, by origin: none past their dialogs and their saves. */
  readonly #pending = new Map<string, Pending>();
  readonly #listeners = new Set<() => void>();

  constructor({ allowlist = EXTERNAL_URL_ALLOWLIST, write = writeWhole, ...deps }: LinkOpenerDeps) {
    this.#deps = { ...deps, allowlist, write };
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
      const pending = this.#pend(target.origin);
      const asked = pending.generation;
      try {
        let answer: LinkAnswer;
        try {
          answer = await this.#deps.ask(window, target.host, target.url);
        } finally {
          this.#asking.delete(window);
        }
        if (!answer.open) return false;
        if (answer.always) await this.#allow(target.origin, pending, asked);
      } finally {
        pending.count -= 1;
        if (pending.count === 0 && this.#pending.get(target.origin) === pending)
          this.#pending.delete(target.origin);
      }
    }
    await this.#deps.openExternal(target.url);
    return true;
  }

  /**
   * The sites it opens without asking because you said so, as origins, oldest first (B22a C2).
   * Rejects when its file can't be read: never read as none.
   */
  async sites(): Promise<string[]> {
    return [...(await this.#load())];
  }

  /** The sites the product opens without asking, as origins: https on the default port alone. */
  builtIn(): string[] {
    return [...this.#deps.allowlist].map((host) => `https://${host}`);
  }

  /** Hears each change of the sites it remembers: an Always, and a site taken back. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Takes back the site `origin` (exactly as `sites` lists it: `canonicalOrigin`), strictly (B22a
   * C5, C6): from the latest sites, written without it first, then held and told; and any dialog
   * up for it, asked before, remembers nothing. True if it changed anything; false, writing
   * nothing, for one neither remembered nor asked about. Rejects with a SettingsFailure saying
   * which, nothing changed, when its file can't be read or written. It never opens anything.
   */
  forget(origin: string): Promise<boolean> {
    const run = async (): Promise<boolean> => {
      let sites: ReadonlySet<string>;
      try {
        sites = await this.#load();
      } catch (error) {
        throw new SettingsFailure('read', error);
      }
      const kept = sites.has(origin);
      const pending = this.#pending.get(origin);
      if (!kept && pending === undefined) return false;
      if (kept) {
        const next = new Set([...sites].filter((site) => site !== origin));
        try {
          await this.#deps.write(this.#deps.file, this.#text(next));
        } catch (error) {
          throw new SettingsFailure('write', error);
        }
        this.#sites = Promise.resolve(next);
      }
      if (pending !== undefined) pending.generation += 1;
      if (kept) this.#tell();
      return true;
    };
    const result = this.#writing.then(run);
    this.#writing = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Resolves once the sites allowed so far are written: before the app quits. */
  flush(): Promise<void> {
    return this.#writing;
  }

  #load(): Promise<ReadonlySet<string>> {
    this.#sites ??= readWhole(this.#deps.file, VERSION).then(
      (file) => {
        this.#unknown = unknownFields(file, ['version', 'sites']);
        return parse(file);
      },
      (error: unknown) => {
        // Never read as no site, nor written over: read again next time.
        this.#sites = undefined;
        throw error;
      },
    );
    return this.#sites;
  }

  /** The dialogs up for `origin`, one more of them. */
  #pend(origin: string): Pending {
    let pending = this.#pending.get(origin);
    if (pending === undefined) {
      pending = { generation: 0, count: 0 };
      this.#pending.set(origin, pending);
    }
    pending.count += 1;
    return pending;
  }

  /**
   * Remembers `origin`, unless it was taken back since its dialog asked (`asked`: its dialogs'
   * generation then): held for this run even if its save fails, which is logged.
   */
  async #allow(origin: string, pending: Pending, asked: number): Promise<void> {
    const run = async () => {
      if (pending.generation !== asked) return;
      const next = new Set(await this.#load());
      next.delete(origin);
      next.add(origin);
      for (const oldest of next) {
        if (next.size <= MAX_REMEMBERED_SITES) break;
        next.delete(oldest);
      }
      this.#sites = Promise.resolve(next);
      this.#tell();
      await this.#deps.write(this.#deps.file, this.#text(next));
    };
    // A failed write is logged: the site is still allowed until the app quits.
    this.#writing = this.#writing.then(run).catch((error: unknown) => {
      console.error('Could not remember the site:', error);
    });
    await this.#writing;
  }

  /** The file's text for `sites`, with what this corrallm doesn't know written back as it was. */
  #text(sites: ReadonlySet<string>): string {
    return `${JSON.stringify({ version: VERSION, ...this.#unknown, sites: [...sites] }, null, 2)}\n`;
  }

  #tell(): void {
    for (const listener of this.#listeners) listener();
  }
}

/**
 * The sites a file remembers: those that are a site a link may open, each exactly its own origin,
 * the newest MAX_REMEMBERED_SITES of them.
 */
function parse(file: Record<string, unknown> | undefined): Set<string> {
  const sites = file?.sites;
  if (!Array.isArray(sites)) return new Set();
  const kept = [
    ...new Set(
      sites.filter(
        (site): site is string => typeof site === 'string' && canonicalOrigin(site) === site,
      ),
    ),
  ];
  return new Set(kept.slice(-MAX_REMEMBERED_SITES));
}
