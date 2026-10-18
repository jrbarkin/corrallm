import { createServer } from 'node:http';
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { StreamableHTTPServerTransportOptions } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import type { OpResult } from '../../shared/api/errors';
import { MAX_REQUEST_BYTES } from '../../shared/api/limits';
import { opsFor, toolName, toolOf } from '../../shared/api/registry';
import type { ToolListing } from '../../shared/api/registry';
import type { Dispatcher } from '../core/call';
import { isTokenCaller } from '../core/caller';
import type { Caller, TokenCaller } from '../core/caller';
import { foreignRequest } from '../loopback';

/*
 * corrallm's agents' server: MCP over streamable HTTP on 127.0.0.1, generated from the registry
 * (Core Server §3.3). One tool per operation, listed to each caller by its party, and every call
 * goes through core.call, so the server adds nothing of its own: a tool missing from a caller's
 * list is refused when called anyway, by the same audience check. A bearer token names the caller:
 * an agent's session, or an outside orchestrator a person made a token for, never you. Stateless,
 * with a fresh server per request, so a caller's party is read on every request.
 *
 * Before the token, in this order (API Spec §8.2): a Host other than its own, and any Origin
 * header, get 403 (a page in a browser: loopback.ts), and a body that isn't exactly JSON 415. The
 * body is read here, capped at MAX_REQUEST_BYTES, the bound every op's arguments fit.
 */

/** How far a body over MAX_REQUEST_BYTES is still read, for its answer to reach the client. */
const MAX_DRAIN = 2 * MAX_REQUEST_BYTES;
const TOO_LARGE = Symbol('too large');

/** What a client sees first: they stand alone in 512 characters, all some clients read of them. */
export const INSTRUCTIONS =
  'corrallm runs coding agents on canvases, each in its canvas’s project folder. Each tool is ' +
  'one corrallm operation, the same the corrallm window uses, and your token decides which you ' +
  'see; only its user may do the rest. Agents and canvases are named by their ids, never by ' +
  'paths. A failed call answers isError: its first text is a sentence saying why, its second ' +
  '{"error":{"code","sentence"}} as JSON. Read-only tools change nothing; destructive ones ' +
  'remove, discard or interrupt.';

export interface ApiServerOptions {
  /** The operations it serves. */
  core: Dispatcher;
  /** Who a bearer token belongs to: an agent's session or an outside token, or undefined. */
  clientOf: (token: string) => TokenCaller | undefined;
  /** 0 for any free port. */
  port: number;
}

export interface ApiServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

/** The tools `caller` sees: the operations its party may call now, as MCP lists them. */
export function listTools(core: Dispatcher, caller: Caller): ToolListing[] {
  return opsFor(core.surface, core.partyOf(caller)).flatMap((name) => {
    const def = core.ops[name];
    const surface = core.surface[name];
    return def && surface ? [toolOf(name, def, surface)] : [];
  });
}

/**
 * Calls tool `tool` as `caller`, through core.call: its result as JSON text and structured
 * content, or its error as `isError`, with no structured content (the SDK's client would check it
 * against the tool's outputSchema, and lose the error to a schema mismatch).
 */
export async function callTool(
  core: Dispatcher,
  caller: Caller,
  tool: string,
  args: unknown,
  signal?: AbortSignal,
): Promise<CallToolResult> {
  const name = Object.keys(core.surface).find((op) => toolName(op) === tool);
  const result: OpResult<unknown> =
    name === undefined
      ? { ok: false, error: { code: 'not-found', sentence: `There is no tool named ${tool}.` } }
      : await core.call(name, args, caller, signal);
  if (!result.ok) {
    return {
      isError: true,
      content: [
        { type: 'text', text: result.error.sentence },
        { type: 'text', text: JSON.stringify({ error: result.error }) },
      ],
    };
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(result.value) }],
    structuredContent: result.value as Record<string, unknown>,
  };
}

/** Serves the core's operations as MCP tools, each request as the caller its token names. */
export async function startApiServer(options: ApiServerOptions): Promise<ApiServer> {
  const transports = new Set<StreamableHTTPServerTransport>();
  let closing: Promise<void> | undefined;
  const http = createServer((request, response) => {
    const refuse = (status: number) => {
      request.resume();
      response.writeHead(status).end();
    };
    const foreign = foreignRequest(request);
    if (foreign !== undefined) {
      request.resume();
      answerError(response, 403, -32000, foreign);
      return;
    }
    if (request.url !== '/mcp') {
      refuse(404);
      return;
    }
    if (request.method === 'POST' && !isJson(request.headers['content-type'])) {
      request.resume();
      answerError(
        response,
        415,
        -32000,
        'Unsupported Media Type: the body must be application/json',
      );
      return;
    }
    const token = /^Bearer (\S+)$/.exec(request.headers.authorization ?? '')?.[1];
    const caller = token === undefined ? undefined : options.clientOf(token);
    // No token is ever you (decision 7), whatever its lookup says.
    if (caller === undefined || !isTokenCaller(caller)) {
      refuse(401);
      return;
    }
    if (closing) {
      refuse(503);
      return;
    }
    if (request.method !== 'POST') {
      serve(caller, request, response);
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
        const message = `Payload Too Large: Request body must not exceed ${String(MAX_REQUEST_BYTES)} bytes`;
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
      serve(caller, request, response, parsed);
    });
  });
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(options.port, '127.0.0.1', resolve);
  });
  const { port } = http.address() as AddressInfo;

  /** Answers a request on a transport of its own, as its caller. */
  function serve(
    caller: TokenCaller,
    request: IncomingMessage,
    response: ServerResponse,
    parsedBody?: unknown,
  ) {
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- Tools use the low-level server.
    const server = new Server(
      { name: 'corrallm', version: '1' },
      { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
    );
    // The SDK's optional properties do not allow explicit undefined in its types.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    } as unknown as StreamableHTTPServerTransportOptions);
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: listTools(options.core, caller),
    }));
    server.setRequestHandler(CallToolRequestSchema, ({ params }, { signal }) =>
      callTool(options.core, caller, params.name, params.arguments, signal),
    );
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

/** Whether a media type is exactly JSON (in UTF-8, if it names a charset). */
function isJson(contentType: string | undefined): boolean {
  if (contentType === undefined) return false;
  const [type, ...parameters] = contentType.split(';').map((part) => part.trim().toLowerCase());
  return type === 'application/json' && parameters.every((p) => p === 'charset=utf-8');
}

/**
 * Reads a request's body as text, or TOO_LARGE for one over MAX_REQUEST_BYTES, which is still read
 * to its end (keeping none of it) unless it goes on past MAX_DRAIN: then the connection is dropped.
 * Undefined if the request closes before its end.
 */
function readBody(request: IncomingMessage): Promise<string | typeof TOO_LARGE | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_REQUEST_BYTES) chunks.push(chunk);
      else if (size > MAX_DRAIN) request.destroy();
    });
    request.once('end', () => {
      // Decoded as the transport decodes it (a byte order mark goes).
      resolve(
        size > MAX_REQUEST_BYTES ? TOO_LARGE : new TextDecoder().decode(Buffer.concat(chunks)),
      );
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
