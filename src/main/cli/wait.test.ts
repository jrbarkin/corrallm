import { createServer } from 'node:http';
import type { Server } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { TOKEN_REPLACED } from '../../shared/api/errors';
import type { OpError } from '../../shared/api/errors';
import { waitCommand } from './wait';

/*
 * How `corrallm wait` exits on each refusal the server gives (API Spec §8.6): 2 only for its token,
 * so an orchestrator that asks the person for a new token on 2 never does for anything else; 3 for
 * a server that can't wait now; 5 for what the wait asked. serve.test.ts runs it against the real
 * server; here a stand-in answers each refusal as the MCP server words one.
 */

let server: Server | undefined;

afterEach(async () => {
  const stopping = server;
  server = undefined;
  if (stopping) await new Promise((resolve) => stopping.close(resolve));
});

/**
 * A stand-in server whose `wait` fails with `error`, as the MCP server answers a failed op: its
 * URL.
 */
async function refusing(error: OpError): Promise<string> {
  server = createServer((request, response) => {
    request.resume();
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: {
          isError: true,
          content: [
            { type: 'text', text: error.sentence },
            { type: 'text', text: JSON.stringify({ error }) },
          ],
        },
      }),
    );
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return `http://127.0.0.1:${String(port)}/mcp`;
}

describe('corrallm wait', () => {
  it.each<[string, OpError, number]>([
    ['its token replaced while it waited', { code: 'refused', sentence: TOKEN_REPLACED }, 2],
    ['too many waits', { code: 'refused', sentence: 'Too many waits at once.' }, 5],
    ['a cursor it didn’t give', { code: 'invalid', sentence: 'That cursor isn’t one.' }, 5],
    ['a message it doesn’t know', { code: 'not-found', sentence: 'No such message.' }, 5],
    ['a server that can’t wait now', { code: 'unavailable', sentence: 'Not now.' }, 3],
  ])('exits on %s as it should, saying why', async (_what, error, code) => {
    const url = await refusing(error);
    const printed: string[] = [];
    const exit = await waitCommand(
      { command: 'wait', timeout: 1 },
      {
        env: { CORRALLM_URL: url, CORRALLM_OUTSIDE_TOKEN: 'a-token' },
        print: (line) => printed.push(line),
      },
    );
    expect(exit).toBe(code);
    expect(printed.map((line) => JSON.parse(line) as unknown)).toEqual([{ error }]);
  });
});
