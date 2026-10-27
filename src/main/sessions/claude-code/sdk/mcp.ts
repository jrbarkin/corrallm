import type { McpServerStatus } from '@anthropic-ai/claude-agent-sdk';

import type { McpServer } from '../../../../shared/session';

/*
 * What corrallm shows of a session's MCP servers: how each is (/mcp). The forms a server asks the
 * user to fill in are read by the shared flat-form reader (src/shared/model/prompt-forms.ts),
 * through raise.ts.
 */

/** A server, as /mcp lists it. */
export function mcpServer(status: McpServerStatus): McpServer {
  const info = status.serverInfo;
  return {
    name: status.name,
    status: status.status,
    ...(status.scope === undefined || status.scope === '' ? {} : { scope: status.scope }),
    ...(info === undefined ? {} : { server: `${info.name} ${info.version}`.trim() }),
    ...(status.status === 'connected' && status.tools !== undefined
      ? { tools: status.tools.length }
      : {}),
    ...(status.error === undefined || status.error === '' ? {} : { error: status.error }),
  };
}
