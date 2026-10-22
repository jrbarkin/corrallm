import { gt, parse } from 'semver';

// Matches update-electron-app's public-service feed. Neither host nor repository is configurable.
const SERVICE = 'https://update.electronjs.org/jrbarkin/corrallm';
const LATEST = 'https://api.github.com/repos/jrbarkin/corrallm/releases/latest';
const RELEASES = 'https://github.com/jrbarkin/corrallm/releases/tag/';
export const CHECK_EVERY_MS = 6 * 60 * 60_000;
export const LINUX_CHECK_EVERY_MS = 24 * 60 * 60_000;
export const FETCH_TIMEOUT_MS = 10_000;

export interface UpdateEvents {
  error(error: unknown): void;
  settled(): void;
  downloaded(version: string): void;
}

export interface UpdateBackend {
  listen(events: UpdateEvents): () => void;
  setFeedURL(options: { url: string }): void;
  checkForUpdates(): void;
  quitAndInstall(): void;
}

export interface UpdateDialog {
  message: string;
  detail: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
}

interface Deps {
  packaged: boolean;
  development: boolean;
  selfTest: boolean;
  disabled: boolean;
  unsigned: boolean;
  platform: string;
  arch: string;
  version: string;
  signedMac(): Promise<boolean>;
  updater: UpdateBackend;
  fetch: typeof fetch;
  prompt(options: UpdateDialog): Promise<number>;
  /** Requests main's existing quit path; must join an existing save rather than force a second quit. */
  requestQuit(): void;
  /** Goes through the core's link.open, never directly to the OS. */
  openRelease(url: string): Promise<void>;
  log(message: string): void;
  clock?: { later(run: () => void, ms: number): () => void };
}

/** Main-only policy, with no Electron dependency or side effects until start(). */
export class AppUpdates {
  readonly #deps: Deps;
  readonly #clock: NonNullable<Deps['clock']>;
  readonly #said = new Set<string>();
  readonly #offered = new Set<string>();
  #started = false;
  #stopped = false;
  #checking = false;
  #downloaded = false;
  #restart = false;
  #installing = false;
  #cancelTimer: (() => void) | undefined;
  #unlisten: (() => void) | undefined;
  #cancelRead: (() => void) | undefined;
  #dialogs = Promise.resolve();

  constructor(deps: Deps) {
    this.#deps = deps;
    this.#clock = deps.clock ?? {
      later: (run, ms) => {
        const timer = setTimeout(run, ms);
        timer.unref();
        return () => {
          clearTimeout(timer);
        };
      },
    };
  }

  async start(): Promise<void> {
    if (this.#started || this.#stopped) return;
    this.#started = true;
    const deps = this.#deps;
    if (!deps.packaged || deps.development || deps.selfTest || deps.disabled) return;
    try {
      if (deps.platform === 'darwin' && (deps.unsigned || !(await deps.signedMac()))) {
        this.#log('Unsigned macOS build; skipping update checks.');
        return;
      }
      if (!this.#active()) return;
      if (deps.platform === 'darwin' || deps.platform === 'win32') {
        this.#unlisten = deps.updater.listen({
          error: (error) => {
            this.#checking = false;
            this.#error(error);
          },
          settled: () => {
            this.#checking = false;
          },
          downloaded: (version) => {
            this.#onDownload(version);
          },
        });
        deps.updater.setFeedURL({
          url: `${SERVICE}/${deps.platform}-${deps.arch}/${deps.version}`,
        });
      } else if (deps.platform !== 'linux') return;
      this.#schedule();
      await this.#check();
    } catch (error) {
      this.#error(error);
    }
  }

  /** Only main's approved quit calls this, after renderer acknowledgement, core flush and close. */
  finishQuit(): boolean {
    if (this.#installing) return true;
    if (!this.#restart || !this.#downloaded) return false;
    this.#restart = false;
    try {
      this.#deps.updater.quitAndInstall();
      this.#installing = true;
      return true;
    } catch (error) {
      this.#error(error);
      return false;
    }
  }

  /** Keep corrallm open also cancels the restart intent; a later normal quit stays normal. */
  cancelRestart(): void {
    this.#restart = false;
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#cancelTimer?.();
    this.#unlisten?.();
    this.#cancelRead?.();
  }

  #schedule(): void {
    if (this.#stopped || this.#downloaded) return;
    this.#cancelTimer = this.#clock.later(
      () => {
        this.#schedule();
        void this.#check();
      },
      this.#deps.platform === 'linux' ? LINUX_CHECK_EVERY_MS : CHECK_EVERY_MS,
    );
  }

  async #check(): Promise<void> {
    if (this.#stopped || this.#checking || this.#downloaded) return;
    this.#checking = true;
    try {
      if (this.#deps.platform !== 'linux') {
        // The native updater settles on error, update-not-available or update-downloaded.
        this.#deps.updater.checkForUpdates();
        return;
      }
      const release = await this.#latest();
      if (!release || !this.#active() || this.#offered.has(release.version)) return;
      this.#offered.add(release.version);
      await this.#dialog(async () => {
        const answer = await this.#deps.prompt({
          message: `corrallm ${release.version} is available`,
          detail: 'Install the newer package to update corrallm.',
          buttons: ['Open release page', 'Later'],
          defaultId: 1,
          cancelId: 1,
        });
        if (answer === 0 && !this.#stopped) await this.#deps.openRelease(release.url);
      });
    } catch (error) {
      this.#checking = false;
      this.#error(error);
    } finally {
      if (this.#deps.platform === 'linux') this.#checking = false;
    }
  }

  #onDownload(raw: string): void {
    if (this.#stopped) return;
    this.#downloaded = true;
    this.#checking = false;
    this.#cancelTimer?.();
    // releaseName is the native updater's version identity, not executable text or a URL.
    const version = parse(raw)?.version;
    // GitHub release names can be titles, not just version tags. Squirrel already selected a
    // newer release; retain its identity, but don't display arbitrary release text in the dialog.
    const identity = version ?? raw;
    if (this.#offered.has(identity)) return;
    this.#offered.add(identity);
    void this.#dialog(async () => {
      const answer = await this.#deps.prompt({
        message: version
          ? `corrallm ${version} is ready to install`
          : 'A corrallm update is ready to install',
        detail: 'Restart saves your runs and closes the agents’ sessions before updating.',
        buttons: ['Restart to update', 'Later'],
        defaultId: 1,
        cancelId: 1,
      });
      if (answer !== 0 || this.#stopped) return;
      this.#restart = true;
      this.#deps.requestQuit();
    });
  }

  #dialog(show: () => Promise<void>): Promise<void> {
    this.#dialogs = this.#dialogs
      .then(async () => {
        if (!this.#stopped) await show();
      })
      .catch((error: unknown) => {
        this.#error(error);
      });
    return this.#dialogs;
  }

  async #latest(): Promise<{ version: string; url: string } | undefined> {
    const controller = new AbortController();
    let cancelTimeout: (() => void) | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      this.#cancelRead = () => {
        controller.abort();
        reject(new Error('The release check stopped.'));
      };
      cancelTimeout = this.#clock.later(() => {
        controller.abort();
        reject(new Error('The release check timed out.'));
      }, FETCH_TIMEOUT_MS);
    });
    try {
      const data = await Promise.race([
        deadline,
        (async (): Promise<unknown> => {
          const response = await this.#deps.fetch(LATEST, {
            signal: controller.signal,
            credentials: 'omit',
            redirect: 'error',
            headers: {
              Accept: 'application/vnd.github+json',
              'User-Agent': `corrallm/${this.#deps.version} (linux-${this.#deps.arch})`,
              'X-GitHub-Api-Version': '2022-11-28',
            },
          });
          // A private repository or one without a release simply has nothing to offer.
          if (response.status === 404 || response.status === 204) return undefined;
          if (!response.ok)
            throw new Error(`The release check returned HTTP ${String(response.status)}.`);
          return response.json();
        })(),
      ]);
      if (!data || typeof data !== 'object') return undefined;
      const release = data as Record<string, unknown>;
      if (
        release.prerelease !== false ||
        release.draft !== false ||
        typeof release.tag_name !== 'string'
      )
        return undefined;
      const version = parse(release.tag_name);
      if (!version || version.prerelease.length > 0 || !gt(version, this.#deps.version))
        return undefined;
      return {
        version: version.version,
        url: `${RELEASES}${encodeURIComponent(release.tag_name)}`,
      };
    } finally {
      cancelTimeout?.();
      this.#cancelRead = undefined;
    }
  }

  #error(error: unknown): void {
    if (!this.#stopped)
      this.#log(
        `Update check: ${JSON.stringify((error instanceof Error ? error.message : String(error)).slice(0, 500))}`,
      );
  }

  #log(message: string): void {
    if (this.#said.has(message)) return;
    this.#said.add(message);
    this.#deps.log(message);
  }

  /** Re-read lifecycle state after an await: stop() may have run meanwhile. */
  #active(): boolean {
    return !this.#stopped;
  }
}
