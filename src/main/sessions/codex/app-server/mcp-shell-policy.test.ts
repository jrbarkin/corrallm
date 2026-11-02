import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { SHELL_TOKEN, shellIsCurrent } from '../mcp';

interface Case {
  configRead: {
    effective: {
      set: Record<string, string>;
      exclude: string[] | null;
      include_only: string[] | null;
    };
    origins: Record<string, string>;
  };
  shell: {
    showsSessionTokenEmpty: boolean;
    showsSessionTokenValue: boolean;
    showsAgentSession: boolean;
  };
  filesHolding: { sessionToken: { afterTurn: string[]; afterSigterm: string[] } };
  probeBearer: string[];
}
const fixture = JSON.parse(
  readFileSync(path.join(import.meta.dirname, 'fixtures/mcp-shell-policy.json'), 'utf8'),
) as { cases: Record<string, Case> };
it('the recorded per-key override keeps the bearer in MCP and out of the shell and native files', () => {
  expect(SHELL_TOKEN).toBe('shell_environment_policy.set.CORRALLM_SESSION_TOKEN=""');
  for (const one of Object.values(fixture.cases)) {
    expect(one.configRead.effective.set.CORRALLM_SESSION_TOKEN).toBe('');
    expect(one.shell).toMatchObject({
      showsSessionTokenEmpty: true,
      showsSessionTokenValue: false,
      showsAgentSession: true,
    });
    expect(one.filesHolding.sessionToken).toEqual({ afterTurn: [], afterSigterm: [] });
    expect(one.probeBearer).toEqual(['Bearer SNAPTOKEN']);
    expect(
      shellIsCurrent({
        config: { shell_environment_policy: one.configRead.effective },
        origins: one.configRead.origins,
      }),
    ).toBe(true);
  }
  expect(fixture.cases.c4user?.configRead.effective.set.FOO).toBe('bar');
});
