import { useEffect, useRef, useState } from 'react';
import type { GuiApi } from '../../shared/gui-link';
import type { TopicMirror } from '../api/topics';
import { topics } from '../api/topics';
import { api } from '../api/client';
import { DefaultAgentControl } from '../DefaultAgentControl';
import type { InstalledClis } from '../../shared/session';
import { catalog } from '../catalog';
import { AdapterLogo } from '../AdapterLogo';

export interface NewAgentEndpoint {
  adapter: string;
  connection: string;
}

/** An add plans a card. Installation never blocks choosing its endpoint. */
export function AddAgentChooser({
  client = api,
  mirror = topics,
  installed,
  onPick,
  onClose,
}: {
  client?: Pick<GuiApi, 'settingsSet'>;
  mirror?: TopicMirror;
  installed: InstalledClis | undefined;
  onPick: (endpoint: NewAgentEndpoint) => void;
  onClose: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [chosen, setChosen] = useState<NewAgentEndpoint>();
  const [connections, setConnections] = useState<Readonly<Record<string, string>>>({});
  useEffect(() => {
    panel.current?.focus();
  }, []);
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
        aria-label="Choose an agent"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (chosen) onPick(chosen);
          }}
        >
          <h2>Choose an agent</h2>
          <div role="radiogroup" aria-label="Agent">
            {catalog().adapters.map((adapter) => {
              const connection = connections[adapter.id] ?? adapter.connections[0]?.id;
              return (
                <div key={adapter.id}>
                  <label>
                    <input
                      type="radio"
                      name="add-agent"
                      aria-label={adapter.name}
                      checked={chosen?.adapter === adapter.id}
                      disabled={connection === undefined}
                      onChange={() => {
                        if (connection !== undefined)
                          setChosen({ adapter: adapter.id, connection });
                      }}
                    />
                    <AdapterLogo adapter={adapter.id} size={18} />
                    {adapter.name}
                  </label>
                  {installed?.[adapter.id] === false && <span>Not installed</span>}
                  <select
                    aria-label={`How ${adapter.name} runs`}
                    value={connection ?? ''}
                    onChange={(event) => {
                      const connection = event.target.value;
                      setConnections({ ...connections, [adapter.id]: connection });
                      setChosen({ adapter: adapter.id, connection });
                    }}
                  >
                    {adapter.connections.map((connection) => (
                      <option key={connection.id} value={connection.id}>
                        {connection.label}
                      </option>
                    ))}
                  </select>
                </div>
              );
            })}
          </div>
          <DefaultAgentControl client={client} mirror={mirror} />
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" disabled={chosen === undefined}>
            Add
          </button>
        </form>
      </div>
    </div>
  );
}
