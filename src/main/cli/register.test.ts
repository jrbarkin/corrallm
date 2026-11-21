import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  commandLauncher,
  headersHelper,
  helperInvocation,
  registrationLines,
  registrations,
} from './register';

/*
 * How corrallm tells a person to register its MCP server in each installed CLI (Build Plan B30),
 * from each adapter's own `registerMcp` and `registerMcpHelper`: by the token's variable, which a
 * client reads as it starts, or, with a token file, by a headers helper that reads the file each
 * time it connects, so a renewal into the same file needs no restart. A registration that is text
 * for a file in the orchestrator's own folder (`registerMcpIn`) is printed, never written.
 */

const URL = 'http://127.0.0.1:4100/mcp';

const SNIPPET = `[mcp_servers.corrallm-server]\nurl = "${URL}"\nbearer_token_env_var = "CORRALLM_OUTSIDE_TOKEN"`;

let folder: string;
beforeEach(() => {
  folder = realpathSync(mkdtempSync(path.join(tmpdir(), 'register-')));
});
afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});
function file(relative: string): string {
  const at = path.join(folder, relative);
  mkdirSync(path.dirname(at), { recursive: true });
  writeFileSync(at, '');
  chmodSync(at, 0o755);
  return at;
}

describe('registrations', () => {
  it.skipIf(process.platform === 'win32')(
    'uses the current absolute Node and bundle when a checkout has no command on PATH',
    () => {
      const node = file('node bin/node');
      const bundle = file('checkout/dist-cli/corrallm.cjs');
      expect(helperInvocation({ searchPath: '', node, bundle })).toMatchObject({
        command: [node, bundle],
        files: [node, bundle],
        note: expect.stringContaining('absolute') as string,
      });
    },
  );

  it.skipIf(process.platform === 'win32')(
    'does not infer a packaged launcher from a source checkout’s sibling bin folder',
    () => {
      const bundle = file('checkout/dist-cli/corrallm.cjs');
      file('checkout/bin/corrallm');
      expect(commandLauncher(bundle)).toBeUndefined();
    },
  );

  it.skipIf(process.platform === 'win32')(
    'uses the absolute launcher when a relative PATH entry precedes its installed name',
    () => {
      const node = file('app/cli/node');
      const bundle = file('app/cli/corrallm.cjs');
      const launcher = file('app/bin/corrallm');
      const found = helperInvocation({
        searchPath: `.${path.delimiter}${path.dirname(launcher)}`,
        node,
        bundle,
        launcher,
      });
      expect(found.command).toEqual([launcher]);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'uses the packaged launcher when PATH resolves another command, and keeps its own installed name',
    () => {
      const node = file('app/cli/node');
      const bundle = file('app/cli/corrallm.cjs');
      const launcher = file('app/bin/corrallm');
      const other = file('other/corrallm');
      expect(commandLauncher(bundle)).toBe(launcher);
      expect(
        helperInvocation({ searchPath: path.dirname(other), node, bundle, launcher }),
      ).toMatchObject({
        command: [launcher],
        files: [launcher],
        note: expect.stringContaining('absolute') as string,
      });
      mkdirSync(path.join(folder, 'bin'));
      symlinkSync(launcher, path.join(folder, 'bin/corrallm'));
      const installed = helperInvocation({
        searchPath: path.join(folder, 'bin'),
        node,
        bundle,
        launcher,
      });
      expect(installed).toEqual({ command: ['corrallm'], files: [launcher] });
      expect(registrations({ codex: true }, URL, '/home/me/token', installed.command)).toEqual(
        registrations({ codex: true }, URL, '/home/me/token'),
      );
    },
  );

  it.skipIf(process.platform === 'win32')(
    'keeps spaces, quotes and shell characters literal in both registration formats',
    () => {
      const command = [
        '/home/user/Node \'one\' "$PATH" $&/node',
        '/work/corrallm \'two\' "build" $`/dist-cli/corrallm.cjs',
      ];
      const tokenFile = '/home/user/My \'Tokens\' "$HOME" `literal` \\ path/corrallm';
      const { byFile } = registrations(
        { 'claude-code': true, codex: true },
        URL,
        tokenFile,
        command,
      );
      const shell = byFile.find(({ name }) => name === 'Claude Code')?.text ?? '';
      // Parse the command as shell arguments without invoking a native CLI.
      const json = execFileSync('/bin/sh', ['-c', `set -- ${shell}; printf '%s' "$5"`], {
        encoding: 'utf8',
      });
      const a = (JSON.parse(json) as { headersHelper: string }).headersHelper;
      const toml = byFile.find(({ name }) => name === 'Codex')?.text ?? '';
      const b = JSON.parse(toml.split('http_headers_helper = ')[1] ?? '') as string;
      expect(a).toBe(b);
      for (const helper of [a, b]) {
        const words = execFileSync('/bin/sh', ['-c', `set -- ${helper}; printf '%s\\n' "$@"`], {
          encoding: 'utf8',
        })
          .trimEnd()
          .split('\n');
        expect(words).toEqual([...command, 'token', 'header', '--from', tokenFile]);
      }
    },
  );
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

  it('registers a CLI with a headers helper by the token’s file, Codex as text for its folder’s file', () => {
    const file = '/home/me/My Tokens/corrallm';
    expect(registrations({ 'claude-code': true, codex: true }, URL, file)).toEqual({
      byFile: [
        {
          name: 'Claude Code',
          text: `claude mcp add-json corrallm-server '{"type":"http","url":"${URL}","headersHelper":"corrallm token header --from \\"${file}\\""}'`,
          renews: true,
        },
        {
          name: 'Codex',
          text: `[mcp_servers.corrallm-server]\nurl = "${URL}"\nhttp_headers_helper = "corrallm token header --from \\"${file}\\""`,
          in: '.codex/config.toml',
          renews: true,
        },
      ],
      byVariable: [],
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
    expect(() => headersHelper('/home/me/a\nb')).toThrow(RangeError);
    expect(() => headersHelper('relative/token')).toThrow(RangeError);
  });
});
