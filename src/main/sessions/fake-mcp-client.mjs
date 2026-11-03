import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';

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

/*
 * A fake agent's scripted calls (B21 C7), the same for every fake: FAKE_MCP_SCRIPT names a JSON
 * file a test writes, `{ rules: [{ when, calls: [{ tool, args }], reply?, once? }] }`. As a turn
 * starts, each rule whose `when` its text contains makes its calls, in order, over the route the
 * fake connected, and its `reply` (if any) is the turn's reply; a rule with `once` fires once per
 * process. In a call's arguments `{task}` is the attempt a step's text names (its `task "<id>"`),
 * `{ask}` the question a framed question names (`question <id>`), and `{message}` the message a
 * framed message names: each the last one this fake has seen, so a continuation can still name
 * its task. FAKE_MCP_LOG, a file of the test's own, gets one line per call (its rule, tool and
 * outcome: whether it was refused, and its structured result or refusal text), and one as the
 * fake connects naming a hash of its credential, so a test can tell generations apart: never the
 * credential itself.
 */
const seen = {};
const fired = new Set();
const ID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const PATTERNS = {
  task: new RegExp(`task "${ID}"`),
  ask: new RegExp(`question ${ID}\\)`),
  message: new RegExp(`message ${ID}`),
};

/** Appends a line to FAKE_MCP_LOG, if the test gave one. */
export function logScripted(entry) {
  const file = process.env.FAKE_MCP_LOG;
  if (file) appendFileSync(file, `${JSON.stringify({ pid: process.pid, ...entry })}\n`);
}

/** Logs that a fake connected over http, naming its credential only by a short hash. */
export function logConnected(token) {
  logScripted({
    event: 'connected',
    credential: createHash('sha256').update(token).digest('hex').slice(0, 16),
  });
}

function fill(value) {
  if (typeof value === 'string')
    return value.replace(/\{(task|ask|message)\}/g, (whole, name) => seen[name] ?? whole);
  if (Array.isArray(value)) return value.map(fill);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, one]) => [key, fill(one)]));
  return value;
}

/**
 * Makes the scripted calls for a turn whose text is `text`, through `client` (undefined: the fake
 * has no route, and each call is logged as such). Resolves with the reply its rule gives, if any.
 */
export async function scriptedTurn(client, text) {
  for (const [name, pattern] of Object.entries(PATTERNS)) {
    const found = pattern.exec(text)?.[1];
    if (found !== undefined) seen[name] = found;
  }
  const file = process.env.FAKE_MCP_SCRIPT;
  if (!file) return undefined;
  const { rules = [] } = JSON.parse(readFileSync(file, 'utf8'));
  let reply;
  for (const [index, rule] of rules.entries()) {
    if (!text.includes(rule.when) || (rule.once && fired.has(index))) continue;
    fired.add(index);
    for (const { tool, args = {} } of rule.calls ?? []) {
      if (client === undefined) {
        logScripted({ when: rule.when, tool, ok: false, error: 'no route' });
        continue;
      }
      try {
        const result = await client.call(tool, fill(args));
        logScripted({
          when: rule.when,
          tool,
          ok: result.isError !== true,
          ...(result.isError === true
            ? { error: result.content?.map((part) => part.text ?? '').join('') }
            : { result: result.structuredContent }),
        });
      } catch (error) {
        logScripted({ when: rule.when, tool, ok: false, error: String(error?.message ?? error) });
      }
    }
    if (rule.reply !== undefined) reply ??= fill(rule.reply);
  }
  return reply;
}

/** As a fake's session closes: one more call, logged, which a revoked credential can't make. */
export async function closingCall(client) {
  if (client === undefined) return;
  try {
    const result = await client.call('agents', {}, AbortSignal.timeout(2000));
    logScripted({ event: 'closing', ok: result.isError !== true });
  } catch (error) {
    logScripted({ event: 'closing', ok: false, error: String(error?.message ?? error) });
  }
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
