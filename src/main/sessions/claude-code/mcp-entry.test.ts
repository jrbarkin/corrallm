import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { claudeCode } from './adapter';

/*
 * B21 C10, Claude Code · Terminal: what the real CLI did when given corrallm's per-session MCP
 * entry, recorded (Claude Code 2.1.316) in fixtures/mcp-entry.json and replayed here. Nothing in
 * this file starts a CLI. The entry is §9.4's: `--mcp-config=<file>` (the session's own 0600 file)
 * and `--settings=<file>` (pre-approval, the outside names denied). The fixture's probe stands in
 * for corrallm's server; its model was a local stub, so no tokens were spent.
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
  mcp_servers?: { name: string; status: string; source: string }[];
  tools?: string[];
  permission_denials?: string[];
  tool_results?: string[];
  helperRuns?: number;
  warnings?: string[];
  screen?: Record<string, boolean>;
  hooks?: {
    hook_event_name: string;
    permission_mode: string;
    tool_name: string;
    permission_suggestions: {
      type: string;
      behavior: string;
      destination: string;
      rules: { toolName: string }[];
    }[];
    mcp_server: { name: string; source: string };
  }[];
}
interface Fixture {
  recordedWith: { claude: string };
  minimumVersion: string;
  entry: {
    flag: string;
    mcpJson: {
      mcpServers: Record<string, { type: string; url: string; headers: Record<string, string> }>;
    };
    settings: { deniedMcpServers: { serverName: string }[]; permissions: { allow: string[] } };
    settingsAlsoAllowingTheServer: { allowedMcpServers: { serverName: string }[] };
  };
  cases: Record<string, Case>;
  mentions: Record<
    string,
    | Record<string, number>
    | { seen: Record<string, number>; screen: Record<string, boolean> }
    | string
  >;
}

const fixture = JSON.parse(
  readFileSync(path.join(import.meta.dirname, 'fixtures', 'mcp-entry.json'), 'utf8'),
) as Fixture;
const one = (name: string): Case => {
  const found = fixture.cases[name];
  if (!found) throw new Error(`no case ${name}`);
  return found;
};
const OURS = 'Bearer canary-claude-ours';
/** The credentials one server heard, over every request it was sent. */
const sent = (name: string, server: string) => [
  ...new Set(
    one(name)
      .heard.filter((h) => h.server === server)
      .map((h) => h.headers.authorization),
  ),
];
const methods = (name: string, server: string) =>
  one(name)
    .heard.filter((h) => h.server === server)
    .map((h) => h.method);
const called = (name: string) =>
  one(name)
    .heard.filter((h) => h.method === 'tools/call')
    .map((h) => h.tool);

describe("Claude Code · Terminal's corrallm entry (B21 C10)", () => {
  it('keeps api null until the connection is turned on, and records its version', () => {
    const connection = claudeCode.descriptor.connections.find(
      (one) => one.id === 'claude-code.terminal',
    );
    expect((connection as { api?: unknown } | undefined)?.api ?? null).toBeNull();
    expect(fixture.recordedWith.claude).toBe('2.1.316');
    expect(fixture.minimumVersion).toBe('2.1.316');
  });

  it('is the entry the recordings were made with', () => {
    expect(fixture.entry.flag).toBe('--mcp-config=<dir>/mcp.json');
    expect(fixture.entry.mcpJson).toEqual({
      mcpServers: {
        corrallm: {
          type: 'http',
          url: 'http://127.0.0.1:47101/mcp',
          headers: { Authorization: OURS },
        },
      },
    });
    expect(fixture.entry.settings.deniedMcpServers.map((entry) => entry.serverName)).toEqual([
      'corrallm-server',
      'corrallm-server-dev',
    ]);
    expect(fixture.entry.settings.permissions.allow).toEqual(['mcp__corrallm__probe_read']);
  });

  it('connects at startup with no model turn, lists its tools and sends its canary (S1)', () => {
    expect(methods('startup', 'ours')).toEqual(
      expect.arrayContaining(['initialize', 'notifications/initialized', 'tools/list']),
    );
    expect(sent('startup', 'ours')).toEqual([OURS]);
  });

  it("is the whole entry that connects when the user's local, project and user scopes each define corrallm (S2)", () => {
    // Without the flag, one of them connects, whole (the local one: its headers, not a mix).
    const before = one('sameNameBeside').heard.filter(
      (h) => h.headers['x-canary'] === 'local-scope',
    );
    expect(before.length).toBeGreaterThan(0);
    expect(
      one('sameNameBeside').heard.some(
        (h) => h.server === 'ours' || h.headers['x-evil'] !== undefined,
      ),
    ).toBe(false);
    expect(
      one('sameNameBeside').heard.some(
        (h) =>
          h.headers.authorization === 'Bearer canary-claude-user' ||
          h.headers.authorization === 'Bearer canary-claude-project',
      ),
    ).toBe(false);
    // With the flag, only ours: no other scope's headers or canary, and none of their servers.
    const withFlag = one('sameNameWithFlag').heard.filter(
      (h) => h.headers.authorization === OURS || h.server === 'ours',
    );
    expect(withFlag.map((h) => h.server)).toEqual(withFlag.map(() => 'ours'));
    expect(
      one('sameNameWithFlag').heard.some(
        (h) => h.headers['x-canary'] === 'local-scope' || h.headers['x-evil'] !== undefined,
      ),
    ).toBe(false);
    expect(sent('sameNameWithFlag', 'ours')).toEqual([OURS]);
    expect(
      one('sameNameWithFlag').heard.some(
        (h) => h.headers.authorization === 'Bearer canary-claude-local',
      ),
    ).toBe(false);
  });

  it("never runs the user's corrallm-server helper when the session's settings deny it, and does when they do not (S3)", () => {
    // Control: the helper's credential reaches the user's server without the denial.
    expect(sent('sameNameWithFlag', 'extra')).toEqual(['Bearer canary-claude-helper']);
    expect(one('switchedOff').heard.filter((h) => h.server !== 'ours')).toEqual([]);
    expect(one('switchedOff').helperRuns).toBe(0);
    expect(sent('switchedOff', 'ours')).toEqual([OURS]);
  });

  it("uses a new generation's file when a conversation is resumed (S4)", () => {
    expect(sent('resume', 'ours')).toEqual(['Bearer canary-claude-ours-gen2']);
  });

  it('lists the server as connected, source dynamic, and runs an exactly allowed tool with no prompt (T1)', () => {
    const turn = one('allowedTool');
    expect(turn.mcp_servers).toEqual([
      { name: 'corrallm', status: 'connected', source: 'dynamic' },
    ]);
    expect(turn.tools).toEqual(['mcp__corrallm__probe_delete', 'mcp__corrallm__probe_read']);
    expect(called('allowedTool')).toEqual(['probe_read']);
    expect(turn.permission_denials).toEqual([]);
    expect(turn.tool_results).toEqual(['probe ours ran probe_read']);
  });

  it('does not run a tool the settings do not allow where nothing can answer (T1)', () => {
    expect(called('deniedDestructive')).toEqual([]);
    expect(one('deniedDestructive').permission_denials).toEqual(['mcp__corrallm__probe_delete']);
  });

  it('asks for a destructive tool in the interactive Terminal, and its PermissionRequest hook names the server (T1)', () => {
    const prompt = one('terminalPrompt');
    expect(prompt.screen).toMatchObject({
      'Tool use': true,
      'corrallm — Probe Delete': true,
      'Do you want to proceed?': true,
      '1. Yes': true,
      "2. Yes, and don't ask again": true,
      '3. No': true,
    });
    expect(prompt.hooks).toHaveLength(1);
    expect(prompt.hooks?.[0]).toMatchObject({
      hook_event_name: 'PermissionRequest',
      permission_mode: 'default',
      tool_name: 'mcp__corrallm__probe_delete',
      mcp_server: { name: 'corrallm', source: 'dynamic' },
    });
    // The dialog's second choice would write an allow rule to the project's local settings.
    expect(prompt.hooks?.[0]?.permission_suggestions).toEqual([
      {
        type: 'addRules',
        rules: [{ toolName: 'mcp__corrallm__probe_delete' }],
        behavior: 'allow',
        destination: 'localSettings',
      },
    ]);
    expect(called('terminalPrompt')).toEqual(['probe_delete']);
  });

  it('runs an allowed tool in the interactive Terminal with no dialog and no hook (T1)', () => {
    const allowed = one('terminalAllowed');
    expect(allowed.screen).toMatchObject({
      'Called corrallm': true,
      'Do you want to proceed?': false,
      'Tool use': false,
    });
    expect(allowed.hooks).toEqual([]);
    expect(called('terminalAllowed')).toEqual(['probe_read']);
  });

  it("never connects when the user's settings deny corrallm or allow only other servers, and the session sees it", () => {
    for (const name of ['userDeniesServer', 'userAllowsOtherServersOnly']) {
      expect(one(name).heard, name).toEqual([]);
      expect(one(name).mcp_servers, name).toEqual([]);
      expect(one(name).warnings, name).toEqual([
        'Warning: MCP server blocked by enterprise policy: corrallm',
      ]);
    }
    // The user's allow list merges with the session's own, so naming the server there lets it in.
    expect(fixture.entry.settingsAlsoAllowingTheServer.allowedMcpServers).toEqual([
      { serverName: 'corrallm' },
    ]);
    expect(called('sessionAllowlistAddsServer')).toEqual(['probe_read']);
    expect(one('sessionAllowlistAddsServer').mcp_servers).toEqual([
      { name: 'corrallm', status: 'connected', source: 'dynamic' },
    ]);
  });

  it("lets a user's deny rule beat the session's allow: the tool is listed and never called", () => {
    expect(methods('userDeniesTool', 'ours')).toContain('tools/list');
    expect(called('userDeniesTool')).toEqual([]);
  });

  it('expands an @ mention of a file outside the project without asking (Q24)', () => {
    const { mentions } = fixture;
    expect(mentions.inside).toEqual({ 'INSIDE-CANARY': 1 });
    expect(mentions.absoluteOutside).toEqual({ 'OUTSIDE-CANARY-LINE': 3 });
    expect(mentions.dotDotOutside).toEqual({ 'OUTSIDE-CANARY-LINE': 3 });
    // The grammar: a quoted path with a space, and a line range.
    expect(mentions.quotedOutsideWithSpace).toEqual({ 'OUTSIDE-CANARY-SPACE': 1 });
    expect(mentions.outsideLineRange2to3).toEqual({ 'OUTSIDE-CANARY-LINE': 2 });
    // Typed into the interactive Terminal: read, with no permission dialog.
    expect(mentions.terminalTypedAbsoluteOutside).toEqual({
      seen: { 'OUTSIDE-CANARY-LINE': 3 },
      screen: {
        'Read ../outside/secret.txt': true,
        'Do you want to proceed?': false,
        'Yes, allow reading': false,
      },
    });
  });

  it('leaves the mention unread when the message is client_composed or the environment disables mentions (Q24)', () => {
    expect(fixture.mentions.clientComposedAbsoluteOutside).toEqual({});
    expect(fixture.mentions.disabledByEnvAbsoluteOutside).toEqual({});
  });
});
