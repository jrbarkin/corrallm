import { expect, test } from '@playwright/test';

import { agentCardName, agentChipName } from './catalog';
import { continuityWorld } from './continuity-world';

// B24 X4: the built app, the native fake, and a normally reached outside MCP caller (its write
// token is named "test"). The outside grant is yours alone: given in the canvas menu, it lets that
// orchestrator allow a worker's approval once, never more.
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
});
test.afterEach(async () => {
  await closeWorld?.();
});

const view = () => world.page.getByRole('dialog', { name: 'Builder', exact: true });
const transcript = () => view().getByRole('log', { name: 'Transcript', exact: true });
async function approval() {
  const items = (await world.call('needs', { canvas: world.canvas })).items.filter(
    (item) => item.kind === 'prompt',
  );
  expect(items).toHaveLength(1);
  const item = items[0];
  if (!item) throw new Error('No current prompt');
  return item;
}

test('lets an outside orchestrator allow an approval once only after you grant it in the canvas menu', async () => {
  const composer = view().getByRole('textbox', { name: 'Message Builder', exact: true });
  await composer.fill('please run it');
  await composer.press('Enter');
  await expect(
    transcript().getByRole('group', { name: 'Claude wants to use Bash', exact: true }),
  ).toBeVisible();
  const need = await approval();
  // Without the grant it sees no choice and its reply is refused.
  expect(need.choices).toEqual([]);
  const refused = await world.raw('reply', {
    canvas: world.canvas,
    to: need.id,
    answer: { choice: 'allow' },
  });
  expect(refused.isError).toBe(true);
  expect(await world.answers()).toEqual([]);

  // You grant it; the token's own call can never.
  await view().getByRole('button', { name: 'Back to the canvas', exact: true }).click();
  await world.page.getByRole('button', { name: 'Canvas menu', exact: true }).click();
  const grant = world.page.getByRole('checkbox', { name: 'test may answer approvals' });
  await expect(grant).not.toBeChecked();
  await grant.click();
  await expect(grant).toBeChecked();
  const set = await world.raw('outside.setGrant', {
    canvas: world.canvas,
    name: 'test',
    approvals: true,
  });
  expect(set.isError).toBe(true);

  // Now it may allow once, and nothing "always" is offered it.
  await expect
    .poll(async () => (await approval()).choices.map((choice) => choice.hint ?? choice.value))
    .toContain('allow_once');
  const granted = await approval();
  expect(granted.choices.map((choice) => choice.hint)).not.toContain('allow_always');
  const allowed = granted.choices.find((choice) => choice.hint === 'allow_once');
  if (!allowed) throw new Error('No allow once choice');
  const answered = await world.raw('reply', {
    canvas: world.canvas,
    to: granted.id,
    answer: { choice: allowed.value },
  });
  expect(answered.isError, JSON.stringify(answered.content)).not.toBe(true);
  await expect.poll(() => world.answers()).toHaveLength(1);
  expect(await world.answers()).toEqual([
    expect.objectContaining({ answer: expect.objectContaining({ behavior: 'allow' }) }),
  ]);
  await world.page.keyboard.press('Escape');
  await world.page.locator('.react-flow__node-agent').dblclick();
  await expect(
    transcript()
      .getByRole('group', { name: 'Claude wants to use Bash', exact: true })
      .getByRole('status'),
  ).toHaveText('Allowed once by test.');
});
