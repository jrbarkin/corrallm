import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { codex } from '../adapter';

/*
 * B21 C10, Codex · Terminal: what the real TUI did when given corrallm's per-session MCP entry as
 * `-c` overrides with the token in its environment, recorded (Codex 0.162.1) in
 * fixtures/mcp-entry.json and replayed here. Nothing in this file starts a CLI. The model was a
 * local stub, so no tokens were spent. Provenance and merge evidence shared with the App Server
 * (same config loader) is in ../app-server/mcp-entry.test.ts.
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
interface Case {
  how: string;
  heard: Heard[];
  screen?: Record<string, boolean>;
}
interface Fixture {
  recordedWith: { codex: string };
  minimumVersion: string;
  entry: { overrides: string[]; token: string };
  cases: Record<string, Case>;
  mcpGet: {
    clean: {
      enabled: boolean;
      transport: Record<string, unknown>;
      enabled_tools: unknown;
      disabled_tools: unknown;
    };
    withUserEntry: {
      got: { transport: { http_headers: Record<string, string> }; enabled_tools: string[] };
    };
    withStdioEntry: string;
    undefinedNameDisabled: string;
  };
}

const fixture = JSON.parse(
  readFileSync(path.join(import.meta.dirname, 'fixtures', 'mcp-entry.json'), 'utf8'),
) as Fixture;
const one = (name: string): Case => {
  const found = fixture.cases[name];
  if (!found) throw new Error(`no case ${name}`);
  return found;
};
const sent = (name: string) => [...new Set(one(name).heard.map((h) => h.headers.authorization))];
const called = (name: string) =>
  one(name)
    .heard.filter((h) => h.method === 'tools/call')
    .map((h) => h.tool);

describe("Codex · Terminal's corrallm entry (B21 C10)", () => {
  it('keeps api null until the connection is turned on, and records its version', () => {
    const connection = codex.descriptor.connections.find((one) => one.id === 'codex.terminal');
    expect((connection as { api?: unknown } | undefined)?.api ?? null).toBeNull();
    expect(fixture.recordedWith.codex).toBe('0.162.1');
    expect(fixture.minimumVersion).toBe('0.162.1');
  });

  it('is the entry the recordings were made with: bearer from the environment, never inline', () => {
    const entry = fixture.entry.overrides[0] ?? '';
    expect(fixture.entry.token).toBe('CORRALLM_SESSION_TOKEN');
    expect(entry).toContain('bearer_token_env_var="CORRALLM_SESSION_TOKEN"');
    expect(entry).not.toMatch(/\bbearer_token=/);
    expect(entry).toContain('default_tools_approval_mode="prompt"');
    expect(entry).toContain('probe_read={approval_mode="approve"}');
    expect(entry).toContain('probe_delete={approval_mode="prompt"}');
  });

  it("connects at startup, lists tools and sends the token from the TUI's environment (S1)", () => {
    expect(one('startup').heard.map((h) => h.method)).toEqual(
      expect.arrayContaining(['initialize', 'tools/list']),
    );
    expect(sent('startup')).toEqual(['Bearer canary-tui-ctui-s1']);
  });

  it("sends the new generation's token when a conversation is resumed (S3)", () => {
    expect(sent('resume')).toEqual(['Bearer canary-tui-ctui-resume']);
  });

  it('needs loopback in NO_PROXY: with a proxy in the environment it never connects (S4)', () => {
    expect(one('proxyWithoutNoProxy').heard).toEqual([]);
    expect(sent('proxyWithNoProxy')).toEqual(['Bearer canary-tui-ctui-proxy-with']);
  });

  it('runs an approve tool with no dialog (T1, Q25 behaviour)', () => {
    expect(called('approveTool')).toEqual(['probe_read']);
    expect(one('approveTool').screen).toMatchObject({
      'Called corrallm': true,
      'probe ours ran probe_read': true,
      'Allow the corrallm MCP server': false,
    });
  });

  it('shows a dialog for a prompt tool, and refuses it without one under -a never (T1, Q25 behaviour)', () => {
    expect(one('promptTool').screen).toMatchObject({
      'Allow the corrallm MCP server to run tool "probe_delete"?': true,
      '1. Allow': true,
      '2. Cancel': true,
    });
    expect(called('promptTool')).toEqual(['probe_delete']);
    expect(one('promptToolNever').screen).toMatchObject({
      'MCP tool call requires approval, but approval policy is never': true,
      'Allow the corrallm MCP server': false,
    });
    expect(called('promptToolNever')).toEqual([]);
  });

  it("reports an entry's transport and tool lists with `codex mcp get --json`, but no approval modes (S2)", () => {
    const { clean, withUserEntry } = fixture.mcpGet;
    expect(clean).toMatchObject({
      enabled: true,
      transport: {
        type: 'streamable_http',
        url: 'http://127.0.0.1:47101/mcp',
        bearer_token_env_var: 'CORRALLM_SESSION_TOKEN',
        http_headers: null,
        env_http_headers: null,
        http_headers_helper: null,
      },
      enabled_tools: null,
      disabled_tools: [],
    });
    expect(JSON.stringify(clean)).not.toContain('approval');
    // A user's same-named entry merges into what it reports: the check can see it.
    expect(withUserEntry.got.transport.http_headers).toEqual({ 'X-Evil': 'user' });
    expect(withUserEntry.got.enabled_tools).toEqual(['probe_delete']);
    // A same-named stdio entry, or an override for a name no layer defines, is a configuration error.
    expect(fixture.mcpGet.withStdioEntry).toContain('url is not supported for stdio');
    expect(fixture.mcpGet.undefinedNameDisabled).toContain('invalid transport');
  });
});
