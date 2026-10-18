import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { OpError, OpResult } from '../../shared/api/errors';
import { toolName } from '../../shared/api/registry';
import { PARTIES } from '../../shared/api/surface';
import type { Party } from '../../shared/api/surface';
import { callTool, startApiServer } from '../api/mcp';
import type { ApiServer } from '../api/mcp';
import { createDispatcher } from './call';
import type { Dispatcher } from './call';
import type { TokenCaller } from './caller';
import { createCore } from './core';
import {
  CALLERS,
  isLead,
  NO_DESKTOP,
  REAL_FIXTURES,
  RESOLVERS,
  TEST_FIXTURES,
  testRegistry,
} from './test-registry';
import type { OpFixture } from './test-registry';

/*
 * T3a (Core Server §3.7): each transport adds nothing. A transport is factored as identify (who
 * calls) and dispatch (what the call answers); every op's fixtures are called through each
 * transport's dispatch half with the same synthetic caller (you, then each party), and must answer
 * byte for byte as core.call does directly. MCP is also driven end to end, over HTTP, for every
 * caller a token can be. B8 adds a window's port; B21 the Agent SDK's in-process server and Codex's
 * dynamic tools.
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

/** Every argument list a fixture names. */
const argsOf = (fixture: OpFixture): unknown[] => [
  ...fixture.valid,
  ...fixture.invalid,
  ...Object.values(fixture.meetsRule ?? {}),
  ...Object.values(fixture.unreachable ?? {}),
];

interface Setup {
  core: Dispatcher;
  close(): Promise<void>;
}

const REGISTRIES: [string, Readonly<Record<string, OpFixture>>, () => Promise<Setup>][] = [
  [
    'the registry',
    REAL_FIXTURES,
    async () => {
      const profile = await mkdtemp(path.join(tmpdir(), 'corrallm-transport-'));
      const core = await createCore(
        { profile, app: { name: 'corrallm', version: '1.0.0' }, check: true },
        NO_DESKTOP,
      );
      return {
        core,
        close: async () => {
          await core.close();
          await rm(profile, { recursive: true, force: true });
        },
      };
    },
  ],
  [
    'the test registry',
    TEST_FIXTURES,
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

describe.each(REGISTRIES)('T3a on %s', (_label, fixtures, start) => {
  let setup: Setup;
  let server: ApiServer;
  const clients = new Map<Party, Client>();

  beforeAll(async () => {
    setup = await start();
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
        }) as Transport,
      );
      await client.listTools();
      clients.set(party, client);
    }
  });

  afterAll(async () => {
    for (const client of clients.values()) await client.close();
    await server.close();
    await setup.close();
  });

  it.each(Object.entries(fixtures))(
    'answers %s through MCP’s dispatch as directly, for every caller',
    async (name, fixture) => {
      for (const args of argsOf(fixture)) {
        for (const party of PARTIES) {
          const direct = await setup.core.call(name, args, CALLERS[party]);
          const mcp = unwrap(await callTool(setup.core, CALLERS[party], toolName(name), args));
          expect(JSON.stringify(mcp), `${party}: ${JSON.stringify(args)}`).toBe(
            JSON.stringify(direct),
          );
        }
      }
    },
  );

  it.each(Object.entries(fixtures))(
    'answers %s over HTTP as directly, for every caller a token can be',
    async (name, fixture) => {
      // MCP carries arguments as an object, or none.
      const sendable = argsOf(fixture).filter(
        (args) =>
          args === undefined || (typeof args === 'object' && args !== null && !Array.isArray(args)),
      );
      for (const args of sendable) {
        for (const [party, client] of clients) {
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
      }
    },
  );
});
