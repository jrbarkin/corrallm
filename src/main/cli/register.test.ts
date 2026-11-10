import { describe, expect, it } from 'vitest';

import { headersHelper, registrationLines, registrations } from './register';

/*
 * How corrallm tells a person to register its MCP server in each installed CLI (Build Plan B30),
 * from each adapter's own `registerMcp` and `registerMcpHelper`: by the token's variable, which a
 * client reads as it starts, or, with a token file, by a headers helper that reads the file each
 * time it connects, so a renewal into the same file needs no restart. A registration that is text
 * for a file in the orchestrator's own folder (`registerMcpIn`) is printed, never written.
 */

const URL = 'http://127.0.0.1:4100/mcp';

const SNIPPET = `[mcp_servers.corrallm-server]\nurl = "${URL}"\nbearer_token_env_var = "CORRALLM_OUTSIDE_TOKEN"`;

describe('registrations', () => {
  it('registers corrallm in each installed CLI that says how, by the token’s variable: a command, or text for a file in the orchestrator’s folder', () => {
    expect(registrations({ codex: true }, URL)).toEqual({
      byFile: [],
      byVariable: [{ name: 'Codex', text: SNIPPET, in: '.codex/config.toml', renews: false }],
    });
    expect(registrations({ 'claude-code': true, codex: false }, URL)).toEqual({
      byFile: [],
      byVariable: [
        {
          name: 'Claude Code',
          text: `claude mcp add --transport http corrallm-server ${URL} --header 'Authorization: Bearer \${CORRALLM_OUTSIDE_TOKEN}'`,
          renews: false,
        },
      ],
    });
    expect(registrations({}, URL)).toEqual({ byFile: [], byVariable: [] });
  });

  it('never gives Codex a command that registers it user-wide', () => {
    const { byVariable, byFile } = registrations({ codex: true }, URL, '/home/me/token');
    for (const { text } of [...byVariable, ...byFile]) expect(text).not.toMatch(/codex mcp add/);
  });

  it('registers a CLI with a headers helper by the token’s file, and the others by its variable', () => {
    const file = '/home/me/My Tokens/corrallm';
    expect(registrations({ 'claude-code': true, codex: true }, URL, file)).toEqual({
      byFile: [
        {
          name: 'Claude Code',
          text: `claude mcp add-json corrallm-server '{"type":"http","url":"${URL}","headersHelper":"corrallm token header --from \\"${file}\\""}'`,
          renews: true,
        },
      ],
      byVariable: [{ name: 'Codex', text: SNIPPET, in: '.codex/config.toml', renews: false }],
    });
  });

  it('prints a command as it is and text for a file with where it goes, saying corrallm does not write it', () => {
    const { byVariable } = registrations({ 'claude-code': true, codex: true }, URL);
    expect(registrationLines(byVariable)).toEqual([
      `  claude mcp add --transport http corrallm-server ${URL} --header 'Authorization: Bearer \${CORRALLM_OUTSIDE_TOKEN}'`,
      '',
      '  Codex: in your orchestrator’s folder, add this to .codex/config.toml (corrallm doesn’t write it):',
      '',
      '    [mcp_servers.corrallm-server]',
      `    url = "${URL}"`,
      '    bearer_token_env_var = "CORRALLM_OUTSIDE_TOKEN"',
    ]);
  });

  it('names the token’s file to its helper as one word, never the token', () => {
    expect(headersHelper('/home/me/My Tokens/corrallm')).toBe(
      'corrallm token header --from "/home/me/My Tokens/corrallm"',
    );
    expect(() => headersHelper('/home/me/$(touch x)')).toThrow(RangeError);
    expect(() => headersHelper('relative/token')).toThrow(RangeError);
  });
});
