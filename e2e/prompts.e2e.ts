import { expect, test } from '@playwright/test';

import { mcpRequestTitle } from '../src/shared/model/words';
import { agentCardName, agentChipName } from './catalog';
import { dismissStart, openNeeds } from './canvas-actions';
import { continuityWorld } from './continuity-world';
import { crashCoreAndReload } from './core-crash';

// The built app and real SDK protocol fake, with a normally reached outside MCP caller.
test.skip(process.platform === 'win32', 'The native fake uses a sh wrapper.');
let world: Awaited<ReturnType<typeof continuityWorld>>;
let closeWorld: (() => Promise<void>) | undefined;
test.beforeEach(async () => {
  closeWorld = undefined;
  world = await continuityWorld({ queue: [] });
  closeWorld = () => world.close();
  const card = world.page.locator('.react-flow__node-agent');
  await expect(card).toHaveAttribute('aria-label', agentCardName('Builder', 'claude-code.sdk'));
  await card.dblclick();
  await expect(
    view().getByRole('button', { name: agentChipName('claude-code.sdk'), exact: true }),
  ).toBeVisible();
  await expect(
    view().getByRole('button', { name: 'Model: Default (recommended)', exact: true }),
  ).toBeVisible();
});
test.afterEach(async () => {
  await closeWorld?.();
});

const view = () => world.page.getByRole('dialog', { name: 'Builder', exact: true });
const transcript = () => view().getByRole('log', { name: 'Transcript', exact: true });
async function send(text: string) {
  const composer = view().getByRole('textbox', { name: 'Message Builder', exact: true });
  await composer.fill(text);
  await composer.press('Enter');
}
async function currentNeed() {
  const items = (await world.call('needs', { canvas: world.canvas })).items.filter(
    (item) => item.kind === 'prompt',
  );
  expect(items).toHaveLength(1);
  const item = items[0];
  if (!item) throw new Error('No current prompt');
  expect(item.choices).toEqual([]);
  return item;
}
async function tokenViews() {
  return Promise.all([
    world.call('needs', { canvas: world.canvas }),
    world.call('status', { canvas: world.canvas }),
    world.call('session.get', { canvas: world.canvas, agent: 'builder' }),
    world.call('session.transcript', { canvas: world.canvas, agent: 'builder' }),
    world.call('messages', { canvas: world.canvas }),
  ]);
}
async function tokenCannotReply(answer: Record<string, unknown>) {
  const item = await currentNeed();
  const refused = await world.raw('reply', { canvas: world.canvas, to: item.id, answer });
  expect(refused.isError).toBe(true);
  expect(JSON.stringify(refused.content)).toMatch(/Only (you|the user).*answer/);
  expect((await currentNeed()).id).toBe(item.id);
  return item;
}

test('keeps the same approval across reload, rejects unoffered decisions, and sends feedback once from Needs', async () => {
  await send('please run it');
  let approval = transcript().getByRole('group', { name: 'Claude wants to use Bash', exact: true });
  await expect(approval).toContainText('echo hello');
  const need = await tokenCannotReply({ choice: 'allow' });
  const forged = await world.page.evaluate(
    ({ canvas, to }) => window.api.reply({ canvas, to, answer: { choice: 'invented' } }),
    { canvas: world.canvas, to: need.id },
  );
  expect(forged.ok).toBe(false);
  expect(await world.answers()).toEqual([]);
  const starts = await world.sessions();
  await world.page.reload();
  await dismissStart(world.page);
  expect((await currentNeed()).id).toBe(need.id);
  expect(await world.sessions()).toEqual(starts);
  await openNeeds(world.page);
  approval = world.page
    .getByRole('complementary', { name: 'Needs you' })
    .getByRole('group', { name: 'Claude wants to use Bash', exact: true });
  await approval
    .getByRole('button', { name: 'No, and tell Claude what to do differently', exact: true })
    .click();
  await expect(approval.getByRole('button', { name: 'Send feedback', exact: true })).toBeDisabled();
  await approval
    .getByRole('textbox', { name: 'Feedback', exact: true })
    .fill('Use the existing check instead.');
  expect(JSON.stringify(await tokenViews())).not.toContain('Use the existing check instead.');
  await approval.getByRole('button', { name: 'Send feedback', exact: true }).click();
  await expect(approval).toHaveCount(0);
  await world.page.locator('.react-flow__node-agent').dblclick();
  const ended = transcript().getByRole('group', { name: 'Claude wants to use Bash', exact: true });
  await expect(ended.getByRole('status')).toHaveText('Declined by you.');
  await expect(ended).not.toContainText('Use the existing check instead.');
  await expect(transcript().getByText(/^Worked for \d+s$/)).toHaveCount(1);
  expect(await world.prompts()).toEqual(['please run it']);
  expect(await world.answers()).toEqual([
    expect.objectContaining({
      request: expect.objectContaining({ tool_name: 'Bash' }),
      answer: expect.objectContaining({
        behavior: 'deny',
        message: expect.stringContaining('Use the existing check instead.'),
        interrupt: false,
      }),
    }),
  ]);
  const entries = (
    await world.call('session.transcript', { canvas: world.canvas, agent: 'builder' })
  ).entries.filter((entry) => entry.kind === 'prompt');
  expect(entries).toHaveLength(1);
  expect(JSON.stringify(entries)).not.toContain('Use the existing check instead.');
});

test('raises an approval with its view closed, and never replays or reopens it after a core crash', async () => {
  await view().getByRole('button', { name: 'Back to the canvas', exact: true }).click();
  await expect(view()).toHaveCount(0);
  await world.call('message', {
    canvas: world.canvas,
    to: 'agent:builder',
    body: 'please run it with the view closed',
  });
  await expect
    .poll(
      async () =>
        (await world.call('needs', { canvas: world.canvas })).items.filter(
          (item) => item.kind === 'prompt',
        ).length,
    )
    .toBe(1);
  const need = await currentNeed();
  const prompts = await world.prompts();
  const starts = await world.sessions();
  await openNeeds(world.page);
  const needs = world.page.getByRole('complementary', { name: 'Needs you' });
  await expect(
    needs.getByRole('group', { name: 'Claude wants to use Bash', exact: true }),
  ).toBeVisible();
  await needs.getByRole('button', { name: 'Open Builder', exact: true }).click();
  await expect(
    transcript().getByRole('group', { name: 'Claude wants to use Bash', exact: true }),
  ).toBeVisible();
  expect((await currentNeed()).id).toBe(need.id);
  expect(await world.sessions()).toEqual(starts);
  expect(await world.answers()).toEqual([]);

  await crashCoreAndReload(world.app, world.page);
  await dismissStart(world.page);
  await world.reconnectApi();
  expect(
    (await world.call('needs', { canvas: world.canvas })).items.map((item) => item.id),
  ).not.toContain(need.id);
  const stale = await world.raw('reply', {
    canvas: world.canvas,
    to: need.id,
    answer: { choice: 'allow' },
  });
  expect(stale.isError).toBe(true);
  await world.page.locator('.react-flow__node-agent').dblclick();
  await expect(
    view().getByRole('button', { name: 'Model: Default (recommended)', exact: true }),
  ).toBeVisible();
  await expect(transcript().locator('.prompt-card:not(.prompt-ended)')).toHaveCount(0);
  await expect(transcript().getByRole('button', { name: 'Yes', exact: true })).toHaveCount(0);
  expect(await world.answers()).toEqual([]);
  expect(await world.prompts()).toEqual(prompts);
  await send('After recovery');
  await expect(transcript().getByText('You said: After recovery', { exact: true })).toBeVisible();
  expect(await world.prompts()).toEqual([...prompts, 'After recovery']);
  expect(await world.answers()).toEqual([]);
});

test('answers picked and typed SDK questions in All queues and approves its plan in the window', async () => {
  await send('ask combined');
  await expect(
    transcript().getByRole('group', { name: 'Claude asks 2 questions', exact: true }),
  ).toBeVisible();
  await tokenCannotReply({ answers: { q1: { picked: ['Lint'] }, q2: { text: 'token words' } } });
  await view().getByRole('button', { name: 'All queues', exact: true }).click();
  const card = world.queues().getByRole('group', { name: 'Claude asks 2 questions', exact: true });
  await card.getByRole('checkbox', { name: 'Lint', exact: true }).check();
  await card.getByRole('checkbox', { name: 'Tests', exact: true }).check();
  await card
    .getByRole('textbox', { name: 'What should the release note say?', exact: true })
    .fill('Ready for review');
  await card.getByRole('button', { name: 'Send answers', exact: true }).click();
  await expect(card).toHaveCount(0);
  await world.queues().getByRole('button', { name: 'Open Builder', exact: true }).click();
  const ended = transcript().getByRole('group', { name: 'Claude asks 2 questions', exact: true });
  await expect(ended.getByRole('status')).toHaveText('Answered by you.');
  await expect(ended).not.toContainText('Ready for review');
  await expect(transcript().getByText(/^Worked for \d+s$/)).toHaveCount(1);
  expect(await world.answers()).toEqual([
    expect.objectContaining({
      answer: expect.objectContaining({
        updatedInput: expect.objectContaining({
          answers: {
            'Which checks should run?': 'Lint, Tests',
            'What should the release note say?': 'Ready for review',
          },
        }),
      }),
    }),
  ]);
  await send('a plan');
  const plan = transcript().getByRole('group', { name: 'Approve Claude’s plan?', exact: true });
  await expect(plan).toContainText('1. Write a.txt containing hi.');
  await tokenCannotReply({ choice: 'acceptEdits' });
  await plan.getByRole('button', { name: 'Yes, and auto-accept edits', exact: true }).click();
  await expect(plan.getByRole('status')).toHaveText('Allowed once by you.');
  await expect(
    view().getByRole('button', { name: 'Mode: Accept edits', exact: true }),
  ).toBeVisible();
  await expect(
    transcript().getByText('Approved: carrying it out in acceptEdits.', { exact: true }),
  ).toBeVisible();
});

test('keeps a server form and link private, opens only through link.open, and replies independently', async () => {
  await send('a form');
  const form = transcript().getByRole('form', { name: 'github asks', exact: true });
  await expect(form).toBeVisible();
  await tokenCannotReply({ form: { action: 'accept', values: { repo: 'token-value' } } });
  const liveForm = JSON.stringify(await tokenViews());
  for (const hidden of [
    'Which repository should the issue go in?',
    'Repository',
    'requestedSchema',
    'properties',
  ])
    expect(liveForm).not.toContain(hidden);
  await form.getByRole('textbox', { name: 'Repository' }).fill('acme/shop');
  await form.getByRole('button', { name: 'Submit', exact: true }).click();
  const submitted = transcript().getByRole('group', {
    name: mcpRequestTitle('github', false),
    exact: true,
  });
  await expect(submitted.getByRole('status')).toHaveText('Submitted by you.');
  await expect(submitted).not.toContainText('acme/shop');
  await expect(transcript().getByText(/^Worked for \d+s$/)).toHaveCount(1);

  await world.app.evaluate(({ dialog, shell }) => {
    const seen = globalThis as unknown as { opened: string[]; asked: string[] };
    seen.opened = [];
    seen.asked = [];
    Object.assign(dialog, {
      showMessageBox: (...args: unknown[]) => {
        seen.asked.push((args.at(-1) as { message: string }).message);
        return Promise.resolve({
          response: seen.asked.length === 1 ? 1 : 0,
          checkboxChecked: false,
        });
      },
    });
    Object.assign(shell, {
      openExternal: (url: string) => {
        seen.opened.push(url);
        return Promise.resolve();
      },
    });
  });
  await send('a link');
  const permission = transcript().getByRole('group', {
    name: 'Claude wants to use Sign In',
    exact: true,
  });
  await permission.getByRole('button', { name: 'Yes', exact: true }).click();
  const link = transcript().getByRole('group', {
    name: mcpRequestTitle('tracker', true, 'tracker.example.com'),
    exact: true,
  });
  await expect(link).toContainText('https://tracker.example.com/sign-in?state=abc123');
  const need = await tokenCannotReply({ form: { action: 'accept' } });
  const projected = JSON.stringify(await tokenViews());
  for (const hidden of [
    'tracker.example.com',
    'abc123',
    'Sign in to the tracker to continue.',
    'Tell tracker to go on',
  ])
    expect(projected).not.toContain(hidden);
  const before = await world.answers();
  await link.getByRole('button', { name: 'Open tracker.example.com', exact: true }).click();
  await expect
    .poll(() => world.app.evaluate(() => (globalThis as unknown as { asked: string[] }).asked))
    .toEqual(['Open tracker.example.com in your browser?']);
  expect(
    await world.app.evaluate(() => (globalThis as unknown as { opened: string[] }).opened),
  ).toEqual([]);
  expect(await world.answers()).toEqual(before);
  expect((await currentNeed()).id).toBe(need.id);
  await link.getByRole('button', { name: 'Open tracker.example.com', exact: true }).click();
  await expect
    .poll(() => world.app.evaluate(() => (globalThis as unknown as { opened: string[] }).opened))
    .toEqual(['https://tracker.example.com/sign-in?state=abc123']);
  expect(await world.answers()).toEqual(before);
  await expect(
    link.getByRole('button', { name: 'Tell tracker to go on', exact: true }),
  ).toBeEnabled();
  await link.getByRole('button', { name: 'Tell tracker to go on', exact: true }).click();
  const settled = transcript().getByRole('group', {
    name: mcpRequestTitle('tracker', true),
    exact: true,
  });
  await expect(settled.getByRole('status')).toHaveText('Submitted by you.');
  await expect(settled).not.toContainText('abc123');
  await expect(transcript().getByText('tracker got: accept', { exact: true })).toBeVisible();
  expect(await world.answers()).toHaveLength(before.length + 1);
  const tokenEntries = (
    await world.call('session.transcript', { canvas: world.canvas, agent: 'builder' })
  ).entries.filter((entry) => entry.kind === 'prompt');
  const record = JSON.stringify(tokenEntries);
  for (const hidden of [
    'acme/shop',
    'tracker.example.com',
    'abc123',
    'Sign in to the tracker to continue.',
  ])
    expect(record).not.toContain(hidden);
});
