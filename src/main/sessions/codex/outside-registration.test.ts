import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { codex } from './adapter';

/*
 * B30 E1, replayed: what the real Codex 0.162.1 did with `corrallm-server` registered in the
 * orchestrator's own folder (.codex/config.toml), recorded in fixtures/outside-registration.json.
 * Nothing in this file starts a CLI. The fixture's probe stands in for corrallm's server; its
 * tokens are canaries, and `corrallm` on the recording's PATH was a wrapper running the built
 * command. The descriptor declares a by-file template (`registerMcpHelper`) exactly when the
 * recording shows Codex runs the helper and sends what it prints, and `registerMcpRenews` exactly
 * when it shows a renewal into the file needs no restart.
 */

type Event =
  | { probe: string; tool?: string; authorization: string | null; status: number }
  | { helper: string; env?: Record<string, string>; via: string; cwd: string }
  | { step: string };
interface Case {
  how: string;
  surface: 'app-server' | 'tui';
  trusted: boolean;
  events: Event[];
  loaded?: string[];
  projectLayer?: { disabled: boolean; reason?: string } | null;
  status?: Record<string, { name: string; tools: string[]; authStatus: string }[]>;
  calls?: Record<string, { content?: string[]; error?: unknown }>;
  screen?: string[];
}
interface Fixture {
  recordedWith: { codex: string };
  canaries: { old: string; new: string };
  entries: { env: string; helper: string };
  cases: Record<string, Case>;
}

const fixture = JSON.parse(
  readFileSync(path.join(import.meta.dirname, 'fixtures', 'outside-registration.json'), 'utf8'),
) as Fixture;
const one = (name: string): Case => {
  const found = fixture.cases[name];
  if (!found) throw new Error(`no case ${name}`);
  return found;
};
const OLD = 'Bearer canary-old-…';
const NEW = 'Bearer canary-new-…';
const probes = (events: Event[]) =>
  events.flatMap((e) =>
    'probe' in e
      ? [{ method: e.probe, tool: e.tool, auth: e.authorization, status: e.status }]
      : [],
  );
const runs = (events: Event[]) => events.filter((e) => 'helper' in e);
/** Events after the step that renewed the file. */
const afterRenewal = (events: Event[]): Event[] => {
  const at = events.findIndex((e) => 'step' in e && e.step.startsWith('renewed'));
  if (at < 0) throw new Error('no renewal');
  return events.slice(at + 1);
};
const HELPER = 'token header --from /work/smoke/tokens/orchestrator.token';

describe('the recording of an outside registration in the orchestrator folder (B30 E1)', () => {
  it('was made with the Codex the other recordings were', () => {
    expect(fixture.recordedWith.codex).toBe('0.162.1');
  });

  describe('(a) by bearer_token_env_var', () => {
    it.each(['as-env-trusted', 'tui-env-trusted'])(
      'connects at startup in a trusted folder, with the variable, on %s',
      (name) => {
        const heard = probes(one(name).events);
        expect(heard.map((p) => p.method)).toEqual(
          expect.arrayContaining(['initialize', 'tools/list']),
        );
        expect(heard.every((p) => p.auth === OLD && p.status === 200)).toBe(true);
        expect(runs(one(name).events)).toHaveLength(0);
      },
    );

    it('lists the server, connected by a bearer token, in the App Server', () => {
      const trusted = one('as-env-trusted');
      expect(trusted.loaded).toEqual(['corrallm-server']);
      expect(trusted.status?.statusStart).toEqual([
        { name: 'corrallm-server', tools: ['probe_read'], authStatus: 'bearerToken' },
      ]);
      // By a helper, Codex lists it connected with its tools but cannot say how it authenticates.
      expect(one('as-helper').status?.statusStart).toEqual([
        { name: 'corrallm-server', tools: ['probe_read'], authStatus: 'unknown' },
      ]);
    });

    it.each(['as-env-untrusted', 'tui-env-untrusted'])(
      "does not load an untrusted folder's file, on %s",
      (name) => {
        expect(one(name).events).toEqual([]);
      },
    );

    it('says in the App Server that the project layer is disabled until the folder is trusted', () => {
      for (const name of ['as-env-untrusted', 'as-helper-untrusted']) {
        expect(one(name).loaded).toEqual([]);
        expect(one(name).projectLayer).toMatchObject({ disabled: true });
        expect(one(name).projectLayer?.reason).toMatch(/trusted project/);
      }
    });

    it('asks the TUI user to trust the folder first', () => {
      expect(one('tui-env-untrusted').screen?.join('\n')).toMatch(/Trust and continue/);
    });
  });

  describe('(b) by http_headers_helper', () => {
    it.each(['as-helper', 'tui-helper'])(
      'runs `corrallm token header` before connecting and sends the file token, on %s',
      (name) => {
        const { events } = one(name);
        const first = events[0];
        expect(first).toMatchObject({ helper: HELPER, cwd: '/work/smoke/orchestrator' });
        expect(runs(events)).toHaveLength(1);
        const heard = probes(events);
        expect(heard.length).toBeGreaterThan(0);
        expect(heard.every((p) => p.auth === OLD && p.status === 200)).toBe(true);
      },
    );

    it.each(['as-helper-shell', 'tui-helper-shell'])(
      'runs the string through `sh -c`, so shell syntax in it works, on %s',
      (name) => {
        const { events } = one(name);
        const ran = runs(events)[0];
        expect(ran).toMatchObject({ env: { E1_MARK: '1' }, helper: HELPER });
        expect(ran && 'via' in ran && ran.via).toBe(
          'sh -c E1_MARK=1 corrallm token header --from "/work/smoke/tokens/orchestrator.token" && true',
        );
        expect(probes(events).every((p) => p.auth === OLD && p.status === 200)).toBe(true);
      },
    );

    it("a plain helper string is exec'd by a shell that replaces itself, with Codex as its parent", () => {
      for (const name of ['as-helper', 'tui-helper']) {
        const ran = runs(one(name).events)[0];
        expect(ran && 'via' in ran && ran.via).toBe('exec by codex');
      }
    });

    it("does not run the helper for an untrusted folder's file", () => {
      expect(one('as-helper-untrusted').events).toEqual([]);
    });

    it('the entry is the descriptor template filled', () => {
      const template = codex.descriptor.registerMcpHelper;
      expect(template).toBeDefined();
      const filled = (template ?? '')
        .replace('{server}', 'corrallm-server')
        .replace('{url}', 'http://127.0.0.1:<port>/mcp')
        .replace(
          '{helper}',
          'corrallm token header --from \\"/work/smoke/tokens/orchestrator.token\\"',
        );
      const recorded = fixture.entries.helper
        .split('\n')
        .filter((line) => !line.startsWith('default_tools_approval_mode'))
        .join('\n');
      expect(`${filled}\n`).toBe(recorded);
    });
  });

  describe('(c) after a renewal into the file, the old token refused', () => {
    it('re-runs the helper and retries once, after a 401 on a call, in the App Server', () => {
      for (const name of ['as-renew-call', 'as-renew-reload']) {
        const after = afterRenewal(one(name).events);
        const call = after.findIndex((e) => 'step' in e && e.step === 'call after renewal');
        const seen = after.slice(call + 1);
        // The connection made before the renewal still holds the old token: its call is refused,
        // the helper runs again and the same call is retried with the new token.
        expect(seen[0]).toMatchObject({
          probe: 'tools/call',
          tool: 'probe_read',
          authorization: OLD,
          status: 401,
        });
        expect(seen[1]).toMatchObject({ helper: HELPER });
        expect(seen[2]).toMatchObject({
          probe: 'tools/call',
          tool: 'probe_read',
          authorization: NEW,
          status: 200,
        });
        expect(one(name).calls?.callAfter).toEqual({ content: ['ok'] });
      }
    });

    it('re-runs the helper and retries once, after a 401 on a call, in the TUI', () => {
      const after = afterRenewal(one('tui-renew-turn').events);
      expect(after[0]).toMatchObject({
        probe: 'tools/call',
        tool: 'probe_read',
        authorization: OLD,
        status: 401,
      });
      expect(after[1]).toMatchObject({ helper: HELPER });
      expect(after[2]).toMatchObject({
        probe: 'tools/call',
        tool: 'probe_read',
        authorization: NEW,
        status: 200,
      });
      expect(one('tui-renew-turn').screen?.join('\n')).toMatch(/probe_read/);
    });

    it("runs the helper again for the App Server's MCP reload, which connects with the new token", () => {
      const after = afterRenewal(one('as-renew-reload').events);
      const reload = after.findIndex((e) => 'step' in e && e.step === 'reload');
      expect(after[reload + 1]).toMatchObject({ helper: HELPER });
      const heard = probes(
        after.slice(
          reload + 1,
          after.findIndex((e) => 'step' in e && e.step === 'call after renewal'),
        ),
      );
      expect(heard.length).toBeGreaterThan(0);
      expect(heard.every((p) => p.auth === NEW && p.status === 200)).toBe(true);
    });

    it("runs the helper again for the TUI's /mcp, which connects with the new token", () => {
      const after = afterRenewal(one('tui-renew-mcp').events);
      expect(after[0]).toMatchObject({ helper: HELPER });
      expect(probes(after).every((p) => p.auth === NEW && p.status === 200)).toBe(true);
      expect(one('tui-renew-mcp').screen?.join('\n')).toMatch(/MCP Tools/);
    });

    it('a fresh App Server after the renewal sends the new token', () => {
      const after = afterRenewal(one('as-renew-restart').events);
      expect(after.find((e) => 'helper' in e)).toBeDefined();
      expect(probes(after).every((p) => p.auth === NEW && p.status === 200)).toBe(true);
    });
  });

  describe('what the descriptor declares, from the recording', () => {
    const helperHolds = ['as-helper', 'tui-helper'].every((name) => {
      const { events } = one(name);
      const ran = runs(events).length === 1;
      const sent =
        probes(events).length > 0 &&
        probes(events).every((p) => p.auth === OLD && p.status === 200);
      return ran && sent;
    });
    const renews = ['as-renew-call', 'tui-renew-turn'].every((name) => {
      const after = afterRenewal(one(name).events);
      const refused = after.findIndex((e) => 'probe' in e && e.status === 401);
      const reran = after.findIndex((e) => 'helper' in e);
      const retried = after.findIndex(
        (e) => 'probe' in e && e.status === 200 && e.authorization === NEW,
      );
      return refused >= 0 && refused < reran && reran < retried;
    });

    it('declares the by-file template exactly when the recording shows the helper works', () => {
      expect(helperHolds).toBe(true);
      expect(codex.descriptor.registerMcpHelper).toBe(
        '[mcp_servers.{server}]\nurl = "{url}"\nhttp_headers_helper = "{helper}"',
      );
    });

    it('declares that a renewal needs no restart exactly when the recording shows a 401 re-runs the helper', () => {
      expect(renews).toBe(true);
      expect(codex.descriptor.registerMcpRenews).toBe(true);
    });
  });
});
