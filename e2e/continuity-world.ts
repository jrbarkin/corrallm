import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { toolName } from '../src/shared/api/registry';
import type { ResultOf } from '../src/shared/api/registry';
import type { OpName } from '../src/shared/api/surface';
import { canvasAction, dismissStart } from './canvas-actions';
import { launchApp } from './launch';
import { closeLastWindow, reopenWindow } from './last-window';

export const CONTINUITY_QUEUE = [
  { id: 'first', message: 'continuity-first' },
  {
    id: 'check',
    if: { kind: 'outputContains', text: 'You said: continuity-first' },
    then: [{ id: 'branch', message: 'continuity-condition' }],
  },
  { id: 'next', message: 'continuity-next' },
];

/** Built app, real core and native fake; only the test holds/releases its CLI's first turn. */
export async function continuityWorld({
  terminal = false,
  queue = CONTINUITY_QUEUE,
}: { terminal?: boolean; queue?: unknown[] } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'corrallm-continuity-'));
  const profile = path.join(dir, 'profile');
  const project = path.join(dir, 'shop');
  const config = path.join(dir, 'config');
  await Promise.all([mkdir(profile), mkdir(project), mkdir(config)]);
  const canvas = randomUUID();
  const file = path.join(dir, 'continuity.corral');
  await writeFile(
    file,
    JSON.stringify({
      format: 'corrallm',
      version: 2,
      id: canvas,
      nodes: [
        {
          id: 'builder',
          kind: 'agent',
          label: 'Builder',
          position: { x: 0, y: 0 },
          adapter: 'claude-code',
          connection: terminal ? 'claude-code.terminal' : 'claude-code.sdk',
          queue,
        },
      ],
      links: [],
    }),
  );
  // Only its hash is persisted. No app flag mints a token or bypasses the normal endpoint.
  const token = `continuity-test-${randomUUID()}`;
  const hash = createHash('sha256').update(token).digest('hex');
  await writeFile(
    path.join(profile, 'tokens.json'),
    JSON.stringify({
      version: 2,
      tokens: {
        [hash]: {
          id: 'test',
          name: 'test',
          canvases: [canvas],
          access: 'write',
          expires: Date.now() + 3_600_000,
        },
      },
    }),
    { mode: 0o600 },
  );
  const native = path.resolve(
    terminal ? 'e2e/fake-claude.mjs' : 'src/main/sessions/claude-code/sdk/fake-claude.mjs',
  );
  const executable = path.join(dir, 'claude');
  await writeFile(executable, `#!/bin/sh\nexec "${process.execPath}" "${native}" "$@"\n`);
  await chmod(executable, 0o755);
  const gate = path.join(dir, 'continue');
  const promptLog = path.join(dir, 'prompts.jsonl');
  const initializeLog = path.join(dir, 'initialize.jsonl');
  const { app, close } = await launchApp({
    profile,
    diagnoseFailure: () => test.info().status !== test.info().expectedStatus,
    env: {
      CORRALLM_AGENT_PATHS: JSON.stringify({ 'claude-code': executable }),
      ANTHROPIC_API_KEY: terminal ? '' : 'sk-ant-fake',
      CLAUDE_CONFIG_DIR: config,
      FAKE_CLAUDE_PROMPTS: promptLog,
      FAKE_CLAUDE_INITIALIZE: initializeLog,
      FAKE_CLAUDE_TURN_GATES: JSON.stringify({ 'continuity-first': gate }),
    },
  });
  const client = new Client({ name: 'continuity-test', version: '1' });
  try {
    let page = await app.firstWindow();
    const problems: string[] = [];
    let successor: Page | undefined;
    const follow = () => page.on('pageerror', (error) => problems.push(error.message));
    follow();
    await page.waitForLoadState('load');
    await dismissStart(page);
    await app.evaluate(
      ({ dialog }, { project, file }) => {
        Object.assign(dialog, {
          showOpenDialog: (...args: unknown[]) => {
            const options = args.at(-1) as { properties?: string[] };
            return Promise.resolve({
              canceled: false,
              filePaths: [options.properties?.includes('openDirectory') ? project : file],
            });
          },
          showSaveDialog: () => Promise.resolve({ canceled: false, filePath: file }),
        });
      },
      { project, file },
    );
    await canvasAction(page, 'Open…');
    await expect(page.getByText('continuity.corral', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Choose a project folder' }).click();
    await expect(page.getByRole('button', { name: 'Project folder: shop' })).toBeVisible();
    const discovery = async () =>
      JSON.parse(await readFile(path.join(profile, 'api.json'), 'utf8')) as {
        url: string;
        pid: number;
      };
    await expect.poll(() => discovery().catch(() => undefined)).toBeDefined();
    const endpoint = await discovery();
    await client.connect(
      new StreamableHTTPClientTransport(new URL(endpoint.url), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    const raw = async (op: OpName, args: Record<string, unknown>): Promise<CallToolResult> =>
      (await client.callTool({ name: toolName(op), arguments: args })) as CallToolResult;
    async function call<N extends OpName>(op: N, args: Record<string, unknown>) {
      const result = await raw(op, args);
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      return result.structuredContent as ResultOf<N>;
    }
    const lines = async <T>(file: string): Promise<T[]> =>
      (await readFile(file, 'utf8').catch(() => ''))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as T);
    const terminalLog = () =>
      lines<{ event: string; text?: string; args?: string[] }>(
        path.join(project, '.fake-claude', 'log.jsonl'),
      );
    const prompts = async () =>
      terminal
        ? (await terminalLog()).filter((row) => row.event === 'prompt').map((row) => row.text)
        : (await lines<{ text: string }>(promptLog)).map((row) => row.text);
    const sessions = async () =>
      terminal
        ? (await terminalLog())
            .filter((row) => row.event === 'start')
            .map(({ args = [] }) => args[args.indexOf('--session-id') + 1])
        : (await lines<{ sessionId: string }>(initializeLog)).map((row) => row.sessionId);
    const queues = () => page.getByRole('dialog', { name: 'All queues', exact: true });
    const row = (id: string) => queues().locator(`[data-at='${JSON.stringify(['builder', id])}']`);
    const showQueues = async () => {
      await page.getByRole('button', { name: 'Show all queues' }).click();
      await expect(queues()).toBeVisible();
    };
    return {
      app,
      get page() {
        return page;
      },
      canvas,
      file,
      profile,
      endpoint,
      client,
      raw,
      call,
      discovery,
      prompts,
      sessions,
      queues,
      row,
      showQueues,
      async start() {
        await showQueues();
        await queues().getByRole('button', { name: 'Run', exact: true }).click();
        await expect(row('first')).toHaveAttribute('data-run', 'running', { timeout: 15_000 });
        await expect
          .poll(() => readFile(`${gate}.waiting`, 'utf8').catch(() => undefined), {
            timeout: 15_000,
          })
          .toBe('waiting');
        await expect.poll(sessions).toHaveLength(1);
      },
      release: () => writeFile(gate, 'go'),
      /** Closes the window (a dead one is destroyed); on Linux and Windows it only minimizes. */
      async closeWindow(options?: { destroy?: boolean }) {
        successor = await closeLastWindow(app, page, options);
      },
      async reopen() {
        const before = page;
        page = await reopenWindow(app, page, successor);
        successor = undefined;
        if (page !== before) follow();
        await page.waitForLoadState('load');
        await dismissStart(page);
      },
      async completed() {
        for (const id of ['first', 'check', 'branch', 'next']) {
          await expect(row(id)).toHaveAttribute('data-run', 'succeeded', { timeout: 15_000 });
        }
        await expect(queues().getByRole('status')).toHaveText('All done');
        expect(await prompts()).toEqual([
          'continuity-first',
          'continuity-condition',
          'continuity-next',
        ]);
        const ids = await sessions();
        expect(ids).toHaveLength(1);
        expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
        expect((await discovery()).pid).toBe(endpoint.pid);
      },
      async close() {
        try {
          await client.close();
        } finally {
          try {
            await close();
          } finally {
            await rm(dir, { recursive: true, force: true });
          }
        }
        expect(problems).toEqual([]);
      },
    };
  } catch (error) {
    await client.close().catch(() => undefined);
    try {
      await close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    throw error;
  }
}
