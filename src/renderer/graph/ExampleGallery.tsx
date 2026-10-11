import { useEffect, useMemo, useRef } from 'react';

import { DEFAULT_AGENT } from './agents';
import type { Example } from './examples';
import { fromFile } from './file';

/**
 * The examples gallery: a card for each example (its name, what it shows, a dot for each of its
 * agents in its agent's colour). Picking one opens it; Escape, the close button or a click
 * outside closes the gallery.
 */
export function ExampleGallery({
  examples,
  onPick,
  onClose,
}: {
  examples: readonly Example[];
  onPick: (example: Example) => void;
  onClose: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    panel.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);
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
        aria-label="Examples"
        tabIndex={-1}
      >
        <header className="graph-detail-header">
          <h2>Examples</h2>
          <button
            type="button"
            className="graph-detail-close"
            aria-label="Close"
            onClick={onClose}
          />
        </header>
        <ul>
          {examples.map((example) => (
            <li key={example.name}>
              <button
                type="button"
                className="graph-example"
                onClick={() => {
                  onPick(example);
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
      </div>
    </div>
  );
}
