import { useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

interface GroupControls {
  size: number;
  paused: boolean;
  onPause: () => void;
  onKill: () => void;
  onResume: () => void;
}

/** Runtime controls shared by agent cards, groups, queue headings and session headers. */
export function AgentContextMenu({
  name,
  at,
  paused,
  scope = 'agent',
  groupSize,
  heldByGroups = [],
  group,
  onPause,
  onKill,
  onResume,
  onSettings,
  onClose,
}: {
  name: string;
  at: { x: number; y: number };
  paused: boolean;
  scope?: 'agent' | 'group';
  groupSize?: number;
  heldByGroups?: readonly string[];
  group?: GroupControls;
  onPause: () => void;
  onKill: () => void;
  onResume: () => void;
  onSettings?: () => void;
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
      {scope === 'group' && groupSize !== undefined && (
        <div className="agent-context-note">
          {String(groupSize)} {groupSize === 1 ? 'agent' : 'agents'}, including nested groups
        </div>
      )}
      {scope === 'agent' && heldByGroups.length > 0 && (
        <div className="agent-context-note">Held by group: {heldByGroups.join(', ')}</div>
      )}
      <ControlItems
        scope={scope}
        paused={paused}
        separate={scope === 'agent' && heldByGroups.length > 0}
        onPause={onPause}
        onKill={onKill}
        onResume={onResume}
        onClose={onClose}
      />
      {scope === 'agent' && onSettings && (
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            onClose();
            onSettings();
          }}
        >
          Settings…
        </button>
      )}
      {group && (
        <>
          <div className="agent-context-name agent-context-group">
            Group ({String(group.size)} {group.size === 1 ? 'agent' : 'agents'})
          </div>
          <ControlItems scope="group" suffix=" group" {...group} onClose={onClose} />
        </>
      )}
    </div>,
    document.body,
  );
}

function ControlItems({
  scope,
  paused,
  suffix = '',
  separate = false,
  onPause,
  onKill,
  onResume,
  onClose,
}: {
  scope: 'agent' | 'group';
  paused: boolean;
  suffix?: string;
  separate?: boolean;
  onPause: () => void;
  onKill: () => void;
  onResume: () => void;
  onClose: () => void;
}) {
  const group = scope === 'group';
  const label = paused ? 'Resume' : separate ? 'Pause separately' : 'Pause';
  const detail = group
    ? paused
      ? 'Release this group’s holds; keep individual and other group pauses'
      : 'Finish current tasks, then hold every queue in this group'
    : paused
      ? separate
        ? 'Release the individual pause; group holds still apply'
        : 'Let this queue continue'
      : separate
        ? 'Keep this agent paused after its groups resume'
        : 'Finish the current task, then hold this queue';
  return (
    <>
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onClose();
          if (paused) onResume();
          else onPause();
        }}
      >
        <span>
          {label}
          {suffix}
        </span>
        <span className="agent-context-detail">{detail}</span>
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onClose();
          onKill();
        }}
      >
        <span>Kill{suffix}</span>
        <span className="agent-context-detail">
          {group
            ? 'Interrupt members now; keep their consoles open'
            : 'Interrupt now; keep the console open'}
        </span>
      </button>
    </>
  );
}
