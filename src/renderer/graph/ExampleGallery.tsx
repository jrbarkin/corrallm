import { useEffect, useMemo, useRef, useState } from 'react';

import { DEFAULT_AGENT } from './agents';
import type { Example } from './examples';
import { fromFile } from './file';

/**
 * The templates gallery: a card for each template (its name, what it does, a dot for each of its
 * agents in its agent's colour). Picking one opens it; one with blanks to fill in (`fields`) asks
 * for them first, each starting from the template's own example. Escape steps back from that, then
 * closes the gallery, as do the close button and a click outside.
 */
export function ExampleGallery({
  examples,
  onPick,
  onClose,
}: {
  examples: readonly Example[];
  /** `values`: what fills each of the template's blanks, by key. */
  onPick: (example: Example, values: Readonly<Record<string, string>>) => void;
  onClose: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  /** The template whose blanks are being filled in, and what fills them so far. */
  const [filling, setFilling] = useState<{ example: Example; values: Record<string, string> }>();
  useEffect(() => {
    panel.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (filling) setFilling(undefined);
      else onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose, filling]);
  const pick = (example: Example) => {
    const fields = example.fields ?? [];
    if (fields.length === 0) onPick(example, {});
    else setFilling({ example, values: Object.fromEntries(fields.map((f) => [f.key, f.example])) });
  };
  const agentsOf = useMemo(
    () =>
      new Map(
        examples.map((example) => [
          example,
          fromFile(example.text)
            .nodes.filter((n) => n.type === 'agent')
            .map((n) => n.data.agent ?? DEFAULT_AGENT),
        ]),
      ),
    [examples],
  );

  return (
    <div
      className="graph-detail-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        className="graph-examples"
        role="dialog"
        aria-modal="true"
        aria-label="Templates"
        tabIndex={-1}
      >
        <header className="graph-detail-header">
          <h2>{filling ? filling.example.name : 'Templates'}</h2>
          <button
            type="button"
            className="graph-detail-close"
            aria-label="Close"
            onClick={onClose}
          />
        </header>
        {filling ? (
          <form
            className="graph-template-form"
            onSubmit={(event) => {
              event.preventDefault();
              onPick(filling.example, filling.values);
            }}
          >
            <p className="graph-example-description">{filling.example.description}</p>
            {(filling.example.fields ?? []).map((field, i) => (
              <label key={field.key} className="graph-template-field">
                <span>{field.label}</span>
                <textarea
                  id={`template-${field.key}`}
                  rows={3}
                  value={filling.values[field.key] ?? ''}
                  autoFocus={i === 0}
                  onChange={(event) => {
                    setFilling({
                      ...filling,
                      values: { ...filling.values, [field.key]: event.target.value },
                    });
                  }}
                />
              </label>
            ))}
            <div className="graph-template-actions">
              <button
                type="button"
                onClick={() => {
                  setFilling(undefined);
                }}
              >
                Back
              </button>
              <button type="submit" className="primary">
                Create canvas
              </button>
            </div>
          </form>
        ) : (
          <ul>
            {examples.map((example) => (
              <li key={example.name}>
                <button
                  type="button"
                  className="graph-example"
                  onClick={() => {
                    pick(example);
                  }}
                >
                  <span className="graph-example-name">{example.name}</span>
                  <span className="graph-example-description">{example.description}</span>
                  <span className="graph-example-agents" aria-hidden="true">
                    {agentsOf.get(example)?.map((agent, i) => (
                      <span
                        key={i}
                        className="graph-example-agent"
                        data-agent={agent}
                        title={agent}
                      />
                    ))}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
