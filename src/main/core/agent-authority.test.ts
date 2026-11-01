import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConnectionId } from '../../shared/adapter';
import { SESSION_ENDED, TOKEN_REPLACED } from '../../shared/api/errors';
import type { CanvasId } from '../../shared/canvas';
import type { SessionMode } from '../../shared/session';
import type { Connector, SessionApi, SessionHost } from '../sessions/connector';
import { FakeConnector } from '../sessions/fake';
import { connectChannel, connectHttp } from '../sessions/fake-mcp-client.mjs';
import type { AgentCaller, OutsideCaller } from './caller';
import { createCore } from './core';
import type { Core } from './core';
import { Endpoint } from './endpoint';
import { SYSTEM_DEPS } from './store/store';
import { keepCanvases } from './store/test-store';
import { CALLERS, NO_DESKTOP } from './test-registry';
import { legacyDirectories } from './workspaces/test-directories';

/*
 * The session authority (B21 §9 C1, C2) composed in the real core, its fakes calling the real
 * endpoint through the shared test client: each generation of an agent's session gets its own
 * credential (or bound channel), the core observes it list corrallm's tools (`agents`' `api`), and
 * it works only while that generation is the agent's session and the agent is on the canvas.
 */

const M1 = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a41' as CanvasId;
const APP_SERVER = 'codex.app-server' as ConnectionId;

let profile: string;
let core: Core | undefined;
let endpoint: Endpoint | undefined;
let fake: FakeConnector;
let hosts: SessionHost[];

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-agent-authority-'));
  fake = new FakeConnector({ adapter: 'codex' });
  hosts = [];
});

afterEach(async () => {
  await endpoint?.close();
  endpoint = undefined;
  await core?.close();
  core = undefined;
  await rm(profile, { recursive: true, force: true });
});

/** A kept canvas with two linked App Server agents, Builder and Reviewer. */
async function keep(): Promise<void> {
  const file = path.join(profile, 'm1.corral');
  const project = path.join(profile, 'm1');
  await mkdir(project, { recursive: true });
  const agent = (id: string, x: number) => ({
    id,
    kind: 'agent',
    label: id.charAt(0).toUpperCase() + id.slice(1),
    position: { x, y: 0 },
    adapter: 'codex',
    connection: APP_SERVER,
  });
  await writeFile(
    file,
    JSON.stringify({
      format: 'corrallm',
      version: 2,
      id: M1,
      nodes: [agent('builder', 0), agent('reviewer', 400)],
      links: [{ agents: ['builder', 'reviewer'] }],
    }),
  );
  await keepCanvases(profile, { [M1]: { file, project } });
}

/**
 * Starts a core whose App Server agents' route is `route`, with its endpoint listening (unless
 * `listening` is false), and a database whose log flushes wait while held.
 */
async function start(
  route: 'http' | 'channel',
  listening = true,
): Promise<{ hold: () => () => void }> {
  let held: Promise<void> | undefined;
  const connector: Connector<SessionMode> = {
    start: (spec, host) => {
      hosts.push(host);
      return fake.start(spec, host);
    },
  };
  const opened = await createCore(
    {
      profile,
      app: { name: 'corrallm', version: '1.0.0' },
      check: true,
      distribution: 'local',
      directoryResolver: legacyDirectories,
      locale: 'en-GB',
      store: {
        ...SYSTEM_DEPS,
        flush: async (fd) => {
          await held;
          return SYSTEM_DEPS.flush(fd);
        },
      },
      sessions: {
        connectors: { [APP_SERVER]: connector },
        environment: () => Promise.resolve({}),
        api: { [APP_SERVER]: route },
      },
    },
    NO_DESKTOP,
  );
  core = opened;
  if (listening) {
    endpoint = new Endpoint({
      profile,
      core: opened,
      clientOf: (token) => opened.clientOf(token),
      stale: (token) => opened.tokens.stale(token),
      listed: (caller) => {
        opened.listed(caller);
      },
      settings: opened.settings,
      changed: (status) => {
        opened.served(status);
      },
    });
    await endpoint.listen(0);
  }
  await opened.engines.open(M1);
  return {
    hold: () => {
      const release = Promise.withResolvers<undefined>();
      held = release.promise.then(() => undefined);
      return () => {
        held = undefined;
        release.resolve(undefined);
      };
    },
  };
}

function current(): Core {
  if (!core) throw new Error('No core is started');
  return core;
}

/** An outside write token's caller. */
async function outside(): Promise<OutsideCaller> {
  const made = await current().tokens.create({
    name: 'orchestrator',
    canvases: [M1],
    access: 'write',
  });
  const caller = current().clientOf(made);
  if (caller?.kind !== 'outside') throw new Error('No outside caller');
  return caller;
}

/** Opens `agent`'s session as an outside orchestrator would: the route its spec carried. */
async function open(agent = 'builder'): Promise<SessionApi | undefined> {
  const before = fake.started.length;
  const opened = await current().call('session.open', { canvas: M1, agent }, await outside());
  if (!opened.ok) throw new Error(opened.error.sentence);
  await vi.waitFor(() => {
    expect(fake.started.length).toBeGreaterThan(before);
  });
  return fake.started.at(-1)?.api;
}

/** The http route a spec carried: the test fails if it carried another. */
function http(api: SessionApi | undefined): Extract<SessionApi, { kind: 'http' }> {
  if (api?.kind !== 'http') throw new Error(`No http route: ${JSON.stringify(api)}`);
  return api;
}

/** Each agent's `api`, as you read `agents`. */
async function apis(): Promise<Record<string, boolean>> {
  const result = await current().call('agents', { canvas: M1 }, CALLERS.you);
  if (!result.ok) throw new Error(result.error.sentence);
  return Object.fromEntries(result.value.agents.map(({ id, api }) => [id, api]));
}

/** The caller a credential names now, through the endpoint's lookup. */
function callerOf(token: string): AgentCaller {
  const caller = current().clientOf(token);
  if (caller?.kind !== 'agent') throw new Error('The credential names no agent');
  return caller;
}

/** What answers an http request carrying `token`: its status and body. */
async function post(token: string): Promise<{ status: number; body: string }> {
  const url = endpoint?.url;
  if (url === undefined) throw new Error('The endpoint isn’t listening');
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  return { status: response.status, body: await response.text() };
}

describe('an agent session’s route', () => {
  it('reports api: true for an agent once its session generation listed corrallm’s tools over http', async () => {
    await keep();
    await start('http');
    const api = http(await open());
    expect(api.url).toBe(endpoint?.url);
    expect(api.server).toBe('corrallm');
    expect(api.tools.map(({ name }) => name)).toContain('message');
    expect(await apis()).toEqual({ builder: false, reviewer: false });
    const client = await connectHttp(api);
    try {
      expect((await client.list()).map(({ name }) => name)).toEqual(
        api.tools.map(({ name }) => name),
      );
    } finally {
      await client.close();
    }
    expect(await apis()).toEqual({ builder: true, reviewer: false });
    // The agent's own call names it, by its credential alone.
    expect(callerOf(api.token)).toMatchObject({ kind: 'agent', canvas: M1, agent: 'builder' });
  });

  it('reports api: true once a channel’s generation listed, and calls as that generation’s agent', async () => {
    await keep();
    await start('channel');
    const api = await open();
    if (api?.kind !== 'channel') throw new Error('No channel');
    expect(api).not.toHaveProperty('token');
    const client = connectChannel(api.channel);
    expect(await apis()).toEqual({ builder: false, reviewer: false });
    await client.list();
    expect(await apis()).toEqual({ builder: true, reviewer: false });
    const sent = await client.call('message', { to: 'reviewer', body: 'Have a look' });
    expect(sent.isError).not.toBe(true);
    const [message] = (current().engines.canvas(M1)?.messages.all() ?? []).filter(
      ({ body }) => body === 'Have a look',
    );
    expect(message?.from).toBe('agent:builder');
  });

  it('is issued to no session while the endpoint isn’t listening: the session starts without it', async () => {
    await keep();
    await start('http', false);
    expect(await open()).toBeUndefined();
    expect(await apis()).toEqual({ builder: false, reviewer: false });
  });
});

describe('an agent session’s credential', () => {
  it('ends as its session restarts: the old caller is refused, its credential a plain 401, and the new generation must list again', async () => {
    await keep();
    await start('http');
    const first = http(await open());
    const old = callerOf(first.token);
    const client = await connectHttp(first);
    await client.list();
    await client.close();
    expect(await apis()).toMatchObject({ builder: true });

    const restarted = await current().call(
      'session.restart',
      { canvas: M1, agent: 'builder' },
      CALLERS.you,
    );
    expect(restarted).toMatchObject({ ok: true });
    await vi.waitFor(() => {
      expect(fake.started).toHaveLength(2);
    });
    const second = http(fake.started[1]?.api);
    expect(second.token).not.toBe(first.token);
    expect(callerOf(second.token).generation).toBeGreaterThan(old.generation);

    // The old generation's caller is refused as its call comes: not current, whatever it names.
    expect(await current().call('agents', { canvas: M1 }, old)).toEqual({
      ok: false,
      error: { code: 'refused', sentence: SESSION_ENDED },
    });
    expect(current().clientOf(first.token)).toBeUndefined();
    const refused = await post(first.token);
    expect(refused.status).toBe(401);
    expect(refused.body).not.toContain(TOKEN_REPLACED);
    // A restart's generation hasn't listed yet.
    expect(await apis()).toMatchObject({ builder: false });
    expect((await post(second.token)).status).toBe(200);
    expect(await apis()).toMatchObject({ builder: true });
  });

  it('ends with its agent deleted: refused at once, before its session has closed', async () => {
    await keep();
    await start('http');
    const old = callerOf(http(await open()).token);
    const deleted = await current().call(
      'canvas.delete',
      { canvas: M1, nodes: ['builder'] },
      CALLERS.you,
    );
    expect(deleted).toMatchObject({ ok: true });
    expect(await current().call('agents', { canvas: M1 }, old)).toEqual({
      ok: false,
      error: { code: 'refused', sentence: SESSION_ENDED },
    });
  });

  it('ends for a call admitted before its session stopped, queued in a scope: refused when it runs', async () => {
    await keep();
    const { hold } = await start('http');
    const caller = callerOf(http(await open()).token);
    const release = hold();
    // The first holds Reviewer's scope, waiting for its write to reach the disk.
    const first = current().call('message', { canvas: M1, to: 'reviewer', body: 'One' }, caller);
    // The second is admitted, and waits in that scope behind it.
    const second = current().call('message', { canvas: M1, to: 'reviewer', body: 'Two' }, caller);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Builder's session stops by itself: its close begins, and its credential ends with it.
    hosts.at(-1)?.emit({ type: 'closed' });
    release();
    await first;
    expect(await second).toEqual({
      ok: false,
      error: { code: 'refused', sentence: SESSION_ENDED },
    });
    const bodies = (current().engines.canvas(M1)?.messages.all() ?? [])
      .filter(({ from }) => from === 'agent:builder')
      .map(({ body }) => body);
    expect(bodies).not.toContain('Two');
  });

  it('keeps one agent’s limits and repeated requests across a restart of its session', async () => {
    await keep();
    await start('http');
    const before = callerOf(http(await open()).token);
    const request = crypto.randomUUID();
    const args = { canvas: M1, to: 'reviewer', body: 'Once', request };
    const sent = await current().call('message', args, before);
    expect(sent).toMatchObject({ ok: true });
    await current().call('session.restart', { canvas: M1, agent: 'builder' }, CALLERS.you);
    await vi.waitFor(() => {
      expect(fake.started).toHaveLength(2);
    });
    const after = callerOf(http(fake.started[1]?.api).token);
    // The retry, from the restarted session, gets the first call's result: nothing sent twice.
    const again = await current().call('message', args, after);
    expect(again).toEqual(sent);
    const once = (current().engines.canvas(M1)?.messages.all() ?? []).filter(
      ({ body }) => body === 'Once',
    );
    expect(once).toHaveLength(1);
  });
});
