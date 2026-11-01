import { expectTypeOf, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import type { ToolListing } from '../../shared/api/registry';
import type { AgentChannel, SessionApi, SessionSpec, ToolGrant } from './connector';

it('keeps session API credentials and bound callbacks at the connector seam', () => {
  expectTypeOf<SessionSpec['api']>().toEqualTypeOf<SessionApi | undefined>();
  expectTypeOf<ToolGrant>().toEqualTypeOf<{ name: string; destructive: boolean }>();
  expectTypeOf<AgentChannel['list']>().toEqualTypeOf<() => ToolListing[]>();
  expectTypeOf<AgentChannel['call']>().toEqualTypeOf<
    (name: string, args: unknown, signal: AbortSignal) => Promise<CallToolResult>
  >();
  expectTypeOf<Extract<SessionApi, { kind: 'http' }>>().toEqualTypeOf<{
    kind: 'http';
    server: 'corrallm';
    url: string;
    token: string;
    tools: readonly ToolGrant[];
    off: readonly string[];
  }>();
  expectTypeOf<Extract<SessionApi, { kind: 'channel' }>>().toEqualTypeOf<{
    kind: 'channel';
    server: 'corrallm';
    channel: AgentChannel;
    tools: readonly ToolGrant[];
    off: readonly string[];
  }>();
});
