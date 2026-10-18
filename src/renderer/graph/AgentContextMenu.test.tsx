import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { AgentContextMenu } from './AgentContextMenu';

function setup(paused = false, extra: Partial<ComponentProps<typeof AgentContextMenu>> = {}) {
  const actions = { onPause: vi.fn(), onKill: vi.fn(), onResume: vi.fn(), onClose: vi.fn() };
  const view = render(
    <AgentContextMenu
      name="Builder"
      at={{ x: 200, y: 250 }}
      paused={paused}
      {...actions}
      {...extra}
    />,
  );
  return {
    ...actions,
    ...view,
    menu: within(screen.getByRole('menu', { name: 'Builder controls' })),
  };
}

describe('agent context menu', () => {
  it('explains group-wide actions and preserves other pause causes when resuming', () => {
    const { menu, onResume, onKill } = setup(true, { scope: 'group', groupSize: 3 });
    expect(menu.getByText('3 agents, including nested groups')).toBeTruthy();
    expect(
      menu.getByText('Release this group’s holds; keep individual and other group pauses'),
    ).toBeTruthy();
    fireEvent.click(menu.getByRole('menuitem', { name: /^Resume/ }));
    expect(onResume).toHaveBeenCalledOnce();
    expect(onKill).not.toHaveBeenCalled();
  });

  it('keeps a parent agent’s individual actions separate from its group actions', () => {
    const group = { size: 2, paused: false, onPause: vi.fn(), onKill: vi.fn(), onResume: vi.fn() };
    const { menu, onResume, onKill } = setup(true, { group });
    expect(menu.getByText('Group (2 agents)')).toBeTruthy();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'End' });
    expect(document.activeElement).toBe(menu.getByRole('menuitem', { name: /^Kill group/ }));
    fireEvent.click(menu.getByRole('menuitem', { name: /^Pause group/ }));
    expect(group.onPause).toHaveBeenCalledOnce();
    expect(onResume).not.toHaveBeenCalled();
    expect(onKill).not.toHaveBeenCalled();
    expect(group.onKill).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'explains a group-held agent’s separate individual pause (%s)',
    (paused) => {
      const { menu, onPause, onResume } = setup(paused, { heldByGroups: ['Team', 'Reviewers'] });
      expect(menu.getByText('Held by group: Team, Reviewers')).toBeTruthy();
      if (paused) {
        expect(
          menu.getByText('Release the individual pause; group holds still apply'),
        ).toBeTruthy();
        fireEvent.click(menu.getByRole('menuitem', { name: /^Resume/ }));
        expect(onResume).toHaveBeenCalledOnce();
      } else {
        expect(menu.getByText('Keep this agent paused after its groups resume')).toBeTruthy();
        fireEvent.click(menu.getByRole('menuitem', { name: /^Pause separately/ }));
        expect(onPause).toHaveBeenCalledOnce();
      }
    },
  );

  it('offers Pause and Kill with their different effects, acting only on a chosen item', () => {
    const { menu, onPause, onKill, onClose } = setup();
    expect(menu.getByText('Finish the current task, then hold this queue')).toBeTruthy();
    expect(menu.getByText('Interrupt now; keep the console open')).toBeTruthy();
    expect(onPause).not.toHaveBeenCalled();
    expect(onKill).not.toHaveBeenCalled();
    fireEvent.click(menu.getByRole('menuitem', { name: /^Pause/ }));
    expect(onPause).toHaveBeenCalledOnce();
    expect(onKill).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('offers Resume for a held queue and keeps Kill available', () => {
    const { menu, onResume, onKill } = setup(true);
    expect(menu.queryByRole('menuitem', { name: /^Pause/ })).toBeNull();
    fireEvent.click(menu.getByRole('menuitem', { name: /^Resume/ }));
    expect(onResume).toHaveBeenCalledOnce();
    fireEvent.click(menu.getByRole('menuitem', { name: /^Kill/ }));
    expect(onKill).toHaveBeenCalledOnce();
  });

  it('moves keyboard focus within the menu and returns it when dismissed', () => {
    const trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();
    const { menu, onClose, onKill, unmount } = setup();
    expect(document.activeElement).toBe(menu.getByRole('menuitem', { name: /^Pause/ }));
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(menu.getByRole('menuitem', { name: /^Kill/ }));
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
    expect(onKill).not.toHaveBeenCalled();
    unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it('dismisses outside without acting and stays within the viewport', () => {
    const { onClose, onKill } = setup();
    const menu = screen.getByRole('menu');
    expect(Number.parseFloat(menu.style.left)).toBeLessThan(window.innerWidth);
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledOnce();
    expect(onKill).not.toHaveBeenCalled();
  });
});
