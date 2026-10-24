import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TOKEN_REPLACED, TOO_MANY_WAITS } from '../../shared/api/errors';
import type { OpError } from '../../shared/api/errors';
import { waitCommand } from './wait';

/*
 * How `corrallm wait` exits on each refusal the server gives (API Spec §8.6): 2 only for its token,
 * so an orchestrator that asks the person for a new token on 2 never does for anything else; 3 for
 * a server that can't take the wait now, so it tries again later; 5 for what the wait asked, so it
 * gives up that cursor or id. serve.test.ts runs it against the real server; here a stand-in
 * answers each refusal as the MCP server words one.
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
    // A passing refusal: it waits again later, keeping its place.
    ['its token’s waits at their limit', { code: 'refused', sentence: TOO_MANY_WAITS }, 3],
    ['another refusal', { code: 'refused', sentence: 'Not that.' }, 5],
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

  it('says a token its server renewed away, revoked or let expire is that, refused with 2', async () => {
    const tokens: string[] = [];
    server = createServer((request, response) => {
      request.resume();
      tokens.push(request.headers.authorization ?? '');
      response.writeHead(401, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32001, message: TOKEN_REPLACED },
          id: null,
        }),
      );
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    const printed: string[] = [];
    const exit = await waitCommand(
      { command: 'wait', timeout: 1 },
      {
        env: {
          CORRALLM_URL: `http://127.0.0.1:${String(port)}/mcp`,
          CORRALLM_OUTSIDE_TOKEN: 'an-old-token',
        },
        print: (line) => printed.push(line),
      },
    );
    expect(exit).toBe(2);
    expect(printed.map((line) => JSON.parse(line) as unknown)).toEqual([
      { error: { code: 'refused', sentence: TOKEN_REPLACED } },
    ]);
    expect(tokens).toEqual(['Bearer an-old-token']);
  });

  describe.skipIf(process.platform === 'win32')('with its token in a file', () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(path.join(tmpdir(), 'corrallm-wait-'));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('reads the token afresh from the file CORRALLM_OUTSIDE_TOKEN_FILE names, only if only you can read it', async () => {
      const sent: string[] = [];
      server = createServer((request, response) => {
        request.resume();
        sent.push(request.headers.authorization ?? '');
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: { content: [], structuredContent: { messages: [], next: 'n' } },
          }),
        );
      });
      await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as { port: number };
      const file = path.join(dir, 'token');
      const first = 'A'.repeat(43);
      const second = 'B'.repeat(43);
      const wait = async () => {
        const printed: string[] = [];
        const exit = await waitCommand(
          { command: 'wait', timeout: 0 },
          {
            env: {
              CORRALLM_URL: `http://127.0.0.1:${String(port)}/mcp`,
              CORRALLM_OUTSIDE_TOKEN_FILE: file,
            },
            print: (line) => printed.push(line),
          },
        );
        return { exit, printed };
      };
      await writeFile(file, `${first}\n`, { mode: 0o600 });
      expect((await wait()).exit).toBe(1);
      // Renewed into the same file: the next wait sends the new one.
      await writeFile(file, `${second}\n`, { mode: 0o600 });
      expect((await wait()).exit).toBe(1);
      expect(sent).toEqual([`Bearer ${first}`, `Bearer ${second}`]);

      // A file others may read is no place for a token: refused, sending nothing, saying why.
      await chmod(file, 0o644);
      const { exit, printed } = await wait();
      expect(exit).toBe(2);
      expect(printed.join('\n')).toMatch(/yours alone/);
      expect(printed.join('\n')).not.toContain(second);
      expect(sent).toHaveLength(2);
    });
  });
});
