import { useEffect, useMemo, useRef, useState } from 'react';

import { AgentType, DEFAULT_AGENT } from './agents';
import type { Example } from './examples';
import { fromFile } from './file';

/** How a template is used: as a new canvas, or inserted into this one as a group. */
export type TemplateUse = 'new' | 'insert';

/** What a template is used with: its blanks filled in, and each agent's type (undefined: open). */
export interface TemplateChoices {
  values: Readonly<Record<string, string>>;
  agents: Readonly<Record<string, AgentType | undefined>>;
}

/**
 * The templates gallery: a card for each template (its name, what it does, a dot for each of its
 * agents, in its type's colour, or hollow where the template leaves the agent open). Picking one
 * shows what it asks: its blanks, each starting from the template's own example, and each agent's
 * type, which the user may change or leave to the default agent. Then it opens as a new canvas, or
 * (`canInsert`, when the canvas has something on it) is inserted into this one as a group. Escape
 * steps back from that, then closes the gallery, as do the close button and a click outside.
 */
export function ExampleGallery({
  examples,
  canInsert,
  onPick,
  onClose,
}: {
  examples: readonly Example[];
  canInsert: boolean;
  onPick: (example: Example, choices: TemplateChoices, use: TemplateUse) => void;
  onClose: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  /** The template picked, and what it is to be used with so far. */
  const [chosen, setChosen] = useState<{ example: Example } & TemplateChoices>();
  useEffect(() => {
    panel.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (chosen) setChosen(undefined);
      else onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose, chosen]);
  /** Each template's agents: id, name, and type (undefined where the template leaves it open). */
  const agentsOf = useMemo(
    () =>
      new Map(
        examples.map((example) => [
          example,
          fromFile(example.text)
            .nodes.filter((n) => n.type === 'agent')
            .map((n) => ({ id: n.id, label: n.data.label, agent: n.data.agent })),
        ]),
      ),
    [examples],
  );
  const use = (how: TemplateUse) => {
    if (!chosen) return;
    const { example, values, agents } = chosen;
    onPick(example, { values, agents }, how);
  };
  const pick = (example: Example) => {
    setChosen({
      example,
      values: Object.fromEntries((example.fields ?? []).map((f) => [f.key, f.example])),
      agents: Object.fromEntries((agentsOf.get(example) ?? []).map((a) => [a.id, a.agent])),
    });
  };

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
          <h2>{chosen ? chosen.example.name : 'Templates'}</h2>
          <button
            type="button"
            className="graph-detail-close"
            aria-label="Close"
            onClick={onClose}
          />
        </header>
        {chosen ? (
          <form
            className="graph-template-form"
            onSubmit={(event) => {
              event.preventDefault();
              use(canInsert ? 'insert' : 'new');
            }}
          >
            <p className="graph-example-description">{chosen.example.description}</p>
            {(chosen.example.fields ?? []).map((field, i) => (
              <label key={field.key} className="graph-template-field">
                <span>{field.label}</span>
                <textarea
                  id={`template-${field.key}`}
                  rows={3}
                  value={chosen.values[field.key] ?? ''}
                  autoFocus={i === 0}
                  onChange={(event) => {
                    setChosen({
                      ...chosen,
                      values: { ...chosen.values, [field.key]: event.target.value },
                    });
                  }}
                />
              </label>
            ))}
            <fieldset className="graph-template-agents">
              <legend>Agents</legend>
              {(agentsOf.get(chosen.example) ?? []).map((role) => (
                <label key={role.id} className="graph-template-agent">
                  <span
                    className="graph-example-agent"
                    data-agent={chosen.agents[role.id]}
                    aria-hidden="true"
                  />
                  <span>{role.label}</span>
                  <select
                    id={`template-agent-${role.id}`}
                    aria-label={`${role.label}'s agent`}
                    value={chosen.agents[role.id] ?? ''}
                    onChange={(event) => {
                      const type = Object.values(AgentType).find((t) => t === event.target.value);
                      setChosen({ ...chosen, agents: { ...chosen.agents, [role.id]: type } });
                    }}
                  >
                    <option value="">Default ({DEFAULT_AGENT})</option>
                    {Object.values(AgentType).map((type) => (
                      <option key={type} value={type}>
                        {type}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </fieldset>
            <div className="graph-template-actions">
              <button
                type="button"
                onClick={() => {
                  setChosen(undefined);
                }}
              >
                Back
              </button>
              <button
                type="button"
                className={canInsert ? undefined : 'primary'}
                onClick={() => {
                  use('new');
                }}
              >
                Create canvas
              </button>
              {canInsert && (
                <button type="submit" className="primary">
                  Insert into this canvas
                </button>
              )}
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
                    {agentsOf.get(example)?.map((role) => (
                      <span
                        key={role.id}
                        className="graph-example-agent"
                        data-agent={role.agent}
                        title={role.agent ?? 'Any agent'}
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
