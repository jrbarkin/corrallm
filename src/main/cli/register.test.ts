import { describe, expect, it } from 'vitest';

import { headersHelper, registrations } from './register';

/*
 * How corrallm tells a person to register its MCP server in each installed CLI (Build Plan B30),
 * from each adapter's own `registerMcp` and `registerMcpHelper`: by the token's variable, which a
 * client reads as it starts, or, with a token file, by a headers helper that reads the file each
 * time it connects, so a renewal into the same file needs no restart.
 */

const URL = 'http://127.0.0.1:4100/mcp';

describe('registrations', () => {
  it('registers corrallm only in the installed CLIs that say how, by the token’s variable', () => {
    expect(registrations({ codex: true }, URL)).toEqual({
      byFile: [],
      byVariable: [
        `codex mcp add corrallm-server --url ${URL} --bearer-token-env-var CORRALLM_OUTSIDE_TOKEN`,
      ],
    });
    expect(registrations({ 'claude-code': true, codex: false }, URL)).toEqual({
      byFile: [],
      byVariable: [
        `claude mcp add --transport http corrallm-server ${URL} --header 'Authorization: Bearer \${CORRALLM_OUTSIDE_TOKEN}'`,
      ],
    });
    expect(registrations({}, URL)).toEqual({ byFile: [], byVariable: [] });
  });

  it('registers a CLI with a headers helper by the token’s file, and the others by its variable', () => {
    const file = '/home/me/My Tokens/corrallm';
    expect(registrations({ 'claude-code': true, codex: true }, URL, file)).toEqual({
      byFile: [
        `claude mcp add-json corrallm-server '{"type":"http","url":"${URL}","headersHelper":"corrallm token header --from \\"${file}\\""}'`,
      ],
      byVariable: [
        `codex mcp add corrallm-server --url ${URL} --bearer-token-env-var CORRALLM_OUTSIDE_TOKEN`,
      ],
    });
  });

  it('names the token’s file to its helper as one word, never the token', () => {
    expect(headersHelper('/home/me/My Tokens/corrallm')).toBe(
      'corrallm token header --from "/home/me/My Tokens/corrallm"',
    );
    expect(() => headersHelper('/home/me/$(touch x)')).toThrow(RangeError);
    expect(() => headersHelper('relative/token')).toThrow(RangeError);
  });
});
