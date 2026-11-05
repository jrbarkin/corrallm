import { agentCardName, agentChipName, connectionOptionName } from './catalog';
import { dismissStart } from './canvas-actions';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';

import { launchApp } from './launch';
import type { ConnectionId } from '../src/shared/adapter';

/*
 * What B16 built, in the built app, against fakes only (the Agent SDK fake, the native Terminal
 * fake and the Codex app-server fake: never a real CLI). Each journey pins a guarantee the core
 * enforces and the view shows from the same descriptor-backed facts; a fake certifies none of a
 * native CLI's own behaviour.
 *
 * One `claude` serves both of Claude Code's connections, as the real one does: the Agent SDK's
 * (--input-format stream-json) runs the SDK fake, anything else the Terminal fake.
 */

test.skip(process.platform === 'win32', 'The fakes are Node scripts run through sh.');

const FAKE_SDK = path.resolve('src/main/sessions/claude-code/sdk/fake-claude.mjs');
const FAKE_TERMINAL = path.resolve('e2e/fake-claude.mjs');
const FAKE_CODEX = path.resolve('src/main/sessions/codex/fake-codex.mjs');
/** One transparent pixel. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==',
  'base64',
);

let dir: string;
let folder: string;
let profile: string;
let app: ElectronApplication;
let closeApp: (() => Promise<void>) | undefined;
let page: Page;
let problems: string[];
/** Release files for the SDK fake's gated turns, by the prompt that waits on one. */
let gates: Record<string, string>;

test.beforeEach(async () => {
  closeApp = undefined;
  gates = {};
  dir = await mkdtemp(path.join(tmpdir(), 'corrallm-features-'));
  folder = path.join(dir, 'shop');
  profile = path.join(dir, 'profile');
  await mkdir(folder);
  await mkdir(profile);
  await writeFile(path.join(folder, 'README.md'), '# Shop\n');
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

/** The `claude` and `codex` the agents run: fakes, run with this Node whatever the shell's PATH has. */
async function fakes() {
  const claude = path.join(dir, 'claude');
  await writeFile(
    claude,
    `#!/bin/sh\ncase " $* " in *" --input-format "*) exec "${process.execPath}" "${FAKE_SDK}" "$@";; esac\nexec "${process.execPath}" "${FAKE_TERMINAL}" "$@"\n`,
  );
  await chmod(claude, 0o755);
  const codex = path.join(dir, 'codex');
  await writeFile(
    codex,
    `#!/bin/sh\nFAKE_CODEX_LOGIN=apikey FAKE_CODEX_STATE="${path.join(dir, 'threads.json')}" exec "${process.execPath}" "${FAKE_CODEX}" "$@"\n`,
  );
  await chmod(codex, 0o755);
  return { claude, codex };
}

async function launch() {
  const { claude, codex } = await fakes();
  ({ app, close: closeApp } = await launchApp({
    diagnoseFailure: () => test.info().status !== test.info().expectedStatus,
    env: {
      CORRALLM_AGENT_PATHS: JSON.stringify({ 'claude-code': claude, codex }),
      // The fake's key, which reaches only the fake; and a config folder of the test's own.
      ANTHROPIC_API_KEY: 'sk-ant-fake',
      CLAUDE_CONFIG_DIR: path.join(dir, 'config'),
      FAKE_CLAUDE_PROMPTS: path.join(dir, 'prompts.jsonl'),
      FAKE_CLAUDE_TURN_GATES: JSON.stringify(gates),
    },
    profile,
  }));
  page = await app.firstWindow();
  problems = [];
  page.on('console', (message) => {
    if (/^task queue exceeded allotted deadline by \d+ms$/.test(message.text())) return;
    if (message.type() === 'error' || message.type() === 'warning') {
      problems.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => {
    problems.push(error.message);
  });
  await page.waitForLoadState('load');
  await dismissStart(page);
  await expect(page.locator('.react-flow__pane')).toBeVisible();
  const canvas = path.join(dir, 'team.corral');
  await app.evaluate(
    ({ dialog }, { folder, canvas }) => {
      Object.assign(dialog, {
        showOpenDialog: (...args: unknown[]) => {
          const options = args.at(-1) as { properties?: string[] };
          const picked = options.properties?.includes('openDirectory') ? folder : canvas;
          return Promise.resolve({ canceled: false, filePaths: [picked] });
        },
        showSaveDialog: () => Promise.resolve({ canceled: false, filePath: canvas }),
      });
    },
    { folder, canvas },
  );
}

/** A canvas with one agent, Shop, on `connection`, its project folder chosen, and its view open. */
async function openShop(connection: ConnectionId): Promise<Locator> {
  const adapter = connection.split('.')[0];
  await writeFile(
    path.join(dir, 'team.corral'),
    JSON.stringify({
      format: 'corrallm',
      version: 2,
      id: randomUUID(),
      nodes: [
        {
          id: 'shop',
          kind: 'agent',
          label: 'Shop',
          position: { x: 0, y: 0 },
          adapter,
          connection,
        },
      ],
      links: [],
    }),
  );
  await page.keyboard.press('ControlOrMeta+o');
  await expect(page.locator('.react-flow__node')).toHaveAttribute(
    'aria-label',
    agentCardName('Shop', connection),
  );
  await page.getByRole('button', { name: 'Choose a project folder' }).click();
  await expect(page.getByRole('button', { name: 'Project folder: shop' })).toBeVisible();
  await page.locator('.react-flow__node').dblclick();
  return page.getByRole('dialog', { name: 'Shop', exact: true });
}

/** The prompts the SDK fake received, in order. */
async function sdkPrompts(): Promise<string[]> {
  const file = path.join(dir, 'prompts.jsonl');
  if (!existsSync(file)) return [];
  return (await readFile(file, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { text?: string; prompt?: string }).text ?? line);
}

test('a panel offers only the changes and restores its connection and point allow', async () => {
  await launch();
  const view = await openShop('claude-code.sdk');
  await expect(view.getByRole('button', { name: /^Model: / })).toBeVisible();
  const composer = view.getByRole('textbox', { name: 'Message Shop' });
  const transcript = view.getByRole('log', { name: 'Transcript' });

  // /mcp: the SDK declares reconnect, disable and enable; a server is offered those its state suits.
  await composer.fill('/mcp');
  await composer.press('Enter');
  const servers = view.getByRole('group', { name: 'MCP servers' });
  const github = servers.getByRole('listitem', { name: 'github' });
  await expect(github).toContainText('Connected');
  await expect(github.getByRole('button')).toHaveText(['Reconnect', 'Disable']);
  await github.getByRole('button', { name: 'Disable' }).click();
  await expect(github).toContainText('Disabled');
  await expect(github.getByRole('button')).toHaveText(['Enable']);
  await page.keyboard.press('Escape');
  await expect(servers).toHaveCount(0);

  // A rewind to before a message that changed no file offers the conversation alone: no code
  // restore, and no preview of files to restore.
  await composer.fill('Remember the shop');
  await composer.press('Enter');
  await expect(transcript.getByText('You said: Remember the shop')).toBeVisible();
  await expect(transcript.getByText(/^Worked for \d+s$/)).toBeVisible();
  await transcript.getByText('Remember the shop', { exact: true }).hover();
  await transcript.getByRole('button', { name: 'Rewind to here' }).click();
  const rewind = view.getByRole('group', { name: 'Rewind' });
  await expect(rewind.getByRole('button')).toHaveText(['Restore conversation', 'Cancel']);
  await expect(rewind).not.toContainText('Restore code');
  await rewind.getByRole('button', { name: 'Cancel' }).click();
  await expect(rewind).toHaveCount(0);
  // Cancelling restored nothing.
  await expect(transcript.getByText('You said: Remember the shop')).toBeVisible();
});

test('a connection that declares no panels offers none of them', async () => {
  await launch();
  const view = await openShop('codex.app-server');
  await expect(view.getByRole('button', { name: /^Model: / })).toBeVisible();
  const composer = view.getByRole('textbox', { name: 'Message Shop' });
  const transcript = view.getByRole('log', { name: 'Transcript' });

  // Its commands complete, but none opens a panel its descriptor does not declare.
  await composer.fill('/');
  const commands = view.getByRole('listbox', { name: 'Commands' }).getByRole('option');
  await expect(commands.first()).toBeVisible();
  for (const name of ['mcp', 'resume', 'rewind']) {
    await expect(commands.filter({ hasText: new RegExp(`^/${name}\\b`) })).toHaveCount(0);
  }
  await composer.fill('');

  // A message of the user's has no Rewind, and the Esc-Esc shortcut opens none.
  await composer.fill('Hello');
  await composer.press('Enter');
  await expect(transcript.getByText('You said: Hello')).toBeVisible();
  await expect(transcript.getByText(/^Worked for \d+s$/)).toBeVisible();
  await transcript.getByText('Hello', { exact: true }).hover();
  await expect(transcript.getByRole('button', { name: 'Rewind to here' })).toHaveCount(0);
  await composer.press('Escape');
  await composer.press('Escape');
  await expect(view.getByRole('group', { name: 'Rewind' })).toHaveCount(0);
  await expect(view.getByRole('group', { name: 'MCP servers' })).toHaveCount(0);
});

/** What the Terminal fake logged in the project folder: how it was started, the prompts it got. */
async function terminalLog(): Promise<{ event: string; text?: string }[]> {
  const file = path.join(folder, '.fake-claude', 'log.jsonl');
  if (!existsSync(file)) return [];
  return (await readFile(file, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { event: string; text?: string });
}
const terminalInput = async () =>
  (await terminalLog()).flatMap((entry) =>
    entry.event === 'prompt' || entry.event === 'paste'
      ? [`${entry.event}:${entry.text ?? ''}`]
      : [],
  );

test('a continuation goes to its Terminal once, with the exact text it was typed with', async () => {
  await launch();
  const view = await openShop('claude-code.sdk');
  await expect(view.getByRole('button', { name: /^Model: / })).toBeVisible();
  const composer = view.getByRole('textbox', { name: 'Message Shop' });

  // A command only the Terminal runs, typed with leading and trailing space and a second line.
  const typed = '  /theme dark\n  and light  ';
  await composer.fill(typed);
  await composer.press('Enter');
  const offer = view.getByRole('group', { name: 'Continue in Terminal?' });
  await expect(offer).toBeVisible();
  // Offering sent nothing, to either connection.
  expect(await sdkPrompts()).toEqual([]);
  expect(await terminalInput()).toEqual([]);

  // Two quick clicks are one request.
  await offer.getByRole('button', { name: 'Continue in Terminal' }).dblclick();
  await expect(view.locator('.agent-terminal')).toHaveAttribute('data-state', 'live');
  await expect.poll(terminalInput).not.toEqual([]);
  await page.waitForTimeout(500);
  const received = await terminalInput();
  expect(received).toHaveLength(1);
  expect(received[0]?.replace(/^(prompt|paste):/, '')).toBe(typed);
  expect(await sdkPrompts()).toEqual([]);
});

test('a queued message whose images the agent’s new connection cannot take stays whole and unsent, then goes where they can', async () => {
  const gate = path.join(dir, 'gate-hold');
  gates['hold the turn'] = gate;
  await launch();
  const view = await openShop('claude-code.sdk');
  await expect(view.getByRole('button', { name: /^Model: / })).toBeVisible();
  const composer = view.getByRole('textbox', { name: 'Message Shop' });
  await composer.fill('hold the turn');
  await composer.press('Enter');
  await expect.poll(() => existsSync(`${gate}.waiting`)).toBe(true);

  // An image pasted into the next message, which waits its turn: it queues, image and all.
  await composer.evaluate((field, base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], 'pixel.png', { type: 'image/png' }));
    field.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, PNG.toString('base64'));
  await expect(view.getByRole('list', { name: 'Images' })).toBeVisible();
  await composer.fill('look at this');
  await composer.press('Enter');
  const queued = view.getByRole('list', { name: 'Queued messages' });
  await expect(queued).toContainText('look at this');
  await view.getByRole('button', { name: agentChipName('claude-code.sdk'), exact: true }).click();
  await page.getByRole('option', { name: connectionOptionName('claude-code.terminal') }).click();
  // Where the agent now runs takes no images: the message waits whole, its refusal said once.
  await expect(view.locator('.agent-terminal')).toHaveAttribute('data-state', 'live');
  await expect(view.getByText('Claude Code · Terminal takes no images.')).toHaveCount(1);
  await expect(view.getByText('look at this', { exact: true })).not.toHaveCount(0);
  await page.waitForTimeout(500);
  expect(await terminalInput()).toEqual([]);
  expect(await sdkPrompts()).toEqual(['hold the turn']);

  // Back where images go, it is sent, once, with its image.
  await view
    .getByRole('button', { name: agentChipName('claude-code.terminal'), exact: true })
    .click();
  await page.getByRole('option', { name: connectionOptionName('claude-code.sdk') }).click();
  const transcript = view.getByRole('log', { name: 'Transcript' });
  await expect(transcript.getByText('You said: look at this (with 1 image)')).toBeVisible();
  expect(await sdkPrompts()).toEqual(['hold the turn', 'look at this']);
  await page.waitForTimeout(500);
  expect(await sdkPrompts()).toEqual(['hold the turn', 'look at this']);
  expect(await terminalInput()).toEqual([]);
});

test.fixme('Start new conversation replaces Restart where a connection does not resume', () => {
  // No seam without a production switch: `resume` is an effective feature each adapter's
  // connector reports from its own fixed maximum (src/main/sessions/claude-code/features.ts,
  // src/main/sessions/codex/features.ts: both true), and the built app loads only the shipped
  // adapters through src/main/sessions/adapters.ts. A fake can't declare resume: false without
  // flipping a shipped descriptor, which B16 forbids. The lifecycle is pinned by made-up
  // manager, core and renderer tests: src/renderer/agent/fresh-start.test.tsx,
  // src/main/core/session-control.test.ts and src/main/sessions/manager-features.test.ts.
});
