import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { fileAction } from './keys';

/** A nonmodal float's popover: outside click and Escape dismiss it; drafts stay mounted. */
export function FloatPopover({
  label,
  button,
  children,
  className = '',
  request,
}: {
  label: string;
  button: ReactNode;
  children: (close: () => void) => ReactNode;
  className?: string;
  /** Local navigation to a decision inside the popover, even after it was dismissed. */
  request?: object | undefined;
}) {
  const [open, setOpen] = useState(request !== undefined);
  const [seenRequest, setSeenRequest] = useState(request);
  if (request !== seenRequest) {
    setSeenRequest(request);
    if (request) setOpen(true);
  }
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && root.current?.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => {
      document.removeEventListener('pointerdown', outside);
    };
  }, [open]);
  return (
    <div
      ref={root}
      className={`float-popover-root ${className}`}
      onKeyDown={(event) => {
        if (!open) return;
        if (fileAction(event.nativeEvent)) {
          setOpen(false);
          return;
        }
        event.stopPropagation();
        if (event.key === 'Escape') {
          setOpen(false);
          trigger.current?.focus();
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          setOpen((value) => !value);
        }}
      >
        {button}
      </button>
      <div id={id} role="dialog" aria-label={label} className="float-popover" hidden={!open}>
        {children(() => {
          setOpen(false);
        })}
      </div>
    </div>
  );
}
