import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { claudeCode } from '../adapter';

/*
 * B21 C10, Claude Code · Agent SDK: what the real CLI did, through SDK 0.3.306, when given
 * corrallm's per-session entry as a host-registered `{ type: 'sdk', name: 'corrallm', instance }`
 * server, recorded (Claude Code 2.1.316) in fixtures/mcp-entry.json and replayed here. Nothing in
 * this file starts a CLI. The instance in the recordings answered in-process (the channel's
 * stand-in) and its model was a local stub, so no tokens were spent.
 *
 * The descriptor's `api` stays null (C7 turns it on, with these recordings), and the minimum
 * versions the evidence supports are the recorded ones.
 */

interface Status {
  name: string;
  status: string;
  transport: string;
  scope: string;
  source: string;
  tools?: string[];
  url?: string;
}
interface Case {
  how: string;
  statusBeforeTurn: Status[];
  statusAfterTurn?: Status[];
  initMcpServers?: { name: string; status: string; source: string }[];
  channelCalls?: string[];
  canUseTool?: string[];
  permissionDenials?: string[];
  helperRuns?: number;
  probesHeard: { server: string; method: string }[];
}
interface Fixture {
  recordedWith: { claude: string; sdk: string };
  minimumVersion: { claude: string; sdk: string };
  entry: {
    mcpServers: Record<string, unknown>;
    allowedTools: string[];
    settings: { deniedMcpServers: { serverName: string }[] };
  };
  cases: Record<string, Case>;
  mentions: { plain: string[]; clientComposed: string[] };
}

const fixture = JSON.parse(
  readFileSync(path.join(import.meta.dirname, 'fixtures', 'mcp-entry.json'), 'utf8'),
) as Fixture;
const one = (name: string): Case => {
  const found = fixture.cases[name];
  if (!found) throw new Error(`no case ${name}`);
  return found;
};
const SDK_ENTRY: Status = {
  name: 'corrallm',
  status: 'connected',
  transport: 'sdk',
  scope: 'dynamic',
  source: 'sdk',
  tools: ['probe_delete', 'probe_read'],
};

describe("Claude Code · Agent SDK's corrallm entry (B21 C10)", () => {
  it('keeps api null until the connection is turned on, and records its versions', () => {
    const connection = claudeCode.descriptor.connections.find(
      (one) => one.id === 'claude-code.sdk',
    );
    expect((connection as { api?: unknown } | undefined)?.api ?? null).toBeNull();
    expect(fixture.recordedWith).toEqual({
      ...fixture.recordedWith,
      claude: '2.1.316',
      sdk: '0.3.306',
    });
    expect(fixture.minimumVersion).toEqual({ claude: '2.1.316', sdk: '0.3.306' });
  });

  it('is the entry the recordings were made with', () => {
    expect(fixture.entry.mcpServers).toEqual({ corrallm: { type: 'sdk', name: 'corrallm' } });
    expect(fixture.entry.allowedTools).toEqual(['mcp__corrallm__probe_read']);
    expect(fixture.entry.settings.deniedMcpServers.map((entry) => entry.serverName)).toEqual([
      'corrallm-server',
      'corrallm-server-dev',
    ]);
  });

  it("shows the server as connected, source 'sdk', with its tools, before the first turn (S1)", () => {
    expect(one('clean').statusBeforeTurn).toEqual([SDK_ENTRY]);
    // Nothing else is contacted: the instance is in-process, with no credential to send.
    expect(one('clean').probesHeard).toEqual([]);
  });

  it("serves a call from the host's instance even when the user configures a server of the same name, though the status then names the configured one (S1)", () => {
    const same = one('sameNameConfigured');
    expect(same.channelCalls).toEqual(['probe_read']);
    // So the status, and the init event, cannot prove the entry: both read the configured one.
    expect(same.statusBeforeTurn[0]).toMatchObject({
      name: 'corrallm',
      transport: 'http',
      scope: 'local',
      source: 'local',
    });
    expect(same.initMcpServers?.find((server) => server.name === 'corrallm')?.source).toBe('local');
    // And the user's own server still connects to its own url.
    expect(same.probesHeard.some((p) => p.server === 'extra' && p.method === 'tools/list')).toBe(
      true,
    );
  });

  it('runs an allowedTools name with no canUseTool, and asks for one that is not named (T1)', () => {
    expect(one('allowedTool')).toMatchObject({
      channelCalls: ['probe_read'],
      canUseTool: [],
      permissionDenials: [],
      initMcpServers: [{ name: 'corrallm', status: 'connected', source: 'sdk' }],
    });
    expect(one('destructiveTool')).toMatchObject({
      channelCalls: [],
      canUseTool: ['mcp__corrallm__probe_delete'],
    });
  });

  it("asks even for an allowed tool when the server's tool policy says always_ask (T1)", () => {
    expect(one('alwaysAskOnAllowedTool')).toMatchObject({
      channelCalls: [],
      canUseTool: ['mcp__corrallm__probe_read'],
    });
    expect(one('alwaysAskOnDestructiveTool')).toMatchObject({
      channelCalls: [],
      canUseTool: ['mcp__corrallm__probe_delete'],
    });
  });

  it("switches the user's corrallm-server off with the settings option, and not otherwise", () => {
    expect(one('userServerNotSwitchedOff')).toMatchObject({ helperRuns: 1 });
    expect(one('userServerNotSwitchedOff').statusBeforeTurn.map((s) => s.name)).toEqual([
      'corrallm-server',
      'corrallm',
    ]);
    expect(one('userServerSwitchedOff')).toMatchObject({
      helperRuns: 0,
      probesHeard: [],
      channelCalls: ['probe_read'],
    });
    expect(one('userServerSwitchedOff').statusBeforeTurn).toEqual([SDK_ENTRY]);
  });

  it("is not blocked by the user's own deny of the name: the host-registered server stays connected", () => {
    const denied = one('userDeniesCorrallm');
    expect(denied.channelCalls).toEqual(['probe_read']);
    expect(denied.initMcpServers).toContainEqual({
      name: 'corrallm',
      status: 'connected',
      source: 'sdk',
    });
  });

  it('leaves an @ mention unexpanded on a client_composed message, and expands it otherwise (T2)', () => {
    expect(fixture.mentions.plain).toEqual(['OUTSIDE-CANARY-LINE']);
    expect(fixture.mentions.clientComposed).toEqual([]);
  });
});
