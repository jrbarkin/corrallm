import { chmod, copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { TerminalSession } from '../terminal/session';
import { codex } from './adapter';
import { AppServerSession } from './app-server/session';

/*
 * Codex's contract: what its descriptor declares, pinned. The catalog's own checks, for every
 * adapter, are in adapters.test.ts.
 */

const { descriptor } = codex;
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

describe("Codex's adapter", () => {
  it('is codex, with Terminal first and App Server second', () => {
    expect(descriptor.id).toBe('codex');
    expect(descriptor.connections.map((one) => one.id)).toEqual([
      'codex.terminal',
      'codex.app-server',
    ]);
    expect(connection('codex.terminal').view).toBe('terminal');
    expect(connection('codex.app-server').view).toBe('transcript');
  });

  it('spends its usage backend through both connections', () => {
    expect(connection('codex.terminal').usage).toBe('codex');
    expect(connection('codex.app-server').usage).toBe('codex');
    expect(codex.usageBackends.map(({ id, windows }) => [id, windows.map((w) => w.id)])).toEqual([
      ['codex', ['fiveHour', 'weekly']],
    ]);
  });

  it('runs text starting with ! as a shell command in Terminal only', () => {
    expect(connection('codex.terminal').shellPrefix).toBe('!');
    expect(connection('codex.app-server').shellPrefix).toBeUndefined();
  });

  it('classifies every mode, and starts sessions only in those that ask', () => {
    expect(descriptor.modes.map(({ id, asks, rank }) => [id, asks, rank])).toEqual([
      ['read-only', true, 0],
      ['auto', true, 2],
      ['full-access', false, 3],
      ['plan', true, 1],
    ]);
    expect(connection('codex.terminal').startModes).toEqual(['read-only']);
    expect(connection('codex.app-server').startModes).toEqual(['read-only', 'auto', 'plan']);
  });

  it('declares what each connection’s session does when asked, and no panels', () => {
    const sessions = [
      [connection('codex.terminal'), TerminalSession.prototype],
      [connection('codex.app-server'), AppServerSession.prototype],
    ] as const;
    for (const [{ live, panels }, session] of sessions) {
      const does = declared(session);
      expect(live).toEqual(does.live);
      expect(panels.mcp !== undefined).toBe(does.mcp);
      expect(panels.rewind !== undefined).toBe(does.rewind);
      expect(panels.resume).toBeUndefined();
    }
  });

  it('adds a role to new conversations only, and resumes without listing', () => {
    expect([descriptor.role, descriptor.resume, descriptor.list]).toEqual([
      'append-new',
      true,
      false,
    ]);
  });

  it('ships its logo, and how to register an outside MCP server', () => {
    expect(descriptor.logo).toMatch(
      /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"[\s\S]*<\/svg>\n?$/,
    );
    expect(descriptor.logo).not.toMatch(/<script|on\w+=/i);
    for (const placeholder of ['{server}', '{url}', '{var}']) {
      expect(descriptor.registerMcp).toContain(placeholder);
    }
    expect(descriptor.registerMcp).toMatch(/^codex mcp add /);
  });
});

describe.skipIf(process.platform === 'win32')("Codex's usage reader", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reads its plan’s limits from a private app server of the user’s codex, and nothing else', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'corrallm-codex-usage-'));
    try {
      const fake = path.join(dir, 'codex.mjs');
      await copyFile(path.join(import.meta.dirname, 'fake-codex.mjs'), fake);
      await chmod(fake, 0o755);
      vi.stubEnv('CORRALLM_AGENT_PATHS', JSON.stringify({ codex: fake }));
      const context = { env: { PATH: path.dirname(process.execPath) }, cwd: dir, executable: fake };
      expect(await codex.readUsage?.('codex', context)).toMatchObject({
        fiveHour: { usedPercent: 12 },
        weekly: { usedPercent: 3 },
      });
      // Not its backend; no codex.
      expect(await codex.readUsage?.('claude-code', context)).toBeUndefined();
      vi.stubEnv('CORRALLM_AGENT_PATHS', JSON.stringify({ codex: path.join(dir, 'no-codex') }));
      // Discovery is the platform's, not this reader's: it uses only the supplied executable.
      expect(await codex.readUsage?.('codex', context)).toMatchObject({
        fiveHour: { usedPercent: 12 },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
