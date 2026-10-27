import { describe, expect, it, vi } from 'vitest';

import type { Presence } from '../core/presence';
import { PresencePresentation } from './presence';
import type { PresenceBackend, PresenceMenu, PresenceTray } from './presence';

const IDLE: Presence = {
  revision: 0,
  working: 0,
  runs: 0,
  jobs: 0,
  needs: 0,
  busy: false,
  awake: false,
};

class FakeTray implements PresenceTray {
  menu: PresenceMenu = [];
  title = '';
  needs = false;
  destroyed = false;
  update(menu: PresenceMenu, title: string, needs: boolean): void {
    this.menu = menu;
    this.title = title;
    this.needs = needs;
  }
  destroy(): void {
    this.destroyed = true;
  }
}

class FakePresence implements PresenceBackend {
  menu: PresenceMenu = [];
  badge = '';
  launcher = 0;
  trays: FakeTray[] = [];
  dock(menu: PresenceMenu): void {
    this.menu = menu;
  }
  dockBadge(label: string): void {
    this.badge = label;
  }
  launcherBadge(count: number): void {
    this.launcher = count;
  }
  tray(): PresenceTray {
    const tray = new FakeTray();
    this.trays.push(tray);
    return tray;
  }
  startAwake = vi.fn(() => 42);
  stopAwake = vi.fn<(id: number) => void>();
}

function world(platform: NodeJS.Platform = 'darwin', hidden = false) {
  const backend = new FakePresence();
  const state = { shown: true, saving: false, approved: false };
  const actions = {
    open: vi.fn(),
    quit: vi.fn(),
    pauseAll: vi.fn(() =>
      Promise.resolve({
        agents: 2,
        canvases: 1,
        unsaved: [] as { canvas: string; sentence: string }[],
      }),
    ),
  };
  const presentation = new PresencePresentation({
    platform,
    hidden,
    backend,
    actions,
    windowShown: () => state.shown,
    quitting: () => state,
    log: vi.fn(),
  });
  return { backend, state, actions, presentation };
}

const item = (menu: PresenceMenu, id: string) => {
  const found = menu.find((item) => item.id === id);
  if (!found) throw new Error(`missing ${id}`);
  return found;
};

describe('native presence', () => {
  it('uses one fixed menu, keeps the Dock, caps its badge, and shows the menu-bar item exactly without a shown window', () => {
    const w = world();
    w.presentation.update(undefined);
    expect(item(w.backend.menu, 'status').label).toBe('Recovering');
    expect(item(w.backend.menu, 'pause').enabled).toBe(false);
    w.presentation.update({ ...IDLE, working: 123, needs: 101, busy: true, awake: true });
    expect(w.backend.badge).toBe('99+');
    expect(w.backend.trays).toHaveLength(0);
    w.state.shown = false;
    w.presentation.refresh();
    expect(w.backend.trays).toHaveLength(1);
    const tray = w.backend.trays[0];
    if (tray === undefined) throw new Error('no tray');
    expect(tray.menu).toBe(w.backend.menu);
    expect(tray.title).toBe('123');
    expect(tray.needs).toBe(true);
    item(tray.menu, 'open').click?.();
    item(tray.menu, 'quit').click?.();
    expect(w.actions.open).toHaveBeenCalledOnce();
    expect(w.actions.quit).toHaveBeenCalledOnce();
    w.state.shown = true;
    w.presentation.refresh();
    expect(tray.destroyed).toBe(true);
    w.presentation.close();
  });

  it('keeps the Linux tray with or without windows and updates its menu and launcher badge', () => {
    const w = world('linux');
    w.presentation.update(IDLE);
    w.state.shown = false;
    w.presentation.refresh();
    expect(w.backend.trays).toHaveLength(1);
    w.presentation.update({ ...IDLE, needs: 8 });
    expect(w.backend.launcher).toBe(8);
    expect(w.backend.trays[0]?.needs).toBe(true);
    expect(w.backend.trays[0]?.title).toBe('');
    w.presentation.close();
    expect(w.backend.trays[0]?.destroyed).toBe(true);
  });

  it('starts at most one power blocker, clears it on a lost core, and stops before exit', () => {
    const w = world();
    w.presentation.update({ ...IDLE, working: 1, busy: true, awake: true });
    w.presentation.refresh();
    w.presentation.update({ ...IDLE, revision: 1, awake: true });
    expect(w.backend.startAwake).toHaveBeenCalledOnce();
    w.presentation.update(undefined);
    expect(w.backend.stopAwake).toHaveBeenCalledExactlyOnceWith(42);
    w.presentation.update({ ...IDLE, awake: true });
    w.state.approved = true;
    w.presentation.refresh();
    expect(w.backend.stopAwake).toHaveBeenCalledTimes(1);
    w.presentation.close();
    expect(w.backend.stopAwake).toHaveBeenCalledTimes(2);
  });

  it('ignores a failed blocker start without retrying within the awake episode', () => {
    const w = world();
    w.backend.startAwake.mockImplementationOnce(() => {
      throw new Error('native failure');
    });
    w.presentation.update({ ...IDLE, awake: true });
    w.presentation.refresh();
    expect(w.backend.startAwake).toHaveBeenCalledOnce();
    w.presentation.update(IDLE);
    w.presentation.update({ ...IDLE, awake: true });
    expect(w.backend.startAwake).toHaveBeenCalledTimes(2);
    w.presentation.close();
    expect(w.backend.stopAwake).toHaveBeenCalledExactlyOnceWith(42);
  });

  it('guards Pause all afresh, holds it while awaiting the core, and shows only a fixed unsaved row', async () => {
    const w = world();
    w.presentation.update(IDLE);
    const paused = Promise.withResolvers<{
      agents: number;
      canvases: number;
      unsaved: { canvas: string; sentence: string }[];
    }>();
    w.actions.pauseAll.mockReturnValueOnce(paused.promise);
    const pause = item(w.backend.menu, 'pause');
    w.state.saving = true;
    pause.click?.();
    expect(w.actions.pauseAll).not.toHaveBeenCalled();
    w.state.saving = false;
    w.presentation.refresh();
    pause.click?.();
    pause.click?.();
    expect(w.actions.pauseAll).toHaveBeenCalledOnce();
    expect(item(w.backend.menu, 'pause').enabled).toBe(false);
    paused.resolve({
      agents: 2,
      canvases: 1,
      unsaved: [{ canvas: 'canvas', sentence: 'private native text' }],
    });
    await vi.waitFor(() => {
      expect(item(w.backend.menu, 'unsaved').label).toBe('Some pauses may not survive a restart');
    });
    expect(JSON.stringify(w.backend.menu)).not.toContain('private native text');
    expect(item(w.backend.menu, 'pause').enabled).toBe(true);
    w.presentation.close();
  });

  it('the hidden macOS app installs the Dock menu but creates no Tray and sets no badge', () => {
    const w = world('darwin', true);
    const badge = vi.spyOn(w.backend, 'dockBadge');
    w.state.shown = false;
    w.presentation.update({ ...IDLE, needs: 9 });
    expect(w.backend.menu.length).toBeGreaterThan(0);
    expect(w.backend.trays).toEqual([]);
    expect(badge).not.toHaveBeenCalled();
    w.presentation.close();
    expect(badge).not.toHaveBeenCalled();
  });
});
