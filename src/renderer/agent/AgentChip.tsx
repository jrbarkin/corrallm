import { useRef, useState } from 'react';

import { connectionIn } from '../../shared/adapter';
import type { AdapterId } from '../../shared/adapter';
import { adapterAccent, catalog } from '../catalog';
import { AdapterLogo } from '../AdapterLogo';
import { continuationOf } from './commands';
import { agentLabel, connectedAgents, connectionInfo, connectionsOf } from '../graph/agents';
import type { AgentConnection } from '../graph/agents';
import { ChainControl } from './Fallback';
import { SearchPicker } from '../search/SearchPicker';

/** A choice in the agent chip: an adapter and how it runs, or continuing the conversation. */
interface Choice {
  adapter: AdapterId;
  connection: AgentConnection;
  continues?: true;
}

/**
 * The agent's adapter and how it runs: its logo and label (adapter and connection) that open a
 * dropdown of the adapters, each with the ways it can run; for a connection that continues its
 * conversation in another (its `continueIn`), first, continuing it there, naming where.
 */
export function AgentChip({
  adapter,
  connection,
  agentId,
  initiallyOpen = false,
  onChange,
  onContinue,
}: {
  agentId?: string;
  adapter: AdapterId | undefined;
  connection: AgentConnection | undefined;
  initiallyOpen?: boolean;
  onChange: (adapter: AdapterId, connection: AgentConnection) => void;
  /** Continues there; `request` is this offer's id, the same for a retry of it. */
  onContinue: (request: string) => void;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const button = useRef<HTMLButtonElement>(null);
  /** The request id of the continuation offered while the picker is open. */
  const request = useRef<string>(undefined);
  const label = agentLabel(adapter, connection);
  const continueIn =
    connection === undefined
      ? undefined
      : connectionIn(catalog(), connection)?.connection.continueIn;
  /** Where it continues, if that connection is there to continue in. */
  const target = continuationOf(connection);
  const offered = connectedAgents().flatMap((adapter) =>
    connectionsOf(adapter).map((connection) => ({ adapter, connection })),
  );
  const choices: readonly Choice[] =
    continueIn && target && adapter !== undefined
      ? [{ adapter, connection: continueIn.connection, continues: true }, ...offered]
      : offered;
  /** A connection is explained where its adapter runs more than one way. */
  const detail = (one: Choice) =>
    connectionsOf(one.adapter).length > 1 ? connectionInfo(one.connection).description : undefined;
  return (
    <div className="graph-agent-chip">
      <button
        ref={button}
        type="button"
        data-agent={adapter}
        data-accent={adapterAccent(adapter)}
        data-connection={connection}
        aria-label={`Agent: ${label}`}
        aria-expanded={open}
        title={
          adapter !== undefined && connection !== undefined
            ? detail({ adapter, connection })
            : undefined
        }
        onClick={() => {
          if (!open) request.current = crypto.randomUUID();
          setOpen(!open);
        }}
      >
        <AdapterLogo adapter={adapter} size={16} />
        {label}
      </button>
      {agentId && <ChainControl agent={agentId} />}
      {open && (
        <SearchPicker
          label="Agent"
          options={choices}
          optionLabel={(choice) =>
            choice.continues
              ? `Continue in ${target?.label ?? ''}`
              : agentLabel(choice.adapter, choice.connection)
          }
          optionDetail={(choice) =>
            choice.continues
              ? target?.view === 'terminal'
                ? 'Continue this conversation with the agent’s own terminal'
                : `Continue this conversation through ${target?.label ?? ''}`
              : detail(choice)
          }
          optionKey={(choice) =>
            choice.continues ? 'continue' : `${choice.adapter}/${choice.connection}`
          }
          onPick={(choice) => {
            if (choice.continues) onContinue(request.current ?? crypto.randomUUID());
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
