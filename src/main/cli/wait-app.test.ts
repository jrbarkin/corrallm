import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { writeApiFile } from '../core/api-file';
import type * as HostNode from '../core/host/node';
import { processStart } from '../core/lock';
import { waitCommand } from './wait';

/*
 * A pin (B30 L4, expected green): with no CORRALLM_URL, `corrallm wait` finds the corrallm that
 * owns the app's profile through that profile's api.json, whichever process wrote it (the app's
 * core serves the same file `serve` does), and sends the token there.
 */

const mocks = vi.hoisted(() => ({ profile: '' }));
vi.mock('../core/host/node', async (original) => ({
  ...(await original<typeof HostNode>()),
  appProfile: () => mocks.profile,
}));

let server: Server | undefined;
let sent: string[];

beforeEach(async () => {
  mocks.profile = await mkdtemp(path.join(tmpdir(), 'corrallm-wait-app-'));
  sent = [];
});
afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (server === undefined) resolve();
    else
      server.close(() => {
        resolve();
      });
  });
  server = undefined;
  await rm(mocks.profile, { recursive: true, force: true });
});

it('finds the app’s server through api.json when no URL is given, and exits 1 at its time limit', async () => {
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
  await writeApiFile(mocks.profile, {
    url: `http://127.0.0.1:${String(port)}/mcp`,
    port,
    pid: process.pid,
    started: processStart(),
  });
  const printed: string[] = [];
  const exit = await waitCommand(
    { command: 'wait', timeout: 1 },
    { env: { CORRALLM_OUTSIDE_TOKEN: 'A'.repeat(43) }, print: (line) => printed.push(line) },
  );
  expect(exit).toBe(1);
  expect(sent[0]).toBe(`Bearer ${'A'.repeat(43)}`);
  expect(printed).toHaveLength(1);
});

it('says no server runs when the app’s profile has no api.json', async () => {
  const printed: string[] = [];
  const exit = await waitCommand(
    { command: 'wait', timeout: 1 },
    { env: { CORRALLM_OUTSIDE_TOKEN: 'A'.repeat(43) }, print: (line) => printed.push(line) },
  );
  expect(exit).not.toBe(1);
  expect(printed.join('\n')).toContain('No corrallm server runs on the app’s profile');
});
