import { createServer } from 'node:http';
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
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
// How far a body over MAX_BODY is still read, for its answer to reach the client, before the
// connection is dropped instead.
const MAX_DRAIN = 16 * MAX_BODY;
const TOO_LARGE = Symbol('too large');

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
    // DNS rebinding protection, before anything of the body is read.
    const host = request.headers.host;
    if (host !== `127.0.0.1:${String(port)}` && host !== `localhost:${String(port)}`) {
      request.resume();
      answerError(response, 403, -32000, `Invalid Host header: ${host ?? 'none'}`);
      return;
    }
    if (request.method !== 'POST') {
      serve(client, request, response);
      return;
    }

    // The body is read here, not by the transport: the transport answers a body too large
    // before reading the rest, and the connection then closes under a client still sending,
    // whose reset can lose it the answer.
    void readBody(request).then((body) => {
      if (body === undefined) return;
      if (closing) {
        refuse(503);
        return;
      }
      if (body === TOO_LARGE) {
        const message = `Payload Too Large: Request body must not exceed ${String(MAX_BODY)} bytes`;
        answerError(response, 413, -32000, message, { Connection: 'close' });
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        answerError(response, 400, -32700, 'Parse error: Invalid JSON');
        return;
      }
      serve(client, request, response, parsed);
    });
  });
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(options.port, '127.0.0.1', resolve);
  });
  port = (http.address() as AddressInfo).port;

  /** Answers a request on a transport of its own, under its client's scope. */
  function serve(
    client: ApiClient,
    request: IncomingMessage,
    response: ServerResponse,
    parsedBody?: unknown,
  ) {
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- Tools use the low-level server.
    const server = new Server({ name: 'corrallm', version: '1' }, { capabilities: { tools: {} } });
    // The SDK's optional properties do not allow explicit undefined in its types.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
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
      .then(() => transport.handleRequest(request, response, parsedBody))
      .catch(() => {
        if (!response.headersSent) response.writeHead(500).end();
        else response.destroy();
      });
  }

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

/**
 * Reads a request's body as text, or TOO_LARGE for one over MAX_BODY, which is still read to its
 * end (keeping none of it) unless it goes on past MAX_DRAIN: then the connection is dropped.
 * Undefined if the request closes before its end.
 */
function readBody(request: IncomingMessage): Promise<string | typeof TOO_LARGE | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY) chunks.push(chunk);
      else if (size > MAX_DRAIN) request.destroy();
    });
    request.once('end', () => {
      // Decoded as the transport decodes it (a byte order mark goes).
      resolve(size > MAX_BODY ? TOO_LARGE : new TextDecoder().decode(Buffer.concat(chunks)));
    });
    request.once('close', () => {
      resolve(undefined);
    });
  });
}

/** Answers with a JSON-RPC error, as the transport answers what it refuses. */
function answerError(
  response: ServerResponse,
  status: number,
  code: number,
  message: string,
  headers: OutgoingHttpHeaders = {},
) {
  response
    .writeHead(status, { 'Content-Type': 'application/json', ...headers })
    .end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
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
