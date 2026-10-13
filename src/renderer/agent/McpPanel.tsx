import { useEffect, useRef, useState } from 'react';

import type { McpChange, McpServer } from '../../shared/session';
import { ipcErrorMessage } from '../ipc-error';

/**
 * /mcp for an Agent SDK agent, above its composer: its session's MCP servers, each with how it is
 * ("Connected · user · 12 tools", "Failed: Connection refused · project") and what can be done:
 * reconnect, disable, enable, or, for a server that needs the user to sign in, Claude Code's own
 * /mcp in Terminal (the Agent SDK has no way to sign in). Esc or Close closes it.
 */
export function McpPanel({
  list,
  change,
  onSignIn,
  onClose,
}: {
  /** The servers, from main (session:mcp). */
  list: () => Promise<McpServer[]>;
  /** Changes one; resolves with them all as they are then. */
  change: (server: string, change: McpChange) => Promise<McpServer[]>;
  /** Signs in to a server: in Terminal, where Claude Code's /mcp does it. */
  onSignIn: () => void;
  onClose: () => void;
}) {
  const [servers, setServers] = useState<McpServer[]>();
  const [problem, setProblem] = useState<string>();
  /** The server being changed, while it is. */
  const [busy, setBusy] = useState<string>();
  /** Listed once, when it opens. */
  const listed = useRef(list);
  useEffect(() => {
    let current = true;
    listed.current().then(
      (found) => {
        if (current) setServers(found);
      },
      (error: unknown) => {
        if (current) setProblem(ipcErrorMessage(error));
      },
    );
    return () => {
      current = false;
    };
  }, []);

  const act = (server: string, what: McpChange) => {
    setBusy(server);
    setProblem(undefined);
    change(server, what).then(
      (found) => {
        setServers(found);
        setBusy(undefined);
      },
      (error: unknown) => {
        setProblem(ipcErrorMessage(error));
        setBusy(undefined);
      },
    );
  };
  const button = (server: McpServer, what: McpChange, label: string) => (
    <button
      type="button"
      disabled={busy !== undefined}
      onClick={() => {
        act(server.name, what);
      }}
    >
      {label}
    </button>
  );

  return (
    <div
      className="agent-offer agent-mcp"
      role="group"
      aria-label="MCP servers"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        // Only the panel closes, not the view.
        event.stopPropagation();
        onClose();
      }}
    >
      <p>
        <strong>MCP servers</strong>
      </p>
      {problem !== undefined && <p role="alert">{problem}</p>}
      {servers === undefined ? (
        problem === undefined && <p>Looking for its MCP servers…</p>
      ) : servers.length === 0 ? (
        <p>
          No MCP servers yet: add them with <code>claude mcp add</code>, or in the project’s
          .mcp.json.
        </p>
      ) : (
        <ul className="agent-mcp-servers">
          {servers.map((server) => (
            <li key={server.name} aria-label={server.name}>
              <span className="agent-mcp-name" {...(server.server ? { title: server.server } : {})}>
                {server.name}
              </span>
              <span className="agent-mcp-status" data-status={server.status}>
                {status(server)}
              </span>
              <span className="agent-mcp-actions">
                {busy === server.name ? (
                  <span>Working…</span>
                ) : server.status === 'disabled' ? (
                  button(server, 'enable', 'Enable')
                ) : (
                  <>
                    {server.status === 'needs-auth' ? (
                      <button type="button" disabled={busy !== undefined} onClick={onSignIn}>
                        Sign in in Terminal
                      </button>
                    ) : (
                      server.status !== 'pending' && button(server, 'reconnect', 'Reconnect')
                    )}
                    {button(server, 'disable', 'Disable')}
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      <button type="button" autoFocus onClick={onClose}>
        Close
      </button>
    </div>
  );
}

/** How a server is, in a line: "Connected · user · 12 tools". */
function status(server: McpServer): string {
  const how = {
    connected: 'Connected',
    failed: server.error === undefined ? 'Failed' : `Failed: ${server.error}`,
    'needs-auth': 'Needs you to sign in',
    pending: 'Connecting…',
    disabled: 'Disabled',
  }[server.status];
  return [
    how,
    ...(server.scope === undefined ? [] : [server.scope]),
    ...(server.tools === undefined
      ? []
      : [`${String(server.tools)} tool${server.tools === 1 ? '' : 's'}`]),
  ].join(' · ');
}
