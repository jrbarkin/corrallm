import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { AgentId, ItemId } from '../src/shared/api/ids';
import type { ResultOf } from '../src/shared/api/registry';
import { toolName } from '../src/shared/api/registry';
import type { OpName } from '../src/shared/api/surface';
import type { AgentNode, CanvasNode } from '../src/shared/model/canvas';
import { engineCatalog } from '../src/shared/model/catalog';
import type { QueueItem } from '../src/shared/model/queue';
import { keepCanvases, journaledRun } from '../src/main/core/store/test-store';
import type { SavedRun } from '../src/main/core/engine/run/checkpoint';
import { liveRun } from '../src/main/core/engine/run/test-restore';
import { launchApp } from './launch';
import { canvasAction, dismissStart } from './canvas-actions';
import { closeLastWindow, reopenWindow } from './last-window';
import { crashCoreAndReload } from './core-crash';

export const WORKER = AgentId.parse('worker');
export const HANDOFF =
  '# Handoff\nTask: finish the fallback journey.\nDone: read source.txt.\nNext: check the target and run its tests.\nDecision: retain the queue as given.';
export const LIMIT_QUEUE: QueueItem[] = [
  { id: 'warm', message: 'fallback-warm' },
  { id: 'limit', message: 'fallback-limit' },
  { id: 'next', message: 'fallback-next' },
];
interface Plan {
  ask?: boolean;
  fail?: boolean;
  reply?: string;
  gate?: string;
  reading?: Record<string, unknown>;
  usedPercent?: number;
  resetAfterSeconds?: number;
}
interface Options {
  source?: 'terminal' | 'app-server';
  chain?: boolean;
  back?: boolean;
  queue?: QueueItem[];
  gateWarm?: boolean;
  linger?: boolean;
  headless?: boolean;
  resetAfterSeconds?: number;
}
export async function fallbackWorld(options: Options = {}) {
  const source = options.source ?? 'terminal';
  const dir = await mkdtemp(path.join(tmpdir(), 'corrallm-fallback-'));
  const profile = path.join(dir, 'profile');
  const project = path.join(dir, 'shop');
  const config = path.join(dir, 'config');
  await Promise.all([mkdir(profile), mkdir(project), mkdir(config)]);
  const canvas = randomUUID();
  const file = path.join(dir, 'fallback.corral');
  const gate = path.join(dir, 'warm-release');
  const linger = path.join(dir, 'close-release');
  const nativeLimit = path.join(dir, 'codex-limits.json');
  const codexLog = path.join(dir, 'codex.jsonl');
  const now = Math.floor(Date.now() / 1000);
  const context = (used: number) => ({
    context_window: { context_window_size: 1_000_000, used_percentage: used },
  });
  const rate = (used: number) => ({
    rate_limits: { five_hour: { used_percentage: used, resets_at: now + 3600 } },
  });
  const claudeTurns: Record<string, Plan> = {
    'fallback-warm': {
      reply: 'Source work completed.\nSUCCEEDED',
      reading: { ...context(60), ...rate(12) },
      ...(options.gateWarm ? { gate } : {}),
    },
    'fallback-limit': {
      fail: true,
      resetAfterSeconds: options.resetAfterSeconds ?? 600,
      reading: { ...context(60), ...rate(100) },
    },
    ...(options.headless ? { 'codex-limit': { ask: true } } : {}),
    'fallback-return': {
      reply: 'Own backend work completed.\nSUCCEEDED',
      reading: { ...context(10), ...rate(12) },
    },
  };
  const codexTurns: Record<string, Plan> = {
    'fallback-rule': {
      reply: 'Rule-boundary work completed.',
      usedPercent: 90,
      resetAfterSeconds: 600,
    },
    'codex-limit': { fail: true, usedPercent: 100, resetAfterSeconds: 600 },
  };
  const claudeScript = path.join(dir, 'claude-script.json');
  const codexScript = path.join(dir, 'codex-script.json');
  await Promise.all([
    writeFile(claudeScript, JSON.stringify({ handoff: HANDOFF, turns: claudeTurns })),
    writeFile(codexScript, JSON.stringify({ turns: codexTurns })),
    writeFile(
      nativeLimit,
      JSON.stringify({
        limitId: 'codex',
        limitName: null,
        primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: now + 3600 },
        secondary: null,
        credits: null,
        planType: 'plus',
      }),
    ),
    writeFile(path.join(project, '.fake-claude-usage.json'), JSON.stringify(rate(12).rate_limits)),
  ]);
  const endpoint =
    source === 'terminal'
      ? { adapter: 'claude-code', connection: 'claude-code.terminal' }
      : { adapter: 'codex', connection: 'codex.app-server' };
  const target =
    source === 'terminal'
      ? { adapter: 'codex', connection: 'codex.app-server' }
      : { adapter: 'claude-code', connection: 'claude-code.terminal' };
  await writeFile(
    file,
    JSON.stringify({
      format: 'corrallm',
      version: 3,
      id: canvas,
      nodes: [
        {
          id: WORKER,
          kind: 'agent',
          label: 'Worker',
          position: { x: 0, y: 0 },
          ...endpoint,
          ...(options.chain === false
            ? {}
            : { fallback: { to: [target], ...(options.back ? { back: 'return' } : {}) } }),
          handoff: source === 'terminal' ? { at: 50 } : { off: true },
          queue: options.queue ?? LIMIT_QUEUE,
        },
      ],
      links: [],
    }),
  );
  await keepCanvases(profile, { [canvas]: { file, project } });
  const token = `fallback-test-${randomUUID()}`;
  await writeFile(
    path.join(profile, 'tokens.json'),
    JSON.stringify({
      version: 2,
      tokens: {
        [createHash('sha256').update(token).digest('hex')]: {
          id: 'fallback',
          name: 'fallback',
          access: 'write',
          canvases: [canvas],
          expires: Date.now() + 3_600_000,
        },
      },
    }),
    { mode: 0o600 },
  );
  const wrappers: Record<string, string> = {};
  for (const [adapter, native] of [
    ['claude-code', 'src/main/sessions/claude-code/fixtures/fake-terminal.mjs'],
    ['codex', 'src/main/sessions/codex/fake-codex.mjs'],
  ] as const) {
    const executable = path.join(dir, adapter);
    await writeFile(
      executable,
      `#!/bin/sh\nexec "${process.execPath}" "${path.resolve(native)}" "$@"\n`,
    );
    await chmod(executable, 0o755);
    wrappers[adapter] = executable;
  }
  const env = {
    CORRALLM_AGENT_PATHS: JSON.stringify(wrappers),
    CORRALLM_FAKE_SESSIONS: '',
    CLAUDE_CONFIG_DIR: config,
    ANTHROPIC_API_KEY: '',
    FAKE_CODEX_LOGIN: 'apikey',
    FAKE_CODEX_STATE: path.join(dir, 'threads.json'),
    FAKE_CODEX_LOG: codexLog,
    FAKE_CLAUDE_FALLBACK: claudeScript,
    FAKE_CODEX_FALLBACK: codexScript,
    FAKE_CODEX_LIMITS: nativeLimit,
    ...(options.linger ? { FAKE_CODEX_LINGER_UNTIL: linger } : {}),
  };
  let app: ElectronApplication | undefined;
  let page: Page | undefined;
  let closeApp: (() => Promise<void>) | undefined;
  let successor: Page | undefined;
  let serve: ReturnType<typeof spawn> | undefined;
  let output = '';
  const clients: Client[] = [];
  let client: Client;
  const discovery = async () =>
    JSON.parse(await readFile(path.join(profile, 'api.json'), 'utf8')) as {
      url: string;
      pid: number;
    };
  const connect = async () => {
    await expect
      .poll(() => discovery().catch(() => undefined), {
        message: 'The real core must publish its local MCP endpoint',
        timeout: 20_000,
      })
      .toBeDefined();
    const { url } = await discovery();
    client = new Client({ name: 'fallback-journey', version: '1' });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
  };
  const release = () => writeFile(gate, 'go');
  const releaseClose = () => writeFile(linger, 'go');
  const close = async () => {
    await Promise.all([release(), releaseClose()]);
    for (const client of clients) await client.close().catch(() => undefined);
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
              reject(new Error(`serve must close its fake Terminal and exit cleanly: ${output}`));
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
  };
  try {
    if (options.headless) {
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
      await dismissStart(page);
      await app.evaluate(({ dialog }, file) => {
        Object.assign(dialog, {
          showOpenDialog: () => Promise.resolve({ canceled: false, filePaths: [file] }),
        });
      }, file);
      await canvasAction(page, 'Open…');
      await expect(
        page.locator('.graph-file-name'),
        'The seeded fallback canvas must be the window’s document',
      ).toHaveText('fallback.corral');
    }
    await connect();
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
  async function call<N extends OpName>(
    op: N,
    args: Record<string, unknown> = {},
  ): Promise<ResultOf<N>> {
    const result = await client.callTool({ name: toolName(op), arguments: args });
    expect(result.isError, `${op} must succeed: ${JSON.stringify(result.content)}`).not.toBe(true);
    return result.structuredContent as ResultOf<N>;
  }
  const doc = () => call('canvas.get', { canvas });
  const run = () => call('run.get', { canvas });
  const worker = async () =>
    ((await doc()).nodes as CanvasNode[]).find(
      (node): node is AgentNode => node.id === WORKER && node.type === 'agent',
    );
  const lines = async <T>(file: string): Promise<T[]> =>
    (await readFile(file, 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T);
  const claudePrompts = async () =>
    (await lines<{ event: string; text?: string }>(path.join(project, '.fake-claude', 'log.jsonl')))
      .filter((line) => line.event === 'prompt')
      .flatMap((line) => line.text ?? []);
  const codexPrompts = async () =>
    (
      await lines<{ method: string; params?: { input?: { type: string; text?: string }[] } }>(
        codexLog,
      )
    )
      .filter((line) => line.method === 'turn/start')
      .map(
        (line) =>
          line.params?.input
            ?.flatMap((part) => (part.type === 'text' ? (part.text ?? '') : []))
            .join('') ?? '',
      );
  const checkpoint = async () => {
    const expected = await run();
    const at = expected.agents[WORKER];
    await expect
      .poll(
        () => {
          const kept = journaledRun(profile, canvas);
          return kept ? (JSON.parse(kept.state) as SavedRun).run : undefined;
        },
        {
          message: 'The durable checkpoint must include the run state this journey just observed',
          timeout: 10_000,
        },
      )
      .toMatchObject({
        running: expected.running,
        agents: {
          [WORKER]: {
            status: at?.status,
            outcomes: at?.outcomes,
            ...(at?.current === undefined ? {} : { current: at.current }),
            ...(at?.attempts === undefined ? {} : { attempts: at.attempts }),
          },
        },
      });
    const value = journaledRun(profile, canvas);
    expect(value, 'Every run journey must leave a readable durable checkpoint').toBeDefined();
    if (!value) throw new Error('No durable run checkpoint');
    const catalog = await call('catalog.get');
    const now = Date.now();
    const store = liveRun(engineCatalog(catalog), {
      send: () => () => undefined,
      tell: () => undefined,
      later: () => () => undefined,
      now: () => now,
    });
    store.update((await doc()).nodes as CanvasNode[]);
    store.restore(value.state);
  };
  return {
    dir,
    profile,
    project,
    canvas,
    gate,
    linger,
    nativeLimit,
    call,
    doc,
    run,
    worker,
    claudePrompts,
    codexPrompts,
    checkpoint,
    discovery,
    close,
    release,
    releaseClose,
    get app() {
      if (!app) throw new Error('This journey has no app');
      return app;
    },
    get page() {
      if (!page) throw new Error('This journey has no window');
      return page;
    },
    start: async () => {
      if (page) await page.getByRole('button', { name: 'Run', exact: true }).click();
      else await call('run.start', { canvas });
    },
    completed: async (item: string) => {
      await expect
        .poll(async () => (await run()).agents[WORKER]?.outcomes[ItemId.parse(item)], {
          message: `Worker must complete ${item} through its real native fake`,
          timeout: 30_000,
        })
        .toBe('succeeded');
    },
    waitGate: async () => {
      await expect
        .poll(() => existsSync(`${gate}.waiting`), {
          message: 'The source native fake must have received its gated warm-up task',
          timeout: 20_000,
        })
        .toBe(true);
    },
    closeWindow: async () => {
      if (!app || !page) throw new Error('No window');
      successor = await closeLastWindow(app, page);
    },
    reopen: async () => {
      if (!app || !page) throw new Error('No window');
      page = await reopenWindow(app, page, successor);
    },
    crash: async () => {
      if (!app || !page) throw new Error('No window');
      await crashCoreAndReload(app, page);
      await connect();
    },
  };
}
