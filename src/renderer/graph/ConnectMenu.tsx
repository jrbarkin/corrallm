import { useEffect, useRef } from 'react';

/** Where the menu goes in the editor: just above, or below, the point (x, y). */
export interface MenuPlace {
  x: number;
  y: number;
  above: boolean;
}

/**
 * What an edge drawn from one agent to another makes: a link that lets them talk to each other, or
 * work queued for the second (which links them too: agents that hand each other work can talk).
 * Shown where the drag ended (`at`); Escape or a click elsewhere cancels.
 */
export function ConnectMenu({
  fromName,
  toName,
  linked,
  at,
  onTalk,
  onWork,
  onCancel,
}: {
  fromName: string;
  toName: string;
  /** Whether the two can talk already. */
  linked: boolean;
  at: MenuPlace | undefined;
  onTalk: () => void;
  onWork: () => void;
  onCancel: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    menu.current?.querySelector<HTMLButtonElement>('button:enabled')?.focus();
  }, []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node && menu.current?.contains(event.target))) onCancel();
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [onCancel]);

  return (
    <div
      ref={menu}
      className={at?.above ? 'graph-connect above' : 'graph-connect'}
      role="dialog"
      aria-label={`Connect ${fromName} to ${toName}`}
      {...(at ? { style: { left: at.x, top: at.y } } : {})}
    >
      <button type="button" disabled={linked} onClick={onTalk}>
        <span className="graph-connect-title">Let them talk</span>
        <span className="graph-connect-detail">
          {linked ? 'They can already' : 'Either can message the other'}
        </span>
      </button>
      <button type="button" onClick={onWork}>
        <span className="graph-connect-title">Queue work for {toName}</span>
        <span className="graph-connect-detail">
          From {fromName}&apos;s queue (they can talk too)
        </span>
      </button>
    </div>
  );
}
