import { describe, expect, it } from 'vitest';

import { routeOf } from '../../../shared/routing';
import { signalsOf } from './sdk/raise';
import type { ToolOptions } from './sdk/raise';
import { recorded } from './sdk/recorded';
import type { Fixture } from './sdk/recorded';
import { SdkSession } from './sdk/session';
import { TerminalSession } from '../terminal/session';
import { claudeCode } from './adapter';

/*
 * Claude Code's contract: what its descriptor declares, pinned. The catalog's own checks, for
 * every adapter, are in adapters.test.ts.
 */

const { descriptor } = claudeCode;
const connection = (id: string) => {
  const found = descriptor.connections.find((one) => one.id === id);
  if (!found) throw new Error(`no ${id}`);
  return found;
};

/** What a session class does when corrallm asks, as a descriptor declares it. */
function declared(session: object) {
  const has = (method: string) => typeof Reflect.get(session, method) === 'function';
  return {
    live: { effort: has('setEffort'), stopTask: has('stopTask') },
    mcp: has('mcpServers') && has('changeMcpServer'),
    rewind: has('rewindFiles'),
  };
}

describe("Claude Code's adapter", () => {
  it('routes the agent API on each connection as its recording proves it (B21 C7)', () => {
    // Terminal: the session's own --mcp-config entry over http, recorded with Claude Code 2.1.316
    // (fixtures/mcp-entry.json, replayed by mcp-entry.test.ts). The Agent SDK: its host-registered
    // channel, recorded with SDK 0.3.306 (sdk/fixtures/mcp-entry.json, sdk/mcp-entry.test.ts).
    expect(connection('claude-code.terminal').api).toBe('http');
    expect(connection('claude-code.sdk').api).toBe('channel');
  });

  it('declares native file mentions on Terminal only', () => {
    expect(connection('claude-code.terminal')).toHaveProperty('fileMentions', true);
    expect(connection('claude-code.sdk')).not.toHaveProperty('fileMentions');
  });

  it('declares context on both connections, proven by the recordings of real automatic compactions', () => {
    // The Agent SDK: sdk/translate.test.ts replays sdk/fixtures/auto-compact.jsonl and
    // no-auto-compact.jsonl. The Terminal: statusline.test.ts replays
    // fixtures/status-line-compaction.jsonl (Claude Code 2.1.316, B11a C4).
    expect(connection('claude-code.terminal').context).toBe(true);
    expect(connection('claude-code.sdk').context).toBe(true);
  });

  it('declares the four prompt kinds per connection, and signals only where recordings prove them', () => {
    expect(connection('claude-code.terminal')).toMatchObject({
      prompts: { approval: 'seen', question: 'seen', plan: 'seen', form: 'none' },
      signals: false,
    });
    expect(connection('claude-code.sdk')).toMatchObject({
      prompts: {
        approval: 'answerable',
        question: 'answerable',
        plan: 'answerable',
        form: 'answerable',
      },
      signals: true,
    });
    // The Agent SDK's promise (B13 Design §9.2 C4): the real CLI's ask rule and safety check,
    // recorded, each carry what its signals read. A Terminal's hooks carry neither.
    const first = (fixture: Fixture) => {
      const found = recorded(fixture).find((item) => item.kind === 'canUseTool');
      if (found?.kind !== 'canUseTool') throw new Error(`nothing asked in ${fixture}`);
      return signalsOf(found.data.tool, found.data.opts as unknown as ToolOptions);
    };
    expect(first('ask-rule')).toEqual({ askRule: true });
    expect(first('safety-check')).toEqual({ safetyCheck: true });
  });

  it('is claude-code, with Terminal first and the Agent SDK second', () => {
    expect(descriptor.id).toBe('claude-code');
    expect(descriptor.connections.map((one) => one.id)).toEqual([
      'claude-code.terminal',
      'claude-code.sdk',
    ]);
    expect(connection('claude-code.terminal').view).toBe('terminal');
    expect(connection('claude-code.sdk').view).toBe('transcript');
  });

  it('runs text starting with ! as a shell command in Terminal only', () => {
    expect(connection('claude-code.terminal').shellPrefix).toBe('!');
    expect(connection('claude-code.sdk').shellPrefix).toBeUndefined();
    expect(connection('claude-code.sdk').continueIn).toMatchObject({
      connection: 'claude-code.terminal',
      shell: true,
      mcpSignIn: true,
    });
  });

  it('continues only a bare /config in Terminal: with a setting, the session’s own runs (B16 C2)', () => {
    const commands = connection('claude-code.sdk').continueIn?.commands ?? [];
    expect(commands.filter(({ bare }) => bare === true).map(({ name }) => name)).toEqual([
      'config',
    ]);
    const context = {
      connection: connection('claude-code.sdk'),
      target: connection('claude-code.terminal'),
      offered: [{ name: 'config', description: '', argumentHint: '' }],
    };
    expect(routeOf('/config', context)).toMatchObject({ kind: 'continue' });
    expect(routeOf('/config theme dark', context)).toEqual({ kind: 'command', name: 'config' });
    expect(routeOf('/login', context)).toMatchObject({ kind: 'continue' });
    expect(routeOf('!ls', context)).toMatchObject({ kind: 'shell', command: 'ls' });
    expect(routeOf('/rewind', context)).toEqual({ kind: 'panel', panel: 'rewind' });
  });

  it('classifies every mode, and starts sessions only in those that ask', () => {
    expect(descriptor.modes.map(({ id, asks, rank }) => [id, asks, rank])).toEqual([
      ['manual', true, 1],
      ['acceptEdits', true, 2],
      ['plan', true, 0],
      ['bypassPermissions', false, 4],
      ['auto', true, 3],
    ]);
    for (const { startModes } of descriptor.connections) {
      expect(startModes).toEqual(['manual', 'acceptEdits', 'plan', 'auto']);
    }
  });

  it('declares what each connection’s session does when asked, and its panels', () => {
    const sessions = [
      [connection('claude-code.terminal'), TerminalSession.prototype],
      [connection('claude-code.sdk'), SdkSession.prototype],
    ] as const;
    for (const [{ live, panels }, session] of sessions) {
      const does = declared(session);
      expect(live).toEqual(does.live);
      expect(panels.mcp !== undefined).toBe(does.mcp);
      expect(panels.rewind !== undefined).toBe(does.rewind);
    }
    expect(connection('claude-code.sdk').panels).toEqual({
      resume: true,
      mcp: { changes: ['reconnect', 'disable', 'enable'] },
      rewind: { restores: ['both', 'conversation', 'code'] },
    });
  });

  it('appends a role on every launch, and resumes and lists its conversations', () => {
    expect([descriptor.role, descriptor.resume, descriptor.list]).toEqual(['append', true, true]);
  });

  it('ships its logo, and how to register an outside MCP server', () => {
    expect(descriptor.logo).toMatch(
      /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"[\s\S]*<\/svg>\n?$/,
    );
    expect(descriptor.logo).not.toMatch(/<script|on\w+=/i);
    for (const placeholder of ['{server}', '{url}', '{var}']) {
      expect(descriptor.registerMcp).toContain(placeholder);
    }
    expect(descriptor.registerMcp).toMatch(/^claude mcp add --transport http /);
    // A command run in the orchestrator's folder (local scope), not text for a file; it renews.
    expect(descriptor.registerMcpIn).toBeUndefined();
    expect(descriptor.registerMcpRenews).toBe(true);
  });

  it('registers an outside MCP server with a headers helper, run at every connect, so a renewed token needs no restart', () => {
    const template = descriptor.registerMcpHelper ?? '';
    for (const placeholder of ['{server}', '{url}', '{helper}']) {
      expect(template).toContain(placeholder);
    }
    // Claude Code's own JSON for an HTTP server, single-quoted for the shell.
    const filled = template
      .replaceAll('{server}', 'corrallm-server')
      .replaceAll('{url}', 'http://127.0.0.1:4100/mcp')
      .replaceAll('{helper}', 'corrallm token header --from \\"/home/me/token\\"');
    const [, json] = /^claude mcp add-json corrallm-server '([^']*)'$/.exec(filled) ?? [];
    expect(JSON.parse(json ?? '')).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:4100/mcp',
      headersHelper: 'corrallm token header --from "/home/me/token"',
    });
  });
});
