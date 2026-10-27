import type { PauseAllResult, Presence } from '../core/presence';

/** One fixed native menu; no label comes from an agent, a canvas or an error. */
export type PresenceMenu = readonly {
  id: string;
  label: string;
  enabled: boolean;
  click?: () => void;
}[];

export interface PresenceTray {
  update(menu: PresenceMenu, title: string, needs: boolean): void;
  destroy(): void;
}

/** Electron's presentation only: it makes no run, permission or lifecycle decision. */
export interface PresenceBackend {
  dock(menu: PresenceMenu): void;
  dockBadge(label: string): void;
  launcherBadge(count: number): void;
  tray(open: () => void): PresenceTray;
  startAwake(): number;
  stopAwake(id: number): void;
}

export interface PresencePresentationDeps {
  platform: NodeJS.Platform;
  hidden: boolean;
  backend: PresenceBackend;
  windowShown(): boolean;
  quitting(): { saving: boolean; approved: boolean };
  actions: {
    open(): void;
    quit(): void;
    pauseAll(): Promise<PauseAllResult | { sentence: string }>;
  };
  log(message: string): void;
}

/** C1's Dock/tray and C6's single power blocker, driven only by the current core's presence. */
export class PresencePresentation {
  readonly #deps: PresencePresentationDeps;
  #presence: Presence | undefined;
  #tray: PresenceTray | undefined;
  #blocker: number | undefined;
  #awake = false;
  #pausing = false;
  #unsaved = false;
  #closed = false;

  constructor(deps: PresencePresentationDeps) {
    this.#deps = deps;
  }

  update(presence: Presence | undefined): void {
    if (this.#closed) return;
    this.#presence = presence;
    this.refresh();
  }

  /** Window visibility and the quit coordinator's state changed; no state is polled. */
  refresh(): void {
    if (this.#closed) return;
    const { backend, platform, hidden } = this.#deps;
    const presence = this.#presence;
    const menu = this.#menu();
    if (platform === 'darwin') {
      this.#try(() => {
        backend.dock(menu);
      });
      if (!hidden)
        this.#try(() => {
          backend.dockBadge(badge(presence?.needs ?? 0));
        });
    } else if (platform === 'linux') {
      this.#try(() => {
        backend.launcherBadge(presence?.needs ?? 0);
      });
    }
    const wantsTray =
      !hidden && (platform === 'linux' || (platform === 'darwin' && !this.#deps.windowShown()));
    if (wantsTray) {
      this.#try(() => {
        this.#tray ??= backend.tray(() => {
          this.#deps.actions.open();
        });
        this.#tray.update(
          menu,
          platform === 'darwin' && presence?.working ? String(presence.working) : '',
          (presence?.needs ?? 0) > 0,
        );
      });
    } else if (this.#tray !== undefined) {
      this.#try(() => this.#tray?.destroy());
      this.#tray = undefined;
    }
    const awake = presence?.awake === true;
    if (awake !== this.#awake) {
      this.#awake = awake;
      if (awake)
        this.#try(() => {
          this.#blocker = backend.startAwake();
        });
      else this.#stopAwake();
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#try(() => this.#tray?.destroy());
    this.#tray = undefined;
    this.#stopAwake();
    if (this.#deps.platform === 'darwin' && !this.#deps.hidden)
      this.#try(() => {
        this.#deps.backend.dockBadge('');
      });
    if (this.#deps.platform === 'linux')
      this.#try(() => {
        this.#deps.backend.launcherBadge(0);
      });
  }

  #canPause(): boolean {
    const { saving, approved } = this.#deps.quitting();
    return !this.#closed && !this.#pausing && this.#presence !== undefined && !saving && !approved;
  }

  #menu(): PresenceMenu {
    const status = (id: string, label: string) => ({ id, label, enabled: false });
    const presence = this.#presence;
    const rows: { id: string; label: string; enabled: boolean; click?: () => void }[] = [];
    if (presence === undefined) rows.push(status('status', 'Recovering'));
    else {
      rows.push(status('status', presence.busy ? 'corrallm is working' : 'Idle'));
      if (presence.working > 0)
        rows.push(
          status(
            'working',
            `${String(presence.working)} ${presence.working === 1 ? 'agent is' : 'agents are'} working`,
          ),
        );
      if (presence.runs > 0)
        rows.push(
          status(
            'runs',
            `${String(presence.runs)} ${presence.runs === 1 ? 'run is' : 'runs are'} going on`,
          ),
        );
      if (presence.jobs > 0)
        rows.push(
          status(
            'jobs',
            `${String(presence.jobs)} ${presence.jobs === 1 ? 'job is' : 'jobs are'} running`,
          ),
        );
      if (presence.needs > 0)
        rows.push(
          status(
            'needs',
            `${badge(presence.needs)} ${presence.needs === 1 ? 'thing needs' : 'things need'} you`,
          ),
        );
    }
    if (this.#unsaved) rows.push(status('unsaved', 'Some pauses may not survive a restart'));
    rows.push(
      {
        id: 'open',
        label: 'Open corrallm',
        enabled: true,
        click: () => {
          this.#deps.actions.open();
        },
      },
      {
        id: 'pause',
        label: 'Pause all',
        enabled: this.#canPause(),
        click: () => {
          void this.#pause();
        },
      },
      {
        id: 'quit',
        label: 'Quit corrallm',
        enabled: true,
        click: () => {
          this.#deps.actions.quit();
        },
      },
    );
    return rows;
  }

  async #pause(): Promise<void> {
    if (!this.#canPause()) return;
    this.#pausing = true;
    this.#unsaved = false;
    this.refresh();
    try {
      const result = await this.#deps.actions.pauseAll();
      if ('unsaved' in result) this.#unsaved = result.unsaved.length > 0;
      else this.#deps.log('corrallm could not pause its agents.');
    } catch {
      this.#deps.log('corrallm could not pause its agents.');
    } finally {
      this.#pausing = false;
      this.refresh();
    }
  }

  #stopAwake(): void {
    const id = this.#blocker;
    this.#blocker = undefined;
    if (id !== undefined)
      this.#try(() => {
        this.#deps.backend.stopAwake(id);
      });
  }

  #try(action: () => void): void {
    try {
      action();
    } catch {
      this.#deps.log('corrallm could not update its native presence.');
    }
  }
}

function badge(count: number): string {
  return count === 0 ? '' : count > 99 ? '99+' : String(count);
}
