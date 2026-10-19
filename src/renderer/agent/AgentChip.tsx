import { useRef, useState } from 'react';

import { connectionIn } from '../../shared/adapter';
import type { AdapterId } from '../../shared/adapter';
import { catalog } from '../catalog';
import { AdapterLogo } from '../AdapterLogo';
import { agentLabel, CONNECTED_AGENTS, connectionInfo, connectionsOf } from '../graph/agents';
import type { AgentConnection } from '../graph/agents';
import { SearchPicker } from '../search/SearchPicker';

/** A choice in the agent chip: an adapter and how it runs, or continuing the conversation. */
interface Choice {
  adapter: AdapterId;
  connection: AgentConnection;
  continues?: true;
}

/** Every adapter with each way it runs, as the agent chip offers them. */
const CHOICES: readonly Choice[] = CONNECTED_AGENTS.flatMap((adapter) =>
  connectionsOf(adapter).map((connection) => ({ adapter, connection })),
);

/**
 * The agent's adapter and how it runs: its logo and label ("Claude · Terminal") that open a
 * dropdown of the adapters, each with the ways it can run; for a connection that continues its
 * conversation in another (an Agent SDK agent's, in Terminal), first, continuing it there.
 */
export function AgentChip({
  adapter,
  connection,
  onChange,
  onContinueInTerminal,
}: {
  adapter: AdapterId;
  connection: AgentConnection;
  onChange: (adapter: AdapterId, connection: AgentConnection) => void;
  onContinueInTerminal: () => void;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const label = agentLabel(adapter, connection);
  const continueIn =
    connection === 'unavailable'
      ? undefined
      : connectionIn(catalog(), connection)?.connection.continueIn;
  const choices: readonly Choice[] = continueIn
    ? [{ adapter, connection: continueIn.connection, continues: true }, ...CHOICES]
    : CHOICES;
  /** A connection is explained where its adapter runs more than one way. */
  const detail = (one: Choice) =>
    connectionsOf(one.adapter).length > 1 ? connectionInfo(one.connection).description : undefined;
  return (
    <div className="graph-agent-chip">
      <button
        ref={button}
        type="button"
        data-agent={adapter}
        data-connection={connection}
        aria-label={`Agent: ${label}`}
        aria-expanded={open}
        title={detail({ adapter, connection })}
        onClick={() => {
          setOpen(!open);
        }}
      >
        <AdapterLogo adapter={adapter} size={16} />
        {label}
      </button>
      {open && (
        <SearchPicker
          label="Agent"
          options={choices}
          optionLabel={(choice) =>
            choice.continues
              ? 'Continue in Terminal'
              : agentLabel(choice.adapter, choice.connection)
          }
          optionDetail={(choice) =>
            choice.continues ? 'This conversation, in Claude Code’s own terminal' : detail(choice)
          }
          optionKey={(choice) =>
            choice.continues ? 'continue' : `${choice.adapter}/${choice.connection}`
          }
          onPick={(choice) => {
            if (choice.continues) onContinueInTerminal();
            else onChange(choice.adapter, choice.connection);
            setOpen(false);
            button.current?.focus();
          }}
          onCancel={() => {
            setOpen(false);
            button.current?.focus();
          }}
        />
      )}
    </div>
  );
}
