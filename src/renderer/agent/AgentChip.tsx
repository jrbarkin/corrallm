import { useRef, useState } from 'react';

import { AGENT_CONNECTIONS, AgentType, agentLabel, CONNECTION_INFO } from '../graph/agents';
import type { AgentConnection } from '../graph/agents';
import { SearchPicker } from '../search/SearchPicker';

/** A choice in the agent chip: a type and how it runs, or continuing the conversation in Terminal. */
interface Choice {
  agent: AgentType;
  connection: AgentConnection;
  continues?: true;
}

/** Every agent type with each way it runs, as the agent chip offers them. */
const CHOICES: readonly Choice[] = Object.values(AgentType).flatMap((agent) =>
  AGENT_CONNECTIONS[agent].map((connection) => ({ agent, connection })),
);

/**
 * The agent's type and how it runs: a colour-coded chip ("Claude · Terminal") that opens a dropdown
 * of the agent types, each with the ways it can run; for an Agent SDK agent, first, continuing its
 * conversation in Terminal.
 */
export function AgentChip({
  agent,
  connection,
  onChange,
  onContinueInTerminal,
}: {
  agent: AgentType;
  connection: AgentConnection;
  onChange: (agent: AgentType, connection: AgentConnection) => void;
  onContinueInTerminal: () => void;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const label = agentLabel(agent, connection);
  const choices: readonly Choice[] =
    connection === 'sdk'
      ? [{ agent, connection: 'terminal', continues: true }, ...CHOICES]
      : CHOICES;
  return (
    <div className="graph-agent-chip">
      <button
        ref={button}
        type="button"
        data-agent={agent}
        data-connection={connection}
        aria-label={`Agent: ${label}`}
        aria-expanded={open}
        title={
          AGENT_CONNECTIONS[agent].length > 1 ? CONNECTION_INFO[connection].description : undefined
        }
        onClick={() => {
          setOpen(!open);
        }}
      >
        {label}
      </button>
      {open && (
        <SearchPicker
          label="Agent"
          options={choices}
          optionLabel={(choice) =>
            choice.continues ? 'Continue in Terminal' : agentLabel(choice.agent, choice.connection)
          }
          optionDetail={(choice) =>
            choice.continues
              ? 'This conversation, in Claude Code’s own terminal'
              : AGENT_CONNECTIONS[choice.agent].length > 1
                ? CONNECTION_INFO[choice.connection].description
                : undefined
          }
          optionKey={(choice) =>
            choice.continues ? 'continue' : `${choice.agent}/${choice.connection}`
          }
          onPick={(choice) => {
            if (choice.continues) onContinueInTerminal();
            else onChange(choice.agent, choice.connection);
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
