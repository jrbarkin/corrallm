import { useEffect, useId, useRef, useState } from 'react';

import { search } from './search';
import './SearchPicker.css';

/** One row of the list: an option, or (with `freeText`) what was typed. */
type Entry<T> = { option: T } | { typed: string };

/**
 * Type to search, then pick: a text field over the options that match it (see `search`). Arrow
 * keys move through the matches, Enter or a click picks one, Escape or leaving the field cancels.
 * With `freeText`, what was typed is offered too, after the matches (which then leave out letters
 * merely in order, so that a sentence is not taken for an option). Follows the ARIA combobox
 * pattern.
 */
export function SearchPicker<T>({
  label,
  options,
  optionLabel,
  optionDetail,
  optionKey,
  placeholder = 'Search…',
  initialQuery = '',
  freeText,
  onPick,
  onCancel,
}: {
  /** The accessible name of the search field. */
  label: string;
  options: readonly T[];
  optionLabel: (option: T) => string;
  /** A second line under the label; typing finds options by it too, after matches on labels. */
  optionDetail?: (option: T) => string;
  optionKey: (option: T) => string;
  placeholder?: string;
  /** Text the field starts with (selected), such as what was typed last time. */
  initialQuery?: string;
  /** Offers what was typed as an entry of its own, explained by `detail`, picked by `onPick`. */
  freeText?: { detail: string; onPick: (text: string) => void };
  onPick: (option: T) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [active, setActive] = useState(0);
  const field = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const listId = useId();
  const typedId = useId();
  const fuzzy = freeText === undefined;
  const byLabel = search(options, query, optionLabel, { fuzzy });
  const found = optionDetail
    ? [
        ...byLabel,
        ...search(options, query, optionDetail, { fuzzy }).filter((o) => !byLabel.includes(o)),
      ]
    : byLabel;
  const typed = query.trim();
  const offerTyped =
    freeText !== undefined &&
    typed !== '' &&
    !options.some((o) => optionLabel(o).toLowerCase() === typed.toLowerCase());
  const matches: Entry<T>[] = [
    ...found.map((option) => ({ option })),
    ...(offerTyped ? [{ typed }] : []),
  ];
  const current = matches[Math.min(active, matches.length - 1)];
  const entryId = (entry: Entry<T>) =>
    'option' in entry ? `${listId}-${optionKey(entry.option)}` : typedId;
  const pick = (entry: Entry<T>) => {
    if ('option' in entry) onPick(entry.option);
    else freeText?.onPick(entry.typed);
  };

  useEffect(() => {
    field.current?.focus();
    field.current?.select();
    // Opened at the end of a long list, it may start out of sight in whatever scrolls it.
    root.current?.scrollIntoView({ block: 'nearest' });
  }, []);

  return (
    <div
      ref={root}
      className="search-picker"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) onCancel();
      }}
    >
      <input
        ref={field}
        role="combobox"
        aria-label={label}
        aria-expanded="true"
        aria-controls={listId}
        aria-autocomplete="list"
        {...(current === undefined ? {} : { 'aria-activedescendant': entryId(current) })}
        placeholder={placeholder}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const step = event.key === 'ArrowDown' ? 1 : -1;
            setActive((i) =>
              matches.length === 0 ? 0 : (i + step + matches.length) % matches.length,
            );
          } else if (event.key === 'Enter') {
            event.preventDefault();
            if (current !== undefined) pick(current);
          } else if (event.key === 'Escape') {
            // Only the picker closes, not whatever it sits in.
            event.stopPropagation();
            onCancel();
          }
        }}
      />
      <ul id={listId} role="listbox" aria-label={label}>
        {matches.map((entry) => {
          const detail = 'option' in entry ? optionDetail?.(entry.option) : freeText?.detail;
          return (
            <li
              key={entryId(entry)}
              id={entryId(entry)}
              role="option"
              aria-selected={entry === current}
              // Keep the focus in the field.
              onMouseDown={(event) => {
                event.preventDefault();
              }}
              onClick={() => {
                pick(entry);
              }}
            >
              <span>{'option' in entry ? optionLabel(entry.option) : `“${entry.typed}”`}</span>
              {detail !== undefined && (
                <>
                  {' '}
                  <span className="search-picker-detail">{detail}</span>
                </>
              )}
            </li>
          );
        })}
      </ul>
      {matches.length === 0 && <p className="search-picker-empty">No matches</p>}
    </div>
  );
}
