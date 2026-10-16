import { useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

/** Runtime controls for one agent, shared by its canvas card and queue heading. */
export function AgentContextMenu({
  name,
  at,
  paused,
  onPause,
  onKill,
  onResume,
  onClose,
}: {
  name: string;
  at: { x: number; y: number };
  paused: boolean;
  onPause: () => void;
  onKill: () => void;
  onResume: () => void;
  onClose: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = menu.current;
    if (!element) return;
    const previous = document.activeElement;
    const box = element.getBoundingClientRect();
    element.style.left = `${String(Math.max(8, Math.min(at.x, window.innerWidth - box.width - 8)))}px`;
    element.style.top = `${String(Math.max(8, Math.min(at.y, window.innerHeight - box.height - 8)))}px`;
    element.querySelector<HTMLButtonElement>('button')?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [at.x, at.y]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Node && menu.current?.contains(event.target))) onClose();
    };
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={menu}
      className="agent-context-menu"
      role="menu"
      aria-label={`${name} controls`}
      style={{ left: at.x, top: at.y }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Escape' || event.key === 'Tab') {
          if (event.key === 'Escape') event.preventDefault();
          onClose();
          return;
        }
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next =
          event.key === 'ArrowDown'
            ? (index + 1) % buttons.length
            : event.key === 'ArrowUp'
              ? (index + buttons.length - 1) % buttons.length
              : event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? buttons.length - 1
                  : undefined;
        if (next !== undefined) {
          event.preventDefault();
          buttons[next]?.focus();
        }
      }}
    >
      <div className="agent-context-name">{name}</div>
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onClose();
          if (paused) onResume();
          else onPause();
        }}
      >
        <span>{paused ? 'Resume' : 'Pause'}</span>
        <span className="agent-context-detail">
          {paused ? 'Let this queue continue' : 'Finish the current task, then hold this queue'}
        </span>
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onClose();
          onKill();
        }}
      >
        <span>Kill</span>
        <span className="agent-context-detail">Interrupt now; keep the console open</span>
      </button>
    </div>,
    document.body,
  );
}
