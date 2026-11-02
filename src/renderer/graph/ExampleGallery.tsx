import { useEffect, useRef, useState } from 'react';

import type { AdapterId } from '../../shared/adapter';
import type { InstalledClis } from '../../shared/session';
import { api } from '../api/client';
import { AdapterLogo } from '../AdapterLogo';
import { ipcErrorMessage } from '../ipc-error';
import type { TemplateInfo } from '../../shared/templates';
import {
  adapterName,
  connectedAgents,
  connectionInfo,
  connectionsOf,
  defaultConnection,
} from './agents';
import type { AgentConnection } from './agents';

/** How a template is used: as a new canvas, or inserted into this one with its own roots. */
export type TemplateUse = 'new' | 'insert';

/**
 * What a template is used with: its blanks filled in, every agent's chosen type, and how
 * each agent runs.
 */
export interface TemplateChoices {
  values: Readonly<Record<string, string>>;
  agents: Readonly<Record<string, AdapterId>>;
  connections: Readonly<Record<string, AgentConnection>>;
}

/** What the user chose for a template so far: how an agent runs only where they chose it. */
type Chosen = Omit<TemplateChoices, 'agents' | 'connections'> & {
  agents: Readonly<Record<string, AdapterId | undefined>>;
  connections: Readonly<Record<string, AgentConnection | undefined>>;
};

/** Templates require every role's explicit adapter; connections retain declared order. */
export function ExampleGallery({
  canInsert,
  installed,
  initialTemplate,
  onPick,
  onClose,
}: {
  canInsert: boolean;
  /** Which CLIs the user has; undefined while main has not said. */
  installed?: InstalledClis | undefined;
  initialTemplate?: TemplateInfo | undefined;
  onPick: (example: TemplateInfo, choices: TemplateChoices, use: TemplateUse) => void;
  onClose: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  /** The template picked, and what it is to be used with so far. */
  const chosenOf = (example: TemplateInfo) => ({
    example,
    values: Object.fromEntries(example.fields.map((f) => [f.key, f.example])),
    agents: Object.fromEntries(example.agents.map((a) => [a.id, undefined])),
    connections: {},
  });
  const [chosen, setChosen] = useState<({ example: TemplateInfo } & Chosen) | undefined>(() =>
    initialTemplate ? chosenOf(initialTemplate) : undefined,
  );
  /** How an agent of the template picked runs: as chosen, or its type's default. */
  const connectionOf = (id: string): AgentConnection | undefined =>
    chosen?.connections[id] ?? defaultConnection(chosen?.agents[id]);
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
  const [examples, setExamples] = useState<TemplateInfo[]>();
  const [problem, setProblem] = useState<string>();
  useEffect(() => {
    let current = true;
    void api.templatesList().then(
      ({ items }) => {
        if (current) setExamples(items);
      },
      (error: unknown) => {
        if (current) setProblem(ipcErrorMessage(error));
      },
    );
    return () => {
      current = false;
    };
  }, []);
  const ready = chosen?.example.agents.every(
    (role) => chosen.agents[role.id] !== undefined && connectionOf(role.id) !== undefined,
  );
  const use = (how: TemplateUse) => {
    if (!chosen || !ready) return;
    const { example, values } = chosen;
    const agents: Record<string, AdapterId> = {};
    const connections: Record<string, AgentConnection> = {};
    for (const role of example.agents) {
      const adapter = chosen.agents[role.id];
      const connection = connectionOf(role.id);
      if (adapter === undefined || connection === undefined) return;
      agents[role.id] = adapter;
      connections[role.id] = connection;
    }
    onPick(example, { values, agents, connections }, how);
  };
  const pick = (example: TemplateInfo) => {
    setChosen(chosenOf(example));
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
        {problem && <p role="alert">Could not load templates: {problem}</p>}
        {examples === undefined && problem === undefined && <p role="status">Loading templates…</p>}
        {chosen ? (
          <form
            className="graph-template-form"
            onSubmit={(event) => {
              event.preventDefault();
              use(canInsert ? 'insert' : 'new');
            }}
          >
            <p className="graph-example-description">{chosen.example.description}</p>
            {chosen.example.fields.map((field, i) => (
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
              {chosen.example.agents.map((role) => (
                <label key={role.id} className="graph-template-agent">
                  <AdapterLogo adapter={chosen.agents[role.id]} size={18} />
                  <span>{role.name}</span>
                  <select
                    id={`template-agent-${role.id}`}
                    aria-label={`${role.name}'s agent`}
                    value={chosen.agents[role.id] ?? ''}
                    onChange={(event) => {
                      const type = connectedAgents().find((t) => t === event.target.value);
                      // Another type runs as that type does, unless chosen again.
                      setChosen({
                        ...chosen,
                        agents: { ...chosen.agents, [role.id]: type },
                        connections: { ...chosen.connections, [role.id]: undefined },
                      });
                    }}
                  >
                    <option value="">Choose an agent</option>
                    {connectedAgents().map((type) => (
                      <option key={type} value={type}>
                        {adapterName(type)}
                      </option>
                    ))}
                  </select>
                  <ConnectionSelect
                    role={role.name}
                    agent={chosen.agents[role.id]}
                    value={connectionOf(role.id)}
                    installed={installed}
                    onChange={(connection) => {
                      setChosen({
                        ...chosen,
                        connections: { ...chosen.connections, [role.id]: connection },
                      });
                    }}
                  />
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
                disabled={!ready}
                className={canInsert ? undefined : 'primary'}
                onClick={() => {
                  use('new');
                }}
              >
                Create canvas
              </button>
              {canInsert && (
                <button type="submit" className="primary" disabled={!ready}>
                  Insert into this canvas
                </button>
              )}
            </div>
          </form>
        ) : (
          <ul>
            {(examples ?? []).map((example) => (
              <li key={example.id}>
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
                    {example.agents.map((role) => (
                      <span
                        key={role.id}
                        title={role.adapter === undefined ? 'Any agent' : adapterName(role.adapter)}
                      >
                        {role.adapter === undefined ? (
                          <span className="graph-example-any-agent" />
                        ) : (
                          <AdapterLogo adapter={role.adapter} size={18} />
                        )}
                      </span>
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

/**
 * How a template's agent runs: the real ways its type runs (Terminal first), each
 * explained in its title. An unsupported legacy type says Not connected until another CLI is chosen.
 */
function ConnectionSelect({
  role,
  agent,
  value,
  installed,
  onChange,
}: {
  role: string;
  agent: AdapterId | undefined;
  value: AgentConnection | undefined;
  installed: InstalledClis | undefined;
  onChange: (connection: AgentConnection) => void;
}) {
  const ways = connectionsOf(agent);
  return (
    <select
      aria-label={`How ${role} runs`}
      value={value ?? ''}
      disabled={ways.length <= 1}
      title={connectionInfo(value).description}
      onChange={(event) => {
        const way = ways.find((connection) => connection === event.target.value);
        if (way !== undefined) onChange(way);
      }}
    >
      {ways.length === 0 && <option value="">Choose an agent</option>}
      {ways.map((connection) => (
        <option key={connection} value={connection} title={connectionInfo(connection).description}>
          {connectionInfo(connection).label}
          {agent !== undefined && installed?.[agent] === false ? ' (CLI not found)' : ''}
        </option>
      ))}
    </select>
  );
}
