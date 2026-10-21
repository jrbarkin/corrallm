import { dismissStart, canvasAction } from './canvas-actions';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect, test } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';

import { launchApp } from './launch';

interface CanvasNode {
  id: string;
  label: string;
  adapter?: 'claude-code' | 'codex';
  role?: string;
  connection?: 'claude-code.sdk' | 'codex.app-server';
  settings?: { 'claude-code': { model?: string; effort?: string; mode?: string } };
  queue?: { id: string; message: string }[];
}

interface Prompt {
  sessionId: string;
  text: string;
}

interface Initialization {
  sessionId: string;
  request: { appendSystemPrompt?: string; systemPromptSnapshot?: boolean };
}

interface CodexRequest {
  method: string;
  params?: {
    threadId?: string;
    developerInstructions?: string;
    input?: { type: string; text?: string }[];
  };
}

let dir: string;
let folder: string;
let canvas: string;
let app: ElectronApplication;
let closeApp: (() => Promise<void>) | undefined;
let page: Page;
let problems: string[];

test.beforeEach(async () => {
  closeApp = undefined;
  dir = await mkdtemp(path.join(tmpdir(), 'corrallm-agent-settings-'));
  folder = path.join(dir, 'shop');
  canvas = path.join(dir, 'settings.corral');
  await Promise.all([
    mkdir(folder),
    mkdir(path.join(dir, 'profile')),
    mkdir(path.join(dir, 'config')),
  ]);
  problems = [];
});

test.afterEach(async () => {
  const close = closeApp;
  closeApp = undefined;
  try {
    await close?.();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  expect(problems).toEqual([]);
});

async function launch(cli: 'claude' | 'codex' = 'claude') {
  closeApp = undefined;
  // Startup arguments show which conversation is resumed; the protocol fake separately logs
  // initialization context and user prompts, distinguishing a role from a synthetic turn.
  const fake = pathToFileURL(
    path.resolve('src/main/sessions/claude-code/sdk/fake-claude.mjs'),
  ).href;
  const claude = path.join(dir, 'fake-claude-settings.mjs');
  await writeFile(
    claude,
    `import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(path.join(dir, 'starts.jsonl'))}, JSON.stringify(process.argv.slice(2)) + '\\n');
await import(${JSON.stringify(fake)});
`,
  );
  await chmod(claude, 0o755);
  const codex = path.join(dir, 'codex');
  if (cli === 'codex') {
    await writeFile(
      codex,
      `#!/bin/sh\nexec "${process.execPath}" "${path.resolve('src/main/sessions/codex/fake-codex.mjs')}" "$@"\n`,
    );
    await chmod(codex, 0o755);
  }
  ({ app, close: closeApp } = await launchApp({
    profile: path.join(dir, 'profile'),
    env: {
      CORRALLM_CLAUDE_PATH: claude,
      CLAUDE_CONFIG_DIR: path.join(dir, 'config'),
      ANTHROPIC_API_KEY: 'sk-ant-fake',
      FAKE_CLAUDE_PROMPTS: path.join(dir, 'prompts.jsonl'),
      FAKE_CLAUDE_INITIALIZE: path.join(dir, 'initialize.jsonl'),
      ...(cli === 'codex'
        ? {
            CORRALLM_CODEX_PATH: codex,
            FAKE_CODEX_LOGIN: 'apikey',
            FAKE_CODEX_STATE: path.join(dir, 'threads.json'),
            FAKE_CODEX_LOG: path.join(dir, 'codex.jsonl'),
            FAKE_CODEX_DEVELOPER_INSTRUCTIONS: 'Native project guidance',
          }
        : {}),
    },
  }));
  page = await app.firstWindow();
  page.on('pageerror', (error) => problems.push(error.message));
  page.on('console', (message) => {
    if (/^task queue exceeded allotted deadline by \d+ms$/.test(message.text())) return;
    if (message.type() === 'error' || message.type() === 'warning') problems.push(message.text());
  });
  await page.waitForLoadState('load');
  await dismissStart(page);
  await expect(page.locator('.react-flow__pane')).toBeVisible();
}

async function openCanvas(nodes: CanvasNode[]) {
  await writeFile(
    canvas,
    JSON.stringify({
      format: 'corrallm',
      version: 2,
      id: randomUUID(),
      nodes: nodes.map((node, index) => ({
        ...node,
        kind: 'agent',
        adapter: node.adapter ?? 'claude-code',
        position: { x: index * 350, y: 0 },
      })),
      links: [],
    }),
  );
  await app.evaluate(
    ({ dialog }, { folder, canvas }) => {
      Object.assign(dialog, {
        showOpenDialog: (...args: unknown[]) => {
          const options = args.at(-1) as { properties?: string[] };
          return Promise.resolve({
            canceled: false,
            filePaths: [options.properties?.includes('openDirectory') ? folder : canvas],
          });
        },
      });
    },
    { folder, canvas },
  );
  await canvasAction(page, 'Open…');
  await expect(page.getByText('settings.corral', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Choose a project folder' }).click();
  await expect(page.getByRole('button', { name: 'Project folder: shop' })).toBeVisible();
}

async function openAgent(name: string) {
  await page.locator('.react-flow__node-agent').filter({ hasText: name }).dblclick();
  return page.getByRole('dialog', { name, exact: true });
}

const panel = () => page.getByRole('dialog', { name: /^Agent settings:/ });

async function settingsFrom(scope: Locator, name: string) {
  await scope.getByRole('button', { name: `Agent settings: ${name}`, exact: true }).click();
  await expect(panel()).toBeVisible();
  return panel();
}

async function choose(scope: Locator, field: string, value: string) {
  await scope.getByRole('button', { name: new RegExp(`^${field}:`) }).click();
  await scope.getByRole('menuitemradio', { name: new RegExp(`^${value}`) }).click();
}

async function lines<T>(name: string): Promise<T[]> {
  const contents = await readFile(path.join(dir, name), 'utf8').catch(() => '');
  return contents
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

const prompts = () => lines<Prompt>('prompts.jsonl');
const initializations = () => lines<Initialization>('initialize.jsonl');
const codexRequests = () => lines<CodexRequest>('codex.jsonl');
const starts = async () =>
  (await lines<string[]>('starts.jsonl')).filter((args) =>
    args.some((arg) => arg === '--output-format' || arg.startsWith('--output-format=')),
  );

function option(args: string[], name: string) {
  const joined = args.find((arg) => arg.startsWith(`${name}=`));
  if (joined !== undefined) return joined.slice(name.length + 1);
  const at = args.indexOf(name);
  return at < 0 ? undefined : args[at + 1];
}

test('the shared panel saves role, name and startup settings while manual Message rows stay outside the authored file', async () => {
  await launch();
  const planned = { id: 'planned', message: 'Only planned work belongs in the file' };
  await openCanvas([
    { id: 'builder', label: 'Builder', connection: 'claude-code.sdk', queue: [planned] },
  ]);
  let view = await openAgent('Builder');
  const settings = await settingsFrom(view, 'Builder');
  await expect(settings).toContainText('Agent SDK');
  await settings.getByRole('textbox', { name: 'Name', exact: true }).fill('Reviewer');
  const role = 'Review changes carefully.\nExplain any risk and verify the result.';
  await settings.getByRole('textbox', { name: 'Role', exact: true }).fill(role);
  await settings.getByRole('button', { name: /^Agent: Claude/ }).click();
  await page.keyboard.type('agent sdk');
  await page.keyboard.press('Enter');
  await choose(settings, 'Model', 'Haiku');
  await choose(settings, 'Effort', 'High');
  await choose(settings, 'Mode', 'Plan');
  await settings.getByRole('button', { name: 'Close agent settings' }).click();

  view = page.getByRole('dialog', { name: 'Reviewer', exact: true });
  const manual = 'Keep this manual note';
  const composer = view.getByRole('textbox', { name: 'Message Reviewer', exact: true });
  await composer.fill(manual);
  await composer.press('Enter');
  await expect(
    view.getByRole('log', { name: 'Transcript' }).getByText(`You said: ${manual}`),
  ).toBeVisible();
  await expect(
    view.locator('.graph-queue-message[data-submission]').filter({ hasText: manual }),
  ).toHaveAttribute('data-run', 'completed');
  await page.keyboard.press('Escape');
  await expect(view).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+s');
  await expect
    .poll(async () => JSON.parse(await readFile(canvas, 'utf8')) as { nodes: CanvasNode[] })
    .toMatchObject({
      nodes: [
        {
          label: 'Reviewer',
          role,
          connection: 'claude-code.sdk',
          settings: { 'claude-code': { model: 'haiku', effort: 'high', mode: 'plan' } },
          queue: [planned],
        },
      ],
    });
  const saved = JSON.parse(await readFile(canvas, 'utf8')) as { nodes: CanvasNode[] };
  expect(saved.nodes[0]?.queue).toEqual([planned]);
  expect(await readFile(canvas, 'utf8')).not.toContain(manual);

  await canvasAction(page, 'New');
  await expect(page.locator('.react-flow__node-agent')).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+o');
  view = await openAgent('Reviewer');
  await settingsFrom(view, 'Reviewer');
  await expect(panel().getByRole('textbox', { name: 'Role', exact: true })).toHaveValue(role);
  await expect(panel().getByRole('button', { name: 'Model: Haiku', exact: true })).toBeVisible();
  await expect(panel().getByRole('button', { name: 'Effort: High', exact: true })).toBeVisible();
  await expect(panel().getByRole('button', { name: 'Mode: Plan', exact: true })).toBeVisible();
});

test('All queues and the canvas open native settings; a role survives CLI changes and clearing removes it', async () => {
  await launch('codex');
  await openCanvas([{ id: 'builder', label: 'Builder', connection: 'claude-code.sdk' }]);
  await page.getByRole('button', { name: 'Show all queues' }).click();
  const queues = page.getByRole('dialog', { name: 'All queues', exact: true });
  const summary = queues.getByRole('button', { name: 'Agent settings: Builder', exact: true });
  await expect(summary).toContainText('Agent SDK');
  const settings = await settingsFrom(queues, 'Builder');
  const role = 'Document the public behavior and examples.';
  await settings.getByRole('textbox', { name: 'Role', exact: true }).fill(role);
  await settings.getByRole('button', { name: /^Agent: Claude/ }).click();
  await expect(settings.getByRole('option', { name: /Simulated|Qwen|Gemini/ })).toHaveCount(0);
  await page.keyboard.type('codex app server');
  await page.keyboard.press('Enter');
  await expect(settings.getByRole('textbox', { name: 'Role', exact: true })).toHaveValue(role);
  await page.keyboard.press('Escape');
  await expect(settings).toHaveCount(0);
  await expect(queues).toBeVisible();
  await expect(summary).toBeFocused();
  await expect(summary).toContainText(role);
  await expect(summary).toContainText('App Server');
  await queues.getByRole('button', { name: 'Back', exact: true }).click();

  const builder = page.locator('.react-flow__node-agent[data-id="builder"]');
  await builder.click({ button: 'right' });
  await page
    .getByRole('menu', { name: 'Builder controls', exact: true })
    .getByRole('menuitem', { name: /^Settings/ })
    .click();
  await expect(panel().getByRole('textbox', { name: 'Role', exact: true })).toHaveValue(role);
  await expect(panel()).toContainText('Codex');
  await panel().getByRole('textbox', { name: 'Role', exact: true }).fill('  \n ');
  await panel().getByRole('button', { name: 'Close agent settings' }).click();
  await page.keyboard.press('ControlOrMeta+s');
  await expect
    .poll(async () => JSON.parse(await readFile(canvas, 'utf8')) as { nodes: CanvasNode[] })
    .toMatchObject({ nodes: [{ adapter: 'codex', connection: 'codex.app-server' }] });
  const saved = JSON.parse(await readFile(canvas, 'utf8')) as { nodes: CanvasNode[] };
  expect(saved.nodes[0]).not.toHaveProperty('role');
});

test('a role is native startup context; edits wait through active work and an explicit idle restart resumes the conversation', async () => {
  await launch();
  const originalRole = 'Review behavior and explain every material risk.';
  const nextRole = 'Focus on public documentation and concrete examples.';
  await openCanvas([
    { id: 'builder', label: 'Builder', connection: 'claude-code.sdk', role: originalRole },
  ]);
  const view = await openAgent('Builder');
  const composer = view.getByRole('textbox', { name: 'Message Builder', exact: true });
  const transcript = view.getByRole('log', { name: 'Transcript' });
  const first = 'slow remember this conversation';
  await composer.fill(first);
  await composer.press('Enter');
  await expect.poll(prompts, { timeout: 15_000 }).toHaveLength(1);
  const initial = (await prompts())[0];
  expect(initial?.text).toBe(first);
  await expect.poll(starts).toHaveLength(1);
  await expect.poll(initializations).toEqual([
    {
      sessionId: initial?.sessionId,
      request: expect.objectContaining({ appendSystemPrompt: originalRole }),
    },
  ]);
  // A new conversation keeps its prompt snapshot: only a changed role, resumed, rebuilds it.
  expect((await initializations())[0]?.request).not.toHaveProperty('systemPromptSnapshot');
  await expect(transcript.getByText(/^0 1 /)).toBeVisible();

  const settings = await settingsFrom(view, 'Builder');
  await settings.getByRole('textbox', { name: 'Role', exact: true }).fill(nextRole);
  const restart = settings.getByRole('button', { name: 'Restart with these', exact: true });
  await expect(restart).toBeDisabled();
  expect(await starts()).toHaveLength(1);
  await expect(transcript.getByText(/^Worked for \d+s$/)).toBeVisible({ timeout: 10_000 });
  await expect(restart).toBeEnabled();
  expect(await starts()).toHaveLength(1);
  expect(await prompts()).toHaveLength(1);
  await expect(transcript.getByText(/^Interrupted/)).toHaveCount(0);

  await restart.click();
  await expect.poll(starts, { timeout: 15_000 }).toHaveLength(2);
  const secondStart = (await starts())[1] ?? [];
  expect(option(secondStart, '--resume')).toBe(initial?.sessionId);
  await expect.poll(initializations).toEqual([
    expect.objectContaining({ sessionId: initial?.sessionId }),
    {
      sessionId: initial?.sessionId,
      request: expect.objectContaining({
        appendSystemPrompt: nextRole,
        systemPromptSnapshot: false,
      }),
    },
  ]);
  expect(await prompts()).toHaveLength(1);
  await settings.getByRole('button', { name: 'Close agent settings' }).click();
  const second = 'Remember this correction';
  await composer.fill(second);
  await composer.press('Enter');
  await expect(transcript.getByText(`You said: ${second}`)).toBeVisible();
  await expect
    .poll(prompts)
    .toEqual([
      expect.objectContaining({ sessionId: initial?.sessionId, text: first }),
      expect.objectContaining({ sessionId: initial?.sessionId, text: second }),
    ]);
  await expect(view.locator('.graph-queue-message[data-submission]')).toHaveCount(2);
  await expect(
    view.locator('.graph-queue-message[data-submission]').filter({ hasText: originalRole }),
  ).toHaveCount(0);
  await expect(
    view.locator('.graph-queue-message[data-submission]').filter({ hasText: nextRole }),
  ).toHaveCount(0);
});

test('Codex applies a changed role in an explicit new conversation, retaining its earlier native history', async () => {
  test.skip(process.platform === 'win32', 'The fake codex is a Node script run through sh.');
  await launch('codex');
  const originalRole = 'Review behavior and explain concrete risks.';
  const nextRole = 'Document the public interface with practical examples.';
  await openCanvas([
    {
      id: 'builder',
      label: 'Builder',
      adapter: 'codex',
      connection: 'codex.app-server',
      role: originalRole,
    },
  ]);
  const view = await openAgent('Builder');
  const transcript = view.getByRole('log', { name: 'Transcript' });
  const composer = view.getByRole('textbox', { name: 'Message Builder', exact: true });
  const first = 'slow retain this original conversation';
  await composer.fill(first);
  await composer.press('Enter');
  await expect(transcript.getByRole('button', { name: 'exec_command sleep 30' })).toBeVisible({
    timeout: 15_000,
  });
  const firstTurn = (await codexRequests()).find(({ method }) => method === 'turn/start');
  const originalId = firstTurn?.params?.threadId;
  expect(originalId).toMatch(/^[0-9a-f-]{36}$/);
  expect(
    (await codexRequests()).find(({ method }) => method === 'thread/start')?.params,
  ).toMatchObject({ developerInstructions: `Native project guidance\n\n${originalRole}` });

  let settings = await settingsFrom(view, 'Builder');
  await settings.getByRole('textbox', { name: 'Role', exact: true }).fill(nextRole);
  await expect(settings).toContainText(
    'Codex keeps a conversation’s original role when it resumes.',
  );
  await expect(
    settings.getByRole('button', { name: 'Restart with these', exact: true }),
  ).toHaveCount(0);
  const fresh = () =>
    settings.getByRole('button', { name: 'Start new conversation with this role', exact: true });
  await expect(fresh()).toBeDisabled();
  expect((await codexRequests()).filter(({ method }) => method === 'thread/start')).toHaveLength(1);
  expect((await codexRequests()).filter(({ method }) => method === 'turn/interrupt')).toHaveLength(
    0,
  );
  await settings.getByRole('button', { name: 'Close agent settings' }).click();
  // Stop is an explicit user action; changing the saved role never interrupts native work.
  await view.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(transcript.getByText(/^Interrupted · \d+s$/)).toBeVisible();

  settings = await settingsFrom(view, 'Builder');
  await expect(fresh()).toBeEnabled();
  await fresh().click();
  await expect
    .poll(async () => (await codexRequests()).filter(({ method }) => method === 'thread/start'))
    .toHaveLength(2);
  const requests = await codexRequests();
  expect(requests.filter(({ method }) => method === 'thread/start')[1]?.params).toMatchObject({
    developerInstructions: `Native project guidance\n\n${nextRole}`,
  });
  expect(requests.filter(({ method }) => method === 'thread/resume')).toHaveLength(0);
  expect(requests.filter(({ method }) => method === 'turn/start')).toHaveLength(1);
  await settings.getByRole('button', { name: 'Close agent settings' }).click();
  const second = 'Remember the fresh conversation';
  await composer.fill(second);
  await composer.press('Enter');
  await expect(transcript.getByText(`You said: ${second}`)).toBeVisible();
  await expect(transcript.getByText(/^Worked for \d+s$/)).toBeVisible();

  const turns = (await codexRequests()).filter(({ method }) => method === 'turn/start');
  const currentId = turns[1]?.params?.threadId;
  expect(currentId).toMatch(/^[0-9a-f-]{36}$/);
  expect(currentId).not.toBe(originalId);
  // Roles travel as native instructions. Only the two messages authored by the user are turns.
  expect(
    turns.map(({ params }) =>
      params?.input
        ?.filter(({ type }) => type === 'text')
        .map(({ text }) => text)
        .join(''),
    ),
  ).toEqual([first, second]);
  const history = JSON.parse(await readFile(path.join(dir, 'threads.json'), 'utf8')) as Record<
    string,
    { turns: unknown[] }
  >;
  expect(Object.keys(history).sort()).toEqual([originalId, currentId].sort());
  expect(JSON.stringify(history[originalId ?? '']?.turns)).toContain(first);
  expect(JSON.stringify(history[currentId ?? '']?.turns)).toContain(second);
});
