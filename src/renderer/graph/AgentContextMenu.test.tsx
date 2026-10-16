import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AgentContextMenu } from './AgentContextMenu';

function setup(paused = false) {
  const actions = { onPause: vi.fn(), onKill: vi.fn(), onResume: vi.fn(), onClose: vi.fn() };
  const view = render(
    <AgentContextMenu name="Builder" at={{ x: 200, y: 250 }} paused={paused} {...actions} />,
  );
  return {
    ...actions,
    ...view,
    menu: within(screen.getByRole('menu', { name: 'Builder controls' })),
  };
}

describe('agent context menu', () => {
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
