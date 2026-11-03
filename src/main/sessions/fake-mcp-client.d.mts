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

/** A fake's scripted calls for a turn (FAKE_MCP_SCRIPT); resolves with its rule's reply. */
export function scriptedTurn(
  client: FakeMcpClient | undefined,
  text: string,
): Promise<string | undefined>;
/** One more call as a fake's session closes, logged to FAKE_MCP_LOG. */
export function closingCall(client: FakeMcpClient | undefined): Promise<void>;
/** Logs that a fake connected, naming its credential only by a short hash. */
export function logConnected(token: string): void;
/** Appends a line to FAKE_MCP_LOG, if the test gave one. */
export function logScripted(entry: Record<string, unknown>): void;

/** Uses the delivered low-level MCP server instance through its native MCP transport. */
// eslint-disable-next-line @typescript-eslint/no-deprecated -- The adapter's SDK entry is the low-level server instance, not the high-level wrapper.
export function connectServer(server: Server): Promise<FakeMcpClient>;
