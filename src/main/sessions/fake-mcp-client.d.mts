import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

import type { ToolListing } from '../../shared/api/registry';
import type { AgentChannel } from './connector';

/** One test client interface, whichever route its adapter's fake was given. */
export interface FakeMcpClient {
  list(signal?: AbortSignal): Promise<ToolListing[]>;
  call(name: string, args: unknown, signal?: AbortSignal): Promise<CallToolResult>;
  close(): Promise<void>;
}
export function connectChannel(channel: AgentChannel): FakeMcpClient;
export function connectHttp(
  route: { url: string; token: string },
  options?: { fetch?: typeof globalThis.fetch; signal?: AbortSignal },
): Promise<FakeMcpClient>;

/** Uses the delivered low-level MCP server instance through its native MCP transport. */
// eslint-disable-next-line @typescript-eslint/no-deprecated -- The adapter's SDK entry is the low-level server instance, not the high-level wrapper.
export function connectServer(server: Server): Promise<FakeMcpClient>;
