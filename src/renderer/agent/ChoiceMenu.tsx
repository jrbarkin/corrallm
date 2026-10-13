import { useState } from 'react';

/**
 * A button showing a choice ("Mode: Manual"; what it shows may say more: `shown`), opening a menu
 * of the others: above it (as under the composer), or `below` it (as in a panel that opens down).
 */
export function ChoiceMenu({
  label,
  value,
  shown = value,
  title,
  choices,
  chosen,
  onChoose,
  below = false,
}: {
  label: string;
  value: string;
  shown?: string;
  title: string;
  choices: readonly { key: string; label: string; detail?: string }[];
  chosen: string;
  onChoose: (key: string) => void;
  below?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className="agent-choice"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        // Esc closes the menu, not the view.
        if (open && event.key === 'Escape') {
          event.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        aria-label={`${label}: ${value}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={title}
        onClick={() => {
          setOpen(!open);
        }}
      >
        {shown}
      </button>
      {open && (
        <div
          className="agent-choice-menu"
          role="menu"
          aria-label={label}
          data-below={below ? '' : undefined}
        >
          {choices.map((choice) => (
            <button
              key={choice.key}
              type="button"
              role="menuitemradio"
              aria-checked={choice.key === chosen}
              onClick={() => {
                setOpen(false);
                onChoose(choice.key);
              }}
            >
              <span>{choice.label}</span>
              {choice.detail !== undefined && (
                <span className="agent-choice-detail">{choice.detail}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
