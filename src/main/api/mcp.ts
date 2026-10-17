import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { StreamableHTTPServerTransportOptions } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

import { OPERATIONS, operationsFor } from './operations';
import type { Api, Scope } from './operations';

const MAX_BODY = 1024 * 1024;

export interface ApiClient {
  name: string;
  scope: Scope;
}

export interface ApiServerOptions {
  api: Api;
  /** Who a bearer token belongs to, or undefined for none. */
  clientOf: (token: string) => ApiClient | undefined;
  /** 0 for any free port. */
  port: number;
}

export interface ApiServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

/** Serves the API as MCP tools, each request under the scope its token gives it. */
export async function startApiServer(options: ApiServerOptions): Promise<ApiServer> {
  const transports = new Set<StreamableHTTPServerTransport>();
  let port = options.port;
  let closing: Promise<void> | undefined;
  const http = createServer((request, response) => {
    const refuse = (status: number) => {
      request.resume();
      response.writeHead(status).end();
    };
    if (request.url !== '/mcp') {
      refuse(404);
      return;
    }
    const token = /^Bearer (\S+)$/.exec(request.headers.authorization ?? '')?.[1];
    const client = token === undefined ? undefined : options.clientOf(token);
    if (client === undefined) {
      refuse(401);
      return;
    }
    if (closing) {
      refuse(503);
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-deprecated -- Tools use the low-level server.
    const server = new Server({ name: 'corrallm', version: '1' }, { capabilities: { tools: {} } });
    // The SDK's optional properties do not allow explicit undefined in its types.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      allowedHosts: [`127.0.0.1:${String(port)}`, `localhost:${String(port)}`],
      enableDnsRebindingProtection: true,
      maxRequestBodySize: MAX_BODY,
    } as unknown as StreamableHTTPServerTransportOptions);
    const operations = operationsFor(client.scope);
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: operations
        .filter((operation) => operation.listed)
        .map((operation) => ({
          name: operation.name,
          description: operation.description,
          inputSchema: operation.input,
        })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async ({ params }, { signal }) => {
      if (!operations.some((operation) => operation.name === params.name)) {
        throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${params.name}.`);
      }
      try {
        const result = await call(options.api, client.name, params.name, params.arguments, signal);
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          ...(result === null ? {} : { structuredContent: { ...result } }),
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
        };
      }
    });
    transports.add(transport);
    // The response closes when the client leaves, not when its request body finishes.
    response.once('close', () => {
      transports.delete(transport);
      void transport.close();
    });
    void server
      .connect(transport as Transport)
      .then(() => transport.handleRequest(request, response))
      .catch(() => {
        if (!response.headersSent) response.writeHead(500).end();
        else response.destroy();
      });
  });
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(options.port, '127.0.0.1', resolve);
  });
  port = (http.address() as AddressInfo).port;

  async function close(): Promise<void> {
    const closed = new Promise<void>((resolve, reject) => {
      http.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    await Promise.all([...transports].map((transport) => transport.close()));
    http.closeAllConnections();
    await closed;
  }

  return {
    url: `http://127.0.0.1:${String(port)}/mcp`,
    port,
    close: () => (closing ??= close()),
  };
}

async function call(api: Api, from: string, name: string, args: unknown, signal: AbortSignal) {
  switch (name) {
    case 'message':
      return api.message(from, OPERATIONS.message.parse(args));
    case 'reply':
      return api.reply(from, OPERATIONS.reply.parse(args));
    case 'status':
      OPERATIONS.status.parse(args);
      return api.status(from);
    case 'wait':
      return api.wait(from, OPERATIONS.wait.parse(args), signal);
    default:
      throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}.`);
  }
}
