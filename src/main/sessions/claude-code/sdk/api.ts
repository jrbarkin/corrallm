import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { AgentChannel } from '../../connector';

/** The host's entry is bound to its generation; neither native arguments nor a credential select it. */
export function channelServer(channel: AgentChannel) {
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- Required by the native SDK entry contract.
  const server = new Server(
    { name: 'corrallm', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: channel.list() }));
  server.setRequestHandler(CallToolRequestSchema, (request, extra) =>
    channel.call(request.params.name, request.params.arguments, extra.signal),
  );
  return server;
}
