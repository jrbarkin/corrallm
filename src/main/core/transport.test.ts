import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { OpError, OpResult } from '../../shared/api/errors';
import { toolName } from '../../shared/api/registry';
import { GUI_OPS } from '../../shared/api/surface';
import type { Party } from '../../shared/api/surface';
import { callTool, startApiServer } from '../api/mcp';
import type { ApiServer } from '../api/mcp';
import { createDispatcher } from './call';
import type { Dispatcher } from './call';
import type { TokenCaller } from './caller';
import { WindowPorts } from './gui';
import {
  CALLERS,
  isLead,
  RESOLVERS,
  TEST_FIXTURES,
  TEST_OUT_OF_REACH,
  testRegistry,
} from './test-registry';
import type { OpFixture, OutOfReach } from './test-registry';
import { openWindow } from './test-window';
import { REAL_FIXTURES, REAL_OUT_OF_REACH, startWorld } from './test-world';
import { transportCases } from './test-transport';

/*
 * T3a (Core Server §3.7): each transport adds nothing. A transport is factored as identify (who
 * calls) and dispatch (what the call answers); every op's fixtures are called through each
 * transport's dispatch half with the same synthetic caller (you, then each party), and must answer
 * byte for byte as core.call does directly. MCP is also driven end to end, over HTTP, for every
 * caller a token can be, and a window's port (core/gui.ts) for you, whose window it is. B21 adds the
 * Agent SDK's in-process server and Codex's dynamic tools.
 */

const TOKENS: Readonly<Partial<Record<Party, string>>> = {
  lead: 'lead-token',
  worker: 'worker-token',
  'outside-read': 'read-token',
  'outside-write': 'write-token',
};
const partyOfToken = (token: string) =>
  (Object.keys(TOKENS) as Party[]).find((party) => TOKENS[party] === token);

/** A tool's answer as core.call's: what MCP carries, read back. */
function unwrap(result: CallToolResult): OpResult<unknown> {
  if (result.isError === true) {
    const [sentence, error] = result.content as { type: string; text: string }[];
    const parsed = JSON.parse(error?.text ?? '') as { error: OpError };
    expect(sentence?.text).toBe(parsed.error.sentence);
    expect(result).not.toHaveProperty('structuredContent');
    return { ok: false, error: parsed.error };
  }
  const [text] = result.content as { type: string; text: string }[];
  expect(text?.text).toBe(JSON.stringify(result.structuredContent));
  return { ok: true, value: result.structuredContent };
}

interface Setup {
  core: Dispatcher;
  close(): Promise<void>;
}

const REGISTRIES: [
  string,
  Readonly<Record<string, OpFixture>>,
  OutOfReach,
  () => Promise<Setup>,
][] = [
  ['the registry', REAL_FIXTURES, REAL_OUT_OF_REACH, startWorld],
  [
    'the test registry',
    TEST_FIXTURES,
    TEST_OUT_OF_REACH,
    () => {
      let now = 0;
      const core = createDispatcher(testRegistry(), {
        isLead,
        resolvers: RESOLVERS,
        check: true,
        now: () => (now += 1000),
      });
      return Promise.resolve({ core, close: () => Promise.resolve() });
    },
  ],
];

describe.each(REGISTRIES)('T3a on %s', (_label, fixtures, world, start) => {
  let setup: Setup;
  let server: ApiServer | undefined;
  const clients = new Map<Party, Client>();

  beforeAll(async () => {
    setup = await start();
  });

  // Dispatch parity does not need a listening socket. Open HTTP only for its own cases.
  async function http(): Promise<void> {
    if (server !== undefined) return;
    server = await startApiServer({
      core: setup.core,
      clientOf: (token) => {
        const party = partyOfToken(token);
        return party === undefined ? undefined : (CALLERS[party] as TokenCaller);
      },
      port: 0,
    });
    for (const [party, token] of Object.entries(TOKENS) as [Party, string][]) {
      const client = new Client({ name: 'test', version: '1' });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(server.url), {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
        }),
      );
      await client.listTools();
      clients.set(party, client);
    }
  }

  afterAll(async () => {
    for (const client of clients.values()) await client.close();
    await server?.close();
    await setup.close();
  });

  it.each(Object.entries(fixtures))(
    'answers %s through MCP’s dispatch as directly, for every caller',
    async (name, fixture) => {
      for (const { party, args } of transportCases(setup.core, name, fixture, world)) {
        const direct = await setup.core.call(name, args, CALLERS[party]);
        const mcp = unwrap(await callTool(setup.core, CALLERS[party], toolName(name), args));
        expect(JSON.stringify(mcp), `${party}: ${JSON.stringify(args)}`).toBe(
          JSON.stringify(direct),
        );
      }
    },
  );

  it.each(Object.entries(fixtures))(
    'answers %s over HTTP as directly, for every caller a token can be',
    async (name, fixture) => {
      await http();
      // MCP carries arguments as an object, or none.
      const sendable = transportCases(setup.core, name, fixture, world, [...clients.keys()]).filter(
        ({ args }) =>
          args === undefined || (typeof args === 'object' && args !== null && !Array.isArray(args)),
      );
      for (const { party, args } of sendable) {
        const client = clients.get(party);
        if (!client) throw new Error(`No client for ${party}`);
        const direct = await setup.core.call(name, args, CALLERS[party]);
        const result = await client.callTool({
          name: toolName(name),
          ...(args === undefined ? {} : { arguments: args as Record<string, unknown> }),
        });
        expect(
          JSON.stringify(unwrap(result as CallToolResult)),
          `${party}: ${JSON.stringify(args)}`,
        ).toBe(JSON.stringify(direct));
      }
    },
  );
});

describe('T3a on a window’s port', () => {
  let setup: Setup;
  let window: ReturnType<typeof openWindow>;

  beforeAll(async () => {
    setup = await startWorld();
    // The world's you is at window 1.
    window = openWindow(new WindowPorts(setup.core), 1);
  });

  afterAll(async () => {
    window.close();
    await setup.close();
  });

  it.each(GUI_OPS)('answers %s through a window’s port as directly, for you', async (name) => {
    for (const { args } of transportCases(
      setup.core,
      name,
      REAL_FIXTURES[name],
      REAL_OUT_OF_REACH,
      ['you'],
    )) {
      const direct = await setup.core.call(name, args, CALLERS.you);
      const answer = await window.link.request('call', name, args);
      expect(answer.ok).toBe(true);
      expect(JSON.stringify(answer.ok && answer.value), JSON.stringify(args)).toBe(
        JSON.stringify(direct),
      );
    }
  });
});
