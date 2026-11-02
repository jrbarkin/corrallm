import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { codex } from '../adapter';

/*
 * B21 C10, Codex · App Server: what the real CLI did when given corrallm's per-session MCP entry,
 * recorded (Codex 0.162.1) in fixtures/mcp-entry.json and replayed here. Nothing in this file
 * starts a CLI. The entry is §9.4's: -c overrides on the session's private app server, the token
 * only in that process's environment. The fixtures' probe stands in for corrallm's server.
 *
 * The descriptor's `api` stays null (C7 turns it on, with these recordings), and the minimum
 * version the evidence supports is the recorded one.
 */

interface Heard {
  server: string;
  method: string;
  tool?: string;
  headers: Record<string, string>;
}
interface Config {
  mcp_servers: Record<string, Record<string, unknown>>;
  origins: Record<string, string>;
  layers: { type: string; mcp_servers?: Record<string, unknown> }[];
  error?: string;
}
interface Case {
  how: string;
  probes: Heard[];
  config?: Config | { error: string };
  status?:
    { name: string; connected: boolean; authStatus: string; tools: string[] }[] | { error: string };
  stderr?: string[];
  elicitations?: { serverName: string; mode: string; kind: string; message: string }[];
  calls?: { server: string; tool: string; status: string; error?: string; result?: string }[];
  heard?: { server: string; authorizations: string[] }[];
}
interface Fixture {
  recordedWith: { codex: string };
  minimumVersion: string;
  entry: { overrides: string[]; plainOverrides: string[]; token: string };
  cases: Record<string, Case>;
}

const fixture = JSON.parse(
  readFileSync(path.join(import.meta.dirname, 'fixtures', 'mcp-entry.json'), 'utf8'),
) as Fixture;
const one = (name: string): Case => {
  const found = fixture.cases[name];
  if (!found) throw new Error(`no case ${name}`);
  return found;
};
const config = (name: string): Config => {
  const found = one(name).config;
  if (!found || 'error' in found) throw new Error(`no config for ${name}`);
  return found;
};
const status = (name: string) => {
  const found = one(name).status;
  if (!found || 'error' in found) throw new Error(`no status for ${name}`);
  return found;
};
const reached = (name: string) => one(name).probes.map((p) => `${p.server}:${p.method}`);
const methods = (name: string, server: string) =>
  one(name)
    .probes.filter((p) => p.server === server)
    .map((p) => p.method);

/**
 * The whole-entry check §9.4 plans for this connection, from `config/read { includeLayers: true }`:
 * what is wrong with the effective `mcp_servers.<name>` beside the planned entry. A key that has a
 * value and is not in the entry, or a value that differs, or a leaf from any layer but the session's
 * flags. (Origins of an emptied list outlive it, so only keys with a value count.)
 */
function problems(read: Config, name: string, planned: Record<string, unknown>): string[] {
  const found: string[] = [];
  const effective = read.mcp_servers[name] ?? {};
  const has = (value: unknown) =>
    value !== null && value !== undefined && !(Array.isArray(value) && value.length === 0);
  for (const [key, value] of Object.entries(effective)) {
    if (key === 'environment_id') continue;
    if (!has(value) && !has(planned[key])) continue;
    if (JSON.stringify(value) !== JSON.stringify(planned[key])) found.push(key);
  }
  for (const [key, layer] of Object.entries(read.origins)) {
    const [server, ...rest] = key.split('.');
    if (server !== name || layer === 'sessionFlags') continue;
    const top = rest[0] ?? '';
    if (has(effective[top])) found.push(`origin:${key}`);
  }
  return [...new Set(found)];
}

/** The planned entry, as the config reads it back. */
const PLANNED = {
  url: 'http://127.0.0.1:47101/mcp',
  bearer_token_env_var: 'CORRALLM_SESSION_TOKEN',
  enabled: true,
  disabled_tools: [],
  default_tools_approval_mode: 'prompt',
  tools: { probe_read: { approval_mode: 'approve' }, probe_delete: { approval_mode: 'prompt' } },
};

describe("Codex · App Server's corrallm entry (B21 C10)", () => {
  it('keeps api null until the connection is turned on, and records its version', () => {
    const connection = codex.descriptor.connections.find((one) => one.id === 'codex.app-server');
    expect((connection as { api?: unknown } | undefined)?.api ?? null).toBeNull();
    expect(fixture.recordedWith.codex).toBe('0.162.1');
    expect(fixture.minimumVersion).toBe('0.162.1');
  });

  it('is the entry the recordings were made with', () => {
    expect(fixture.entry.token).toBe('CORRALLM_SESSION_TOKEN');
    expect(fixture.entry.overrides).toHaveLength(1);
    const text = fixture.entry.overrides[0] ?? '';
    expect(text).toContain('bearer_token_env_var="CORRALLM_SESSION_TOKEN"');
    expect(text).not.toMatch(/\bbearer_token=/);
    expect(text).toContain('enabled=true,disabled_tools=[]');
    expect(fixture.entry.plainOverrides[0]).not.toContain('enabled=true');
  });

  it('connects at startup, lists its tools and sends the bearer from the environment variable (S1)', () => {
    const clean = one('clean');
    expect(reached('clean').every((entry) => entry.startsWith('ours:'))).toBe(true);
    expect(methods('clean', 'ours')).toEqual(
      expect.arrayContaining(['initialize', 'notifications/initialized', 'tools/list']),
    );
    expect(clean.probes.map((p) => p.headers.authorization)).toEqual(
      clean.probes.map(() => 'Bearer canary-as-clean'),
    );
    expect(status('clean')).toEqual([
      {
        name: 'corrallm',
        connected: true,
        authStatus: 'bearerToken',
        tools: ['probe_delete', 'probe_read'],
      },
    ]);
  });

  it('shows every key of the entry from the session flags, no other layer (S1, provenance)', () => {
    const read = config('clean');
    expect(read.layers.map((layer) => layer.type)).toEqual([
      'sessionFlags',
      'project',
      'user',
      'system',
    ]);
    expect(
      read.layers.filter((layer) => layer.mcp_servers !== undefined).map((layer) => layer.type),
    ).toEqual(['sessionFlags']);
    const keys = Object.keys(read.origins).filter((key) => key.startsWith('corrallm.'));
    expect(keys.sort()).toEqual(
      [
        'corrallm.bearer_token_env_var',
        'corrallm.default_tools_approval_mode',
        'corrallm.enabled',
        'corrallm.tools.probe_delete.approval_mode',
        'corrallm.tools.probe_read.approval_mode',
        'corrallm.url',
      ].sort(),
    );
    expect(new Set(keys.map((key) => read.origins[key]))).toEqual(new Set(['sessionFlags']));
    expect(read.mcp_servers.corrallm).toMatchObject({ ...PLANNED, disabled_tools: [] });
    expect(problems(read, 'corrallm', PLANNED)).toEqual([]);
  });

  it("merges a user's same-named entry field by field, so the whole-entry check refuses it", () => {
    // The plain entry: the user's headers reach our server, the user's disabled_tools hide a tool,
    // and the user's enabled = false switches the entry off altogether.
    const plain = one('userPlain');
    expect(plain.probes.some((p) => p.headers['x-evil'] === 'user-corrallm')).toBe(true);
    expect(status('userPlain')[0]?.tools).toEqual(['probe_delete']);
    expect(problems(config('userPlain'), 'corrallm', { ...PLANNED, enabled: undefined })).toEqual(
      expect.arrayContaining(['http_headers', 'disabled_tools']),
    );
    expect(one('userDisabled').probes).toEqual([]);
    expect(status('userDisabled')[0]).toMatchObject({ name: 'corrallm', connected: false });
    expect(problems(config('userDisabled'), 'corrallm', PLANNED)).toEqual(
      expect.arrayContaining(['http_headers', 'enabled_tools']),
    );
  });

  it('still merges the user entry and sends our bearer, though enabled=true and disabled_tools=[] win', () => {
    const hardened = one('userHardened');
    expect(methods('userHardened', 'ours')).toContain('tools/list');
    // Our Authorization wins over the user's static header; their other headers still arrive.
    expect(new Set(hardened.probes.map((p) => p.headers.authorization))).toEqual(
      new Set(['Bearer canary-as-user-hardened']),
    );
    expect(hardened.probes.some((p) => p.headers['x-evil'] === 'user-corrallm')).toBe(true);
    // enabled_tools of the user's still limits the tools.
    expect(status('userHardened')[0]?.tools).toEqual(['probe_delete']);
    expect(problems(config('userHardened'), 'corrallm', PLANNED)).toEqual(
      expect.arrayContaining(['http_headers', 'env_http_headers', 'enabled_tools']),
    );
  });

  it("never sends a user's Authorization, from a header, a helper command or an environment variable", () => {
    const ours = {
      userHelper: 'as-user-helper',
      userEnvAuth: 'as-user-envauth',
      userHardened: 'as-user-hardened',
      project: 'as-project',
    };
    for (const [name, scenario] of Object.entries(ours)) {
      const sent = new Set(one(name).probes.map((p) => p.headers.authorization));
      expect(sent, name).toEqual(new Set([`Bearer canary-${scenario}`]));
    }
    // The helper still ran (the user's command, with its other header).
    expect(one('userHelper').probes.some((p) => p.headers['x-canary'] === 'helper')).toBe(true);
  });

  it("merges a trusted project's same-named entry too (corrallm trusts the project for every session)", () => {
    expect(one('project').probes.some((p) => p.headers['x-canary'] === 'project-corrallm')).toBe(
      true,
    );
    const read = config('project');
    expect(read.origins['corrallm.http_headers.X-Canary']).toBe('project');
    expect(problems(read, 'corrallm', PLANNED)).toEqual(expect.arrayContaining(['http_headers']));
  });

  it("refuses to start the entry beside a user's invalid one, so the check cannot be made", () => {
    const inline = one('userInlineBearer');
    expect(inline.probes).toEqual([]);
    expect((inline.config as { error: string }).error).toContain(
      'bearer_token is not supported for streamable_http',
    );
    expect((inline.status as { error: string }).error).toContain('bearer_token is not supported');
  });

  it("switches the user's own corrallm-server off only for a name its config holds (S3)", () => {
    expect(reached('outsideNameControl')).toContain('extra:initialize');
    expect(one('outsideNameOff').probes.filter((p) => p.server === 'extra')).toEqual([]);
    expect(reached('outsideNameOff')).toContain('ours:tools/list');
    const off = status('outsideNameOff').find((entry) => entry.name === 'corrallm-server');
    expect(off).toMatchObject({ connected: false, tools: [] });
  });

  it('needs loopback in NO_PROXY: with a proxy in the environment it never connects (S4)', () => {
    expect(one('proxyWithoutNoProxy').probes).toEqual([]);
    expect(methods('proxyWithNoProxy', 'ours')).toContain('tools/list');
  });

  it("keeps two sessions' app servers apart: each probe heard only its own token (S2)", () => {
    expect(one('twoSessions').heard).toEqual([
      { server: 'ours', authorizations: ['Bearer canary-session-one'] },
      { server: 'user', authorizations: ['Bearer canary-session-two'] },
    ]);
  });

  it('runs an approve tool with no elicitation, under on-request and under never (T1)', () => {
    for (const name of ['approveOnRequest', 'approveNever']) {
      const turn = one(name);
      expect(turn.elicitations, name).toEqual([]);
      expect(turn.calls, name).toEqual([
        {
          server: 'corrallm',
          tool: 'probe_read',
          status: 'completed',
          result: 'probe ours ran probe_read',
        },
      ]);
      expect(turn.probes.some((p) => p.method === 'tools/call' && p.tool === 'probe_read')).toBe(
        true,
      );
    }
  });

  it('raises the recorded MCP elicitation for a prompt tool, and refuses it under never (T1)', () => {
    const asked = one('promptOnRequest');
    expect(asked.elicitations).toEqual([
      {
        serverName: 'corrallm',
        mode: 'form',
        kind: 'mcp_tool_call',
        message: 'Allow the corrallm MCP server to run tool "probe_delete"?',
      },
    ]);
    expect(asked.calls).toEqual([
      {
        server: 'corrallm',
        tool: 'probe_delete',
        status: 'failed',
        error: 'user rejected MCP tool call',
      },
    ]);
    expect(asked.probes.some((p) => p.method === 'tools/call')).toBe(false);

    const never = one('promptNever');
    expect(never.elicitations).toEqual([]);
    expect(never.calls).toEqual([
      {
        server: 'corrallm',
        tool: 'probe_delete',
        status: 'failed',
        error: 'MCP tool call requires approval, but approval policy is never',
      },
    ]);
    expect(never.probes.some((p) => p.method === 'tools/call')).toBe(false);

    // A read tool with prompt on the tool asks the same question.
    expect(one('promptOnReadOnRequest').elicitations?.[0]?.message).toBe(
      'Allow the corrallm MCP server to run tool "probe_read"?',
    );
  });
});
