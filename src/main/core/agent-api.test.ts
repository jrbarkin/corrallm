import { describe, expect, it } from 'vitest';

import type { ConnectionId } from '../../shared/adapter';
import { createDispatcher } from './call';
import type { AgentApiDeps } from './agent-api';
import { OUTSIDE_SERVERS, SessionAuthority } from './agent-api';
import type { AgentCaller } from './caller';
import { CANVAS, isLead, RESOLVERS, testRegistry } from './test-registry';

/*
 * The session authority (B21 §9 C1, C2): one credential per session generation, minted only by
 * `issue`, kept only as its hash, looked up for the endpoint, current only while its entry stands,
 * its generation is the agent's session's and its agent is on the canvas, and gone at `revoke`.
 */

const HTTP = 'test.http' as ConnectionId;
const CHANNEL = 'test.channel' as ConnectionId;
const NONE = 'test.none' as ConnectionId;
const URL = 'http://127.0.0.1:4100/mcp';

/** An authority over the test registry, whose generations and canvas the test sets. */
function setup() {
  const registry = testRegistry();
  const core = createDispatcher(registry, { isLead, resolvers: RESOLVERS, check: true });
  const generations = new Map<string, number>([
    ['worker', 1],
    ['lead', 1],
  ]);
  const onCanvas = new Set(['worker', 'lead']);
  let url: string | undefined = URL;
  const deps: AgentApiDeps = {
    route: (connection) =>
      connection === HTTP ? 'http' : connection === CHANNEL ? 'channel' : null,
    url: () => url,
    core: () => core,
    generationOf: (canvas, agent) => (canvas === CANVAS ? generations.get(agent) : undefined),
    onCanvas: (canvas, agent) => canvas === CANVAS && onCanvas.has(agent),
  };
  const authority = new SessionAuthority(deps);
  return {
    authority,
    generations,
    onCanvas,
    registry,
    stopListening: () => {
      url = undefined;
    },
  };
}

const origin = (agent = 'worker', generation = 1, connection: ConnectionId = HTTP) => ({
  canvas: CANVAS,
  agent,
  generation,
  connection,
});

/** The caller a credential names: the test fails if it names none. */
function callerOf(authority: SessionAuthority, token: string): AgentCaller {
  const caller = authority.lookup(token);
  if (caller === undefined) throw new Error('The credential names no caller');
  return caller;
}

/** The http route `issue` gave: the test fails if it gave none, or another. */
function http(api: ReturnType<SessionAuthority['issue']>) {
  if (api?.kind !== 'http') throw new Error(`Not an http route: ${JSON.stringify(api)}`);
  return api;
}

describe('the session authority', () => {
  it('issues nothing for a connection whose descriptor says null, or while no endpoint listens', () => {
    const { authority, stopListening } = setup();
    expect(authority.issue(origin('worker', 1, NONE))).toBeUndefined();
    stopListening();
    expect(authority.issue(origin('worker', 1, HTTP))).toBeUndefined();
    expect(authority.issue(origin('worker', 1, CHANNEL))).toBeUndefined();
  });

  it('issues nothing for a generation that isn’t the agent’s session now, or an agent not on the canvas', () => {
    const { authority, onCanvas } = setup();
    expect(authority.issue(origin('worker', 2))).toBeUndefined();
    onCanvas.delete('worker');
    expect(authority.issue(origin('worker', 1))).toBeUndefined();
  });

  it('mints one random credential per generation over http, with the generation’s own tools', () => {
    const { authority } = setup();
    const api = http(authority.issue(origin()));
    expect(api).toMatchObject({ kind: 'http', server: 'corrallm', url: URL });
    expect(api.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(api.off).toEqual(['corrallm-server', 'corrallm-server-dev']);
    expect(OUTSIDE_SERVERS).toEqual(api.off);
    // A worker's listing, by exact MCP name, each destructive or not as the registry says.
    expect(api.tools).toEqual([
      { name: 'test_hold', destructive: false },
      { name: 'test_message', destructive: false },
      { name: 'test_read', destructive: false },
      { name: 'test_stop', destructive: true },
      { name: 'test_tokens', destructive: false },
    ]);
    const caller = authority.lookup(api.token);
    expect(caller).toMatchObject({ kind: 'agent', canvas: CANVAS, agent: 'worker', generation: 1 });
    expect(caller?.session).toMatch(/^[0-9a-f-]{36}$/);
    // Never derived from ids: another generation's differs.
    const other = http(authority.issue(origin('lead')));
    expect(other.token).not.toBe(api.token);
    expect(authority.lookup('not-a-credential')).toBeUndefined();
  });

  it('keeps only the credential’s hash, never its value', () => {
    const { authority } = setup();
    const { token } = http(authority.issue(origin()));
    const seen = new WeakSet();
    const values: unknown[] = [];
    const walk = (value: unknown): void => {
      if (typeof value === 'string') values.push(value);
      if (typeof value !== 'object' || value === null || seen.has(value)) return;
      seen.add(value);
      for (const one of value instanceof Map ? [...value.entries()] : Object.values(value))
        walk(one);
    };
    walk(authority.inspect());
    expect(values).not.toContain(token);
    expect(values.length).toBeGreaterThan(0);
  });

  it('revokes a generation’s credential at once, idempotently: looked up as nothing, no longer current', () => {
    const { authority } = setup();
    const { token } = http(authority.issue(origin()));
    const caller = callerOf(authority, token);
    expect(authority.current(caller)).toBe(true);
    authority.revoke(CANVAS, 'worker', 1);
    authority.revoke(CANVAS, 'worker', 1);
    expect(authority.lookup(token)).toBeUndefined();
    expect(authority.current(caller)).toBe(false);
    expect(authority.inspect().entries).toBe(0);
  });

  it('holds a caller current only while its generation is the agent’s session’s, on the canvas', () => {
    const { authority, generations, onCanvas } = setup();
    const caller = callerOf(authority, http(authority.issue(origin())).token);
    // A caller made up with the same generation, or another session's, is never current.
    expect(authority.current({ ...caller, session: crypto.randomUUID() })).toBe(false);
    // A restart's new generation: the old caller is no longer current, even with its entry kept.
    generations.set('worker', 2);
    expect(authority.current(caller)).toBe(false);
    expect(authority.lookup(http(authority.issue(origin('worker', 2))).token)).toMatchObject({
      generation: 2,
    });
    generations.set('worker', 1);
    expect(authority.current(caller)).toBe(true);
    // Its agent deleted from the canvas: no longer current, whatever its session says.
    onCanvas.delete('worker');
    expect(authority.current(caller)).toBe(false);
  });

  it('replaces a generation’s credential if it is issued again: one stands', () => {
    const { authority } = setup();
    const first = http(authority.issue(origin())).token;
    const second = http(authority.issue(origin())).token;
    expect(authority.lookup(first)).toBeUndefined();
    expect(authority.lookup(second)).toBeDefined();
    expect(authority.inspect().entries).toBe(1);
  });

  it('marks a generation listed only when its own caller lists, while current', () => {
    const { authority, generations } = setup();
    const caller = callerOf(authority, http(authority.issue(origin())).token);
    expect(authority.hasListed(CANVAS, 'worker')).toBe(false);
    authority.listed({ ...caller, session: crypto.randomUUID() });
    expect(authority.hasListed(CANVAS, 'worker')).toBe(false);
    authority.listed(caller);
    expect(authority.hasListed(CANVAS, 'worker')).toBe(true);
    // A restart's generation hasn't listed yet, whatever the last one did.
    generations.set('worker', 2);
    authority.issue(origin('worker', 2));
    expect(authority.hasListed(CANVAS, 'worker')).toBe(false);
    authority.listed(caller);
    expect(authority.hasListed(CANVAS, 'worker')).toBe(false);
    expect(authority.hasListed(CANVAS, 'nobody')).toBe(false);
  });

  it('binds a channel to its generation’s caller, with no credential: list marks it listed, call goes through core.call', async () => {
    const { authority, registry } = setup();
    const api = authority.issue(origin('worker', 1, CHANNEL));
    if (api?.kind !== 'channel') throw new Error('Not a channel');
    expect(api).toMatchObject({
      server: 'corrallm',
      off: ['corrallm-server', 'corrallm-server-dev'],
    });
    expect(api).not.toHaveProperty('token');
    expect(api.tools.map(({ name }) => name)).toContain('test_message');
    expect(authority.hasListed(CANVAS, 'worker')).toBe(false);
    expect(api.channel.list().map(({ name }) => name)).toEqual(api.tools.map(({ name }) => name));
    expect(authority.hasListed(CANVAS, 'worker')).toBe(true);
    const signal = new AbortController().signal;
    const sent = await api.channel.call(
      'test_message',
      { canvas: CANVAS, to: 'peer', body: 'hello' },
      signal,
    );
    expect(sent).toMatchObject({ structuredContent: { sent: 'peer' } });
    expect(registry.calls['test.message']).toEqual([{ canvas: CANVAS, to: 'peer', body: 'hello' }]);
    // The channel names its own caller: an agent aiming at itself is refused as one.
    const self = await api.channel.call(
      'test_message',
      { canvas: CANVAS, to: 'worker', body: 'hi' },
      signal,
    );
    expect(self.isError).toBe(true);
    // Revoked, it lists nothing and marks nothing.
    authority.revoke(CANVAS, 'worker', 1);
    expect(api.channel.list()).toEqual([]);
    expect(authority.inspect().entries).toBe(0);
  });
});
