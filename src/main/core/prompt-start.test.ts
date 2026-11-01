import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CanvasId } from '../../shared/canvas';
import type { NeedsItem } from '../../shared/model/needs';
import { SdkConnector } from '../sessions/claude-code/sdk/connector';
import { AppServerConnector } from '../sessions/codex/app-server/connector';
import type { Caller } from './caller';
import { createCore } from './core';
import type { Core } from './core';
import { keepCanvases } from './store/test-store';
import { CALLERS, NO_DESKTOP } from './test-registry';
import { legacyDirectories } from './workspaces/test-directories';

/*
 * A prompt a session raises as it starts, before its start resolves (an MCP server's form, asked
 * as its CLI starts), on each converted adapter's real connector and fake CLI (B13 C4, C5): until
 * X10 it shows once, as the event B13 replaces its session shows it too; it is refused as its
 * session is still starting (B13 C3), and answered through the owner once it runs.
 */

const CANVAS = '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f' as CanvasId;
const YOU = CALLERS.you;
const FAKE_CLAUDE = path.join(import.meta.dirname, '../sessions/claude-code/sdk/fake-claude.mjs');
const FAKE_CODEX = path.join(import.meta.dirname, '../sessions/codex/fake-codex.mjs');
/** What says how the CLI logs in, in this process's environment: left out of the agents'. */
const LOGINS =
  /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_USE_\w+)$/;

let profile: string;
/** The release files the fakes' starts wait for. */
let claudeGate: string;
let codexGate: string;
/** What the fake codex was asked and answered. */
let codexLog: string;
const cores: Core[] = [];

function canvasText(): string {
  return JSON.stringify({
    format: 'corrallm',
    version: 2,
    id: CANVAS,
    nodes: [
      {
        id: 'b',
        kind: 'agent',
        label: 'Reviewer',
        position: { x: 0, y: 0 },
        adapter: 'claude-code',
        connection: 'claude-code.sdk',
        // Started with an effort: the SDK applies it as the session starts.
        settings: { 'claude-code': { effort: 'high' } },
      },
      {
        id: 'w',
        kind: 'agent',
        label: 'Worker',
        position: { x: 300, y: 0 },
        adapter: 'codex',
        connection: 'codex.app-server',
      },
    ],
    links: [],
  });
}

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-prompt-start-'));
  const project = path.join(profile, 'project');
  await mkdir(project);
  await mkdir(path.join(profile, 'claude'));
  const file = path.join(profile, 'team.corral');
  await writeFile(file, canvasText());
  await keepCanvases(profile, { [CANVAS]: { file, project } });
  claudeGate = path.join(profile, 'claude-gate');
  codexGate = path.join(profile, 'codex-gate');
  codexLog = path.join(profile, 'codex.jsonl');
});

afterEach(async () => {
  // Whatever still waits to start goes on, so that it closes.
  await writeFile(claudeGate, 'open');
  await writeFile(codexGate, 'open');
  for (const core of cores.splice(0)) await core.close().catch(() => undefined);
  await rm(profile, { recursive: true, force: true });
});

async function start(): Promise<Core> {
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined && !LOGINS.test(entry[0]),
      ),
    ),
    ANTHROPIC_API_KEY: 'sk-ant-test',
    // Where the fake claude keeps its transcripts: never the user's own ~/.claude.
    CLAUDE_CONFIG_DIR: path.join(profile, 'claude'),
    FAKE_CLAUDE_START_GATE: claudeGate,
    FAKE_CODEX_START_GATE: codexGate,
    FAKE_CODEX_LOG: codexLog,
  };
  const core = await createCore(
    {
      profile,
      app: { name: 'corrallm', version: '9.8.7' },
      check: true,
      distribution: 'local',
      directoryResolver: legacyDirectories,
      sessions: {
        connectors: {
          'claude-code.sdk': new SdkConnector({
            clientApp: 'corrallm/test',
            findClaude: () => Promise.resolve(FAKE_CLAUDE),
          }),
          'codex.app-server': new AppServerConnector({
            clientApp: 'corrallm/0.1.0',
            findCodex: () => Promise.resolve('/fake/codex'),
            spawn: (_codex, args, options) =>
              spawn(process.execPath, [FAKE_CODEX, ...args], options),
            home: profile,
          }),
        },
        environment: () => Promise.resolve(env),
      },
      watchFolder: () => ({ close: () => undefined }),
    },
    NO_DESKTOP,
  );
  cores.push(core);
  await core.engines.open(CANVAS);
  return core;
}

async function ok(core: Core, op: string, args: object, caller: Caller = YOU): Promise<unknown> {
  const result = await core.call(op as never, { canvas: CANVAS, ...args }, caller);
  if (!result.ok) throw new Error(`${op}: ${result.error.code}: ${result.error.sentence}`);
  return result.value;
}

function call(core: Core, op: string, args: object, caller: Caller = YOU) {
  return core.call(op as never, { canvas: CANVAS, ...args }, caller);
}

/** The prompts that wait on `agent`, once its fake's start waits at its gate. */
async function waitingAt(core: Core, gate: string, agent: string): Promise<NeedsItem[]> {
  await vi.waitFor(() => readFile(`${gate}.waiting`, 'utf8'), { timeout: 20_000, interval: 20 });
  let found: NeedsItem[] = [];
  await vi.waitFor(
    async () => {
      found = ((await ok(core, 'needs', {})) as { items: NeedsItem[] }).items.filter(
        (item) => item.kind === 'prompt' && item.agent === agent,
      );
      expect(found.length).toBeGreaterThan(0);
    },
    { timeout: 20_000, interval: 20 },
  );
  // Whatever stands for it has arrived by now: its raise and its old event come together.
  await new Promise((resolve) => setTimeout(resolve, 100));
  return ((await ok(core, 'needs', {})) as { items: NeedsItem[] }).items.filter(
    (item) => item.kind === 'prompt' && item.agent === agent,
  );
}

/** Opens `gate`, and waits until `agent`'s session runs. */
async function opened(core: Core, gate: string, agent: string): Promise<void> {
  await writeFile(gate, 'open');
  await vi.waitFor(
    async () => {
      const summary = (await ok(core, 'session.get', { agent })) as { model: string | null };
      expect(summary.model).not.toBeNull();
    },
    { timeout: 20_000, interval: 20 },
  );
}

const STARTING = /still starting/;

describe('a prompt raised as a session starts', () => {
  it('Codex’s App Server: shows once, is refused while its session starts, and is answered after', async () => {
    const core = await start();
    void call(core, 'message', { to: 'w', body: 'Hello' });
    const waiting = await waitingAt(core, codexGate, 'w');
    expect(waiting).toHaveLength(1);
    const [form] = waiting;
    const answer = { form: { action: 'accept', values: { name: 'Ada' } } };
    expect(await call(core, 'reply', { to: form?.id, answer })).toMatchObject({
      ok: false,
      error: { code: 'unavailable', sentence: expect.stringMatching(STARTING) as unknown },
    });
    await opened(core, codexGate, 'w');
    expect(await call(core, 'reply', { to: form?.id, answer })).toMatchObject({
      ok: true,
      value: { outcome: 'answered' },
    });
    await vi.waitFor(
      async () => {
        const told = (await readFile(codexLog, 'utf8'))
          .split('\n')
          .filter((line) => line !== '')
          .map((line) => JSON.parse(line) as { method: string; params: unknown })
          .filter(({ method }) => method === 'answer:mcpServer/elicitation/request');
        expect(told.map(({ params }) => params)).toEqual([
          { action: 'accept', content: { name: 'Ada' }, _meta: null },
        ]);
      },
      { timeout: 10_000, interval: 20 },
    );
  }, 60_000);

  it('the Agent SDK: shows once, is refused while its session starts, and is answered after', async () => {
    const core = await start();
    void call(core, 'message', { to: 'b', body: 'Hello' });
    const waiting = await waitingAt(core, claudeGate, 'b');
    expect(waiting).toHaveLength(1);
    const [form] = waiting;
    const answer = { form: { action: 'accept', values: { repo: 'acme/shop' } } };
    expect(await call(core, 'reply', { to: form?.id, answer })).toMatchObject({
      ok: false,
      error: { code: 'unavailable', sentence: expect.stringMatching(STARTING) as unknown },
    });
    await opened(core, claudeGate, 'b');
    expect(await call(core, 'reply', { to: form?.id, answer })).toMatchObject({
      ok: true,
      value: { outcome: 'answered' },
    });
    await vi.waitFor(
      async () => {
        expect(JSON.parse(await readFile(`${claudeGate}.answer`, 'utf8'))).toMatchObject({
          action: 'accept',
          content: { repo: 'acme/shop' },
        });
      },
      { timeout: 10_000, interval: 20 },
    );
  }, 60_000);
});
