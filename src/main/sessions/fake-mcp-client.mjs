import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// Shared by fake agents: real MCP requests over their delivered HTTP route or bound channel.
// No native configuration, credentials on disk, caller construction or operation table lives here.
const TIMEOUT = 10_000;

/** Exercises the same MCP initialization and requests against the delivered server instance. */
export async function connectServer(server) {
  const [local, remote] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'corrallm-fake-agent', version: '1.0.0' });
  await server.connect(remote);
  try {
    await client.connect(local, { timeout: TIMEOUT });
  } catch (error) {
    await client.close();
    await server.close();
    throw error;
  }
  return methods(client, async () => {
    await client.close();
    await server.close();
  });
}

/** The in-process route is already bound by its owner; closing this client revokes nothing. */
export function connectChannel(channel) {
  let closed = false;
  const open = () => {
    if (closed) throw new Error('The fake MCP client is closed.');
  };
  return {
    async list(signal) {
      open();
      signal?.throwIfAborted();
      return channel.list();
    },
    async call(name, args, signal = new AbortController().signal) {
      open();
      signal.throwIfAborted();
      return channel.call(name, args, signal);
    },
    async close() {
      closed = true;
    },
  };
}

/** A fake reads its own native configuration and gives this helper only the delivered route. */
export async function connectHttp(
  { url: raw, token },
  { fetch: fetcher = globalThis.fetch, signal } = {},
) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('A fake MCP client needs a loopback /mcp URL.');
  }
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    url.pathname !== '/mcp' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    raw.includes('?') ||
    raw.includes('#')
  ) {
    throw new Error('A fake MCP client needs a loopback /mcp URL.');
  }
  const client = new Client({ name: 'corrallm-fake-agent', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${token}` }, redirect: 'error' },
    fetch: (input, init) => fetcher(input, { ...init, redirect: 'error' }),
    reconnectionOptions: {
      initialReconnectionDelay: 0,
      maxReconnectionDelay: 0,
      reconnectionDelayGrowFactor: 1,
      maxRetries: 0,
    },
  });
  try {
    await client.connect(transport, { timeout: TIMEOUT, ...(signal ? { signal } : {}) });
  } catch (error) {
    await client.close();
    throw error;
  }
  return methods(client);
}

function methods(client, close = () => client.close()) {
  return {
    async list(signal) {
      const result = await client.listTools(undefined, {
        timeout: TIMEOUT,
        ...(signal ? { signal } : {}),
      });
      return result.tools;
    },
    call(name, args, signal) {
      return client.callTool({ name, arguments: args }, undefined, {
        timeout: TIMEOUT,
        ...(signal ? { signal } : {}),
      });
    },
    close,
  };
}
