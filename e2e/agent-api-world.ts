import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

import type { ConnectionId } from '../src/shared/adapter';
import { newCanvasId } from '../src/shared/canvas';
import { toolName } from '../src/shared/api/registry';
import type { ResultOf } from '../src/shared/api/registry';
import type { OpName } from '../src/shared/api/surface';
import { grantOutside, keepCanvases } from '../src/main/core/store/test-store';
import { canvasAction, dismissStart } from './canvas-actions';
import { launchApp } from './launch';
import { closeLastWindow, reopenWindow } from './last-window';

/*
 * B21 C7: the built app (or `serve`) with fake agents on corrallm's own MCP. Each connection's
 * descriptor routes it, so each fake gets its session's entry and lists corrallm's tools as it
 * starts, as the real CLIs do; a turn's scripted calls (`rules`, FAKE_MCP_SCRIPT) go through
 * src/main/sessions/fake-mcp-client.mjs, and every call's outcome lands in FAKE_MCP_LOG. The test
 * itself is an outside orchestrator holding a write token for the canvas, and you in the window.
 */

export const FAKES = {
  claudeTerminal: path.resolve('src/main/sessions/claude-code/fixtures/fake-terminal.mjs'),
  claudeSdk: path.resolve('src/main/sessions/claude-code/sdk/fake-claude.mjs'),
  codexAppServer: path.resolve('src/main/sessions/codex/fake-codex.mjs'),
  codexTerminal: path.resolve('e2e/fake-codex-tui.mjs'),
};

/** The tool a step names on each adapter (its catalog's first action). */
export const STEP_TOOL: Record<string, string> = { 'claude-code': 'Bash', codex: 'exec_command' };

export interface WorldAgent {
  id: string;
  label: string;
  connection: ConnectionId;
  queue?: unknown[];
  /** The agent it is nested in (a lead's team). */
  parent?: string;
}

/** A turn's scripted calls (see fake-mcp-client.mjs). */
export interface Rule {
  when: string;
  calls?: { tool: string; args?: Record<string, unknown> }[];
  reply?: string;
  once?: boolean;
}

/** One line of FAKE_MCP_LOG. */
export interface Logged {
  pid: number;
  event?: string;
  when?: string;
  tool?: string;
  ok?: boolean;
  result?: Record<string, unknown>;
  error?: string;
  credential?: string;
  [key: string]: unknown;
}

export async function agentApiWorld({
  agents,
  links = [],
  rules = [],
  headless = false,
  grant = false,
  env: extra = {},
  setup,
}: {
  agents: WorldAgent[];
  links?: [string, string][];
  rules?: Rule[];
  headless?: boolean;
  /** The orchestrator (the test's token) was let answer approvals before anything starts. */
  grant?: boolean;
  env?: Record<string, string>;
  /** Writes what the agents' environment should hold before anything starts (the dir given). */
  setup?: (dir: string) => Promise<Record<string, string>>;
}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'corrallm-agent-api-'));
  const profile = path.join(dir, 'profile');
  const project = path.join(dir, 'shop');
  const config = path.join(dir, 'config');
  await Promise.all([mkdir(profile), mkdir(project), mkdir(config)]);
  const canvas = newCanvasId();
  const file = path.join(dir, 'agents.corral');
  await writeFile(
    file,
    JSON.stringify({
      format: 'corrallm',
      version: 3,
      id: canvas,
      nodes: agents.map(({ id, label, connection, queue, parent }, index) => ({
        id,
        kind: 'agent',
        label,
        position: { x: index * 320, y: 0 },
        adapter: connection.split('.')[0],
        connection,
        ...(queue === undefined ? {} : { queue }),
        ...(parent === undefined ? {} : { parent }),
      })),
      links: links.map((pair) => ({ agents: pair })),
    }),
  );
  await keepCanvases(profile, { [canvas]: { file, project } });
  if (grant) await grantOutside(profile, canvas, 'orchestrator');
  // Only its hash is kept. No app flag mints a token or bypasses the normal endpoint.
  const token = `agent-api-test-${randomUUID()}`;
  await writeFile(
    path.join(profile, 'tokens.json'),
    JSON.stringify({
      version: 2,
      tokens: {
        [createHash('sha256').update(token).digest('hex')]: {
          id: 'orchestrator',
          name: 'orchestrator',
          access: 'write',
          canvases: [canvas],
          expires: Date.now() + 3_600_000,
        },
      },
    }),
    { mode: 0o600 },
  );
  // One `claude` for both of Claude Code's connections: the Agent SDK runs it with stream-json.
  const claude = path.join(dir, 'claude');
  await writeFile(
    claude,
    [
      '#!/bin/sh',
      'case " $* " in',
      `  *" stream-json "*) exec "${process.execPath}" "${FAKES.claudeSdk}" "$@" ;;`,
      'esac',
      `exec "${process.execPath}" "${FAKES.claudeTerminal}" "$@"`,
      '',
    ].join('\n'),
  );
  const tui = agents.some((agent) => agent.connection === 'codex.terminal');
  const codex = path.join(dir, 'codex');
  await writeFile(
    codex,
    `#!/bin/sh\nexec "${process.execPath}" "${tui ? FAKES.codexTerminal : FAKES.codexAppServer}" "$@"\n`,
  );
  await Promise.all([chmod(claude, 0o755), chmod(codex, 0o755)]);
  const script = path.join(dir, 'script.json');
  await writeFile(script, JSON.stringify({ rules }));
  const mcpLog = path.join(dir, 'mcp.jsonl');
  const sdkPrompts = path.join(dir, 'sdk-prompts.jsonl');
  const env = {
    CORRALLM_AGENT_PATHS: JSON.stringify({ 'claude-code': claude, codex }),
    CORRALLM_FAKE_SESSIONS: '',
    CLAUDE_CONFIG_DIR: config,
    ANTHROPIC_API_KEY: 'sk-ant-fake',
    FAKE_CODEX_LOGIN: 'apikey',
    FAKE_CODEX_STATE: path.join(dir, 'threads.json'),
    FAKE_CLAUDE_PROMPTS: sdkPrompts,
    FAKE_MCP_SCRIPT: script,
    FAKE_MCP_LOG: mcpLog,
    ...(setup === undefined ? {} : await setup(dir)),
    ...extra,
  };

  let app: ElectronApplication | undefined;
  let page: Page | undefined;
  let successor: Page | undefined;
  let closeApp: (() => Promise<void>) | undefined;
  let serve: ReturnType<typeof spawn> | undefined;
  let output = '';
  const problems: string[] = [];
  const client = new Client({ name: 'agent-api-test', version: '1' });
  const discovery = async () =>
    JSON.parse(await readFile(path.join(profile, 'api.json'), 'utf8')) as {
      url: string;
      pid: number;
    };
  const close = async () => {
    await client.close().catch(() => undefined);
    try {
      if (closeApp) await closeApp();
      if (serve) {
        const child = serve;
        const ended =
          child.exitCode !== null
            ? Promise.resolve(child.exitCode)
            : new Promise<number | null>((resolve) => {
                child.once('exit', resolve);
              });
        child.kill('SIGTERM');
        let timer: ReturnType<typeof setTimeout> | undefined;
        const code = await Promise.race([
          ended,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              child.kill('SIGKILL');
              reject(new Error(`serve must close its fake agents and exit cleanly: ${output}`));
            }, 15_000);
          }),
        ]).finally(() => {
          clearTimeout(timer);
        });
        expect(code, `serve must exit cleanly after closing every fake CLI: ${output}`).toBe(0);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    expect(problems).toEqual([]);
  };
  try {
    if (headless) {
      serve = spawn(
        process.execPath,
        [
          path.resolve('dist-cli/corrallm.cjs'),
          'serve',
          '--profile',
          profile,
          '--canvas',
          file,
          '--port',
          '0',
        ],
        { env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'] },
      );
      serve.stderr?.on('data', (chunk: Buffer) => {
        output = `${output}${chunk.toString()}`.slice(-32_768);
      });
    } else {
      const launched = await launchApp({
        profile,
        env,
        diagnoseFailure: () => test.info().status !== test.info().expectedStatus,
      });
      app = launched.app;
      closeApp = launched.close;
      page = await app.firstWindow();
      page.on('pageerror', (error) => problems.push(error.message));
      await dismissStart(page);
      await app.evaluate(({ dialog }, file) => {
        Object.assign(dialog, {
          showOpenDialog: () => Promise.resolve({ canceled: false, filePaths: [file] }),
        });
      }, file);
      await canvasAction(page, 'Open…');
      await expect(page.locator('.graph-file-name')).toHaveText('agents.corral');
    }
    await expect.poll(() => discovery().catch(() => undefined), { timeout: 20_000 }).toBeDefined();
    await client.connect(
      new StreamableHTTPClientTransport(new URL((await discovery()).url), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }

  const raw = async (op: OpName, args: Record<string, unknown>): Promise<CallToolResult> =>
    (await client.callTool({ name: toolName(op), arguments: args })) as CallToolResult;
  async function call<N extends OpName>(op: N, args: Record<string, unknown> = {}) {
    const result = await raw(op, args);
    expect(result.isError, `${op}: ${JSON.stringify(result.content)}`).not.toBe(true);
    return result.structuredContent as ResultOf<N>;
  }
  const lines = async <T>(at: string): Promise<T[]> =>
    (await readFile(at, 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T);
  /** Every line the fakes logged of their corrallm calls. */
  const logged = () => lines<Logged>(mcpLog);
  /** The scripted calls of rule `when` that corrallm took (ok) or refused. */
  const calls = async (when: string) => (await logged()).filter((line) => line.when === when);
  /** Whether each agent's session has listed corrallm's tools now (`agents`' api). */
  const listed = async () =>
    Object.fromEntries(
      (await call('agents', { canvas })).agents.map((agent) => [agent.id, agent.api]),
    );
  /** Starts an agent's session with the orchestrator's message, once its tools are listed. */
  const wake = async (agent: string) => {
    await call('message', { canvas, to: agent, body: `wake ${agent}` });
    await expect
      .poll(async () => (await listed())[agent], {
        message: `${agent}'s session must list corrallm's tools`,
        timeout: 20_000,
      })
      .toBe(true);
  };
  const queues = () => window().getByRole('dialog', { name: 'All queues', exact: true });
  const row = (agent: string, id: string) =>
    queues().locator(`[data-at='${JSON.stringify([agent, id])}']`);
  function window(): Page {
    if (page === undefined) throw new Error('No window: this world runs headless.');
    return page;
  }
  return {
    dir,
    canvas,
    token,
    url: async () => (await discovery()).url,
    profile,
    project,
    config,
    get page() {
      return window();
    },
    app: () => {
      if (app === undefined) throw new Error('No app: this world runs headless.');
      return app;
    },
    call,
    raw,
    logged,
    calls,
    listed,
    wake,
    sdkPrompts: async () => (await lines<{ text: string }>(sdkPrompts)).map((one) => one.text),
    terminalLog: () =>
      lines<{ event: string; text?: string; args?: string[] }>(
        path.join(project, '.fake-claude', 'log.jsonl'),
      ),
    queues,
    row,
    async run() {
      await window().getByRole('button', { name: 'Show all queues' }).click();
      await expect(queues()).toBeVisible();
      await queues().getByRole('button', { name: 'Run', exact: true }).click();
    },
    async closeWindow() {
      if (app === undefined) throw new Error('No app: this world runs headless.');
      successor = await closeLastWindow(app, window());
    },
    async reopen() {
      if (app === undefined) throw new Error('No app: this world runs headless.');
      page = await reopenWindow(app, window(), successor);
      successor = undefined;
      page.on('pageerror', (error) => problems.push(error.message));
      await page.waitForLoadState('load');
      await dismissStart(page);
    },
    output: () => output,
    close,
  };
}
