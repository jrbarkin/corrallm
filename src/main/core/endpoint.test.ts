import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ApiStatus } from '../../shared/api/ops/settings';
import { Settings } from '../settings';
import { createDispatcher } from './call';
import type { TokenCaller } from './caller';
import { Endpoint } from './endpoint';
import type { EndpointDeps } from './endpoint';
import { CALLERS, isLead, RESOLVERS, testRegistry } from './test-registry';

/*
 * The profile's outside endpoint (B11 Design §9, §16.6), as its owner (the app's core, or
 * `corrallm serve`) runs it: the MCP server on 127.0.0.1, on the port the profile keeps, its every
 * check, and api.json naming this owner, removed only while it is still this owner's.
 */

let profile: string;
let endpoints: Endpoint[];
let squatters: Server[];

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-endpoint-'));
  endpoints = [];
  squatters = [];
});
afterEach(async () => {
  for (const endpoint of endpoints) await endpoint.close();
  for (const squatter of squatters) await new Promise((resolve) => squatter.close(resolve));
  await rm(profile, { recursive: true, force: true });
});

const TOKENS: Readonly<Record<string, TokenCaller>> = {
  'write-token': CALLERS['outside-write'] as TokenCaller,
};

/** An endpoint over the test registry's dispatcher, as process `pid` started at `started`. */
function endpoint(
  { pid = 4242, started = 1700000000000 }: { pid?: number; started?: number } = {},
  heard: ApiStatus[] = [],
  settings = new Settings(path.join(profile, 'settings.json')),
): Endpoint {
  const deps: EndpointDeps = {
    profile,
    core: createDispatcher(testRegistry(), { isLead, resolvers: RESOLVERS, check: true }),
    clientOf: (token) => TOKENS[token],
    stale: () => false,
    settings,
    changed: (status) => heard.push(status),
    identity: () => ({ pid, started }),
  };
  const made = new Endpoint(deps);
  endpoints.push(made);
  return made;
}

async function api(): Promise<unknown> {
  return JSON.parse(await readFile(path.join(profile, 'api.json'), 'utf8'));
}

/** A port another program listens on. */
async function taken(): Promise<number> {
  const squatter = createServer();
  squatters.push(squatter);
  await new Promise<void>((resolve) => squatter.listen(0, '127.0.0.1', resolve));
  return (squatter.address() as AddressInfo).port;
}

function post(
  url: string,
  headers: Record<string, string>,
  body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
): Promise<number> {
  return new Promise((resolve, reject) => {
    const sent = request(url, { method: 'POST', agent: false, headers }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    sent.on('error', reject);
    sent.end(body);
  });
}

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
};

describe('the outside endpoint', () => {
  it('listens on 127.0.0.1 on a port chosen free once and kept, saying so as its status', async () => {
    const heard: ApiStatus[] = [];
    const first = endpoint({}, heard);
    expect(first.status).toEqual({ state: 'stopped', port: null });
    const status = await first.listen();
    expect(status).toMatchObject({ state: 'listening' });
    if (status.state !== 'listening') throw new Error('not listening');
    expect(status.url).toBe(`http://127.0.0.1:${String(status.port)}/mcp`);
    expect(heard).toEqual([status]);
    expect(await new Settings(path.join(profile, 'settings.json')).apiPort()).toBe(status.port);
    await first.close();
    expect(first.status).toEqual({ state: 'stopped', port: status.port });

    // The next owner (a core started again) listens on the same port.
    const next = endpoint();
    expect(await next.listen()).toEqual(status);
  });

  it('keeps every check of the MCP server: a foreign Host, any Origin, a body not JSON, no token', async () => {
    const status = await endpoint().listen();
    if (status.state !== 'listening') throw new Error('not listening');
    const { url, port } = status;
    const host = `127.0.0.1:${String(port)}`;
    expect(await post(url, { ...JSON_HEADERS, Host: `evil.example:${String(port)}` })).toBe(403);
    expect(await post(url, { ...JSON_HEADERS, Host: host, Origin: 'https://evil.example' })).toBe(
      403,
    );
    expect(
      await post(url, {
        'Content-Type': 'text/plain',
        Host: host,
        Authorization: 'Bearer write-token',
      }),
    ).toBe(415);
    expect(await post(url, { ...JSON_HEADERS, Host: host })).toBe(401);
    expect(await post(url, { ...JSON_HEADERS, Host: host, Authorization: 'Bearer wrong' })).toBe(
      401,
    );
    expect(
      await post(url, { ...JSON_HEADERS, Host: host, Authorization: 'Bearer write-token' }),
    ).toBe(200);
  });

  it('says a kept port that is taken, as its status, and never listens on another', async () => {
    const port = await taken();
    const settings = new Settings(path.join(profile, 'settings.json'));
    await settings.keepApiPort(port);
    const heard: ApiStatus[] = [];
    const status = await endpoint({}, heard, settings).listen();
    expect(status).toEqual({
      state: 'unavailable',
      port,
      sentence: `Port ${String(port)} is taken by another program, so corrallm’s MCP server isn’t listening: stop that program, then quit corrallm and open it again.`,
    });
    expect(heard).toEqual([status]);
    expect(await settings.apiPort()).toBe(port);
    expect(existsSync(path.join(profile, 'api.json'))).toBe(false);
  });

  it('listens on a port it is given, keeping it unless it is 0', async () => {
    const settings = new Settings(path.join(profile, 'settings.json'));
    const free = await endpoint({}, [], settings).listen(0);
    if (free.state !== 'listening') throw new Error('not listening');
    expect(await settings.apiPort()).toBeUndefined();
    await endpoints[0]?.close();
    const given = await endpoint({}, [], settings).listen(free.port);
    expect(given).toMatchObject({ state: 'listening', port: free.port });
    expect(await settings.apiPort()).toBe(free.port);
  });

  it('publishes api.json 0600 naming its process, and removes it as it closes', async () => {
    const one = endpoint({ pid: 4242, started: 1700000000000 });
    const status = await one.listen();
    if (status.state !== 'listening') throw new Error('not listening');
    await one.publish();
    expect(await api()).toEqual({
      url: status.url,
      port: status.port,
      pid: 4242,
      started: 1700000000000,
    });
    expect((await stat(path.join(profile, 'api.json'))).mode & 0o777).toBe(0o600);
    await one.close();
    expect(existsSync(path.join(profile, 'api.json'))).toBe(false);
  });

  it('a core started again rebinds the same port and replaces api.json', async () => {
    const old = endpoint({ pid: 4242 });
    const before = await old.listen();
    await old.publish();
    // The old core's listener goes with it (its process ended) before the new core comes up.
    await old.close();
    const next = endpoint({ pid: 4343 });
    expect(await next.listen()).toEqual(before);
    await next.publish();
    expect(await api()).toMatchObject({ pid: 4343, port: before.port });
  });

  it('an old owner’s late cleanup leaves a newer owner’s api.json', async () => {
    const old = endpoint({ pid: 4242 });
    await old.listen(0);
    await old.publish();
    // A newer owner (the next epoch's core) published meanwhile: its record replaced the old one.
    const next = endpoint({ pid: 4343 });
    const newer = await next.listen(0);
    await next.publish();
    // The old one's cleanup, coming late (as its process exits), removes nothing of the new one's.
    old.removeSync();
    await old.close();
    expect(await api()).toMatchObject({ pid: 4343, port: newer.port });
    await next.close();
    expect(existsSync(path.join(profile, 'api.json'))).toBe(false);
  });

  it('ends the requests it has going as it closes, and refuses to publish once closed', async () => {
    const one = endpoint();
    const status = await one.listen();
    if (status.state !== 'listening') throw new Error('not listening');
    await one.close();
    await expect(one.publish()).rejects.toThrow('closed');
    await expect(
      post(status.url, {
        ...JSON_HEADERS,
        Host: `127.0.0.1:${String(status.port)}`,
        Authorization: 'Bearer write-token',
      }),
    ).rejects.toThrow();
  });

  it('a publication still being written as it closes is removed once written', async () => {
    const one = endpoint();
    await one.listen();
    const publishing = one.publish();
    const closing = one.close();
    await Promise.allSettled([publishing, closing]);
    expect(existsSync(path.join(profile, 'api.json'))).toBe(false);
  });
});
