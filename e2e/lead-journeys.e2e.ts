import { expect, test } from '@playwright/test';

import { agentApiWorld } from './agent-api-world';
import { openNeeds } from './canvas-actions';
import { agentCardName } from './catalog';

test.skip(process.platform === 'win32', 'The native fakes use POSIX wrappers.');
test.setTimeout(120_000);

/*
 * B24 X4: a lead in the built app, over the Agent SDK fake for both the lead and its worker. The
 * lead is made in the window (the only place it can be: `agent.setLead` is yours alone), nested
 * above its worker; the worker's "run" asks to use Bash, and the prompt is routed to the lead.
 */

const CARD = 'A request from your team waits for you to answer';
const NOTICE = 'no longer waits for you';

type World = Awaited<ReturnType<typeof world>>;
const world = (rules: Parameters<typeof agentApiWorld>[0]['rules'] = []) =>
  agentApiWorld({
    agents: [
      { id: 'lead', label: 'Lead', connection: 'claude-code.sdk' },
      { id: 'worker', label: 'Worker', connection: 'claude-code.sdk', parent: 'lead' },
    ],
    rules,
  });

const sheet = (w: World) => w.page.getByRole('dialog', { name: /^Agent settings:/ });
const count = async (w: World, text: string) =>
  (await w.sdkPrompts()).filter((prompt) => prompt.includes(text)).length;

/** Opens the lead's settings sheet from All queues; the queues stay open behind it. */
async function openSheet(w: World) {
  if (!(await w.queues().isVisible())) {
    await w.page.getByRole('button', { name: 'Show all queues' }).click();
  }
  await w.queues().getByRole('button', { name: 'Agent settings: Lead', exact: true }).click();
  await expect(sheet(w)).toBeVisible();
}

/** Makes the lead one that answers approvals, as you do in its settings. */
async function makeLead(w: World) {
  await openSheet(w);
  await sheet(w).getByRole('button', { name: 'Make a lead' }).click();
  const approvals = sheet(w).getByRole('checkbox', { name: 'Answers approvals' });
  await approvals.click();
  await expect(approvals).toBeChecked();
  await w.page.keyboard.press('Escape');
  await expect(sheet(w)).toHaveCount(0);
  await w.queues().getByRole('button', { name: 'Back', exact: true }).click();
}

/** The worker's view, where its Bash approval reads. */
async function workerView(w: World) {
  await w.page
    .locator('.react-flow__node-agent')
    .filter({ has: w.page.locator('.graph-label', { hasText: /^Worker$/ }) })
    .dblclick();
  const view = w.page.getByRole('dialog', { name: 'Worker', exact: true });
  await expect(view).toBeVisible();
  const transcript = view.getByRole('log', { name: 'Transcript', exact: true });
  return { view, group: transcript.getByRole('group', { name: 'Claude wants to use Bash' }) };
}

test('a lead allows its worker’s request once, and the transcript says it was the lead', async () => {
  const w = await world([
    {
      when: CARD,
      calls: [
        {
          tool: 'reply',
          args: { canvas: '{canvas}', to: '{need}', answer: { choice: 'allow' } },
        },
      ],
    },
  ]);
  try {
    expect(agentCardName('Lead', 'claude-code.sdk')).toBeTruthy();
    await w.wake('lead');
    await makeLead(w);
    await w.call('message', { canvas: w.canvas, to: 'worker', body: 'please run it' });
    await expect
      .poll(async () => (await w.calls(CARD)).filter((line) => line.ok === true).length, {
        message: 'The lead must answer its copy through reply',
        timeout: 30_000,
      })
      .toBe(1);
    const { group } = await workerView(w);
    await expect(group.getByRole('status')).toHaveText('Allowed once by Lead.', {
      timeout: 15_000,
    });
    // One copy was sent, and the lead that answered is sent no notice of it.
    expect(await count(w, CARD)).toBe(1);
    expect(await count(w, NOTICE)).toBe(0);
  } finally {
    await w.close();
  }
});

test('you take over first, and the lead gets its one notice', async () => {
  const w = await world();
  try {
    await w.wake('lead');
    await makeLead(w);
    await w.call('message', { canvas: w.canvas, to: 'worker', body: 'please run it' });
    await expect.poll(() => count(w, CARD), { timeout: 30_000 }).toBe(1);
    await openNeeds(w.page);
    await expect(
      w.page.getByRole('complementary', { name: 'Needs you' }).getByText(/Lead may answer until/),
    ).toBeVisible();
    await w.page.keyboard.press('Escape');
    const { group } = await workerView(w);
    await group.getByRole('button', { name: 'Yes', exact: true }).click();
    await expect(group.getByRole('status')).toHaveText('Allowed once by you.');
    await expect.poll(() => count(w, NOTICE), { timeout: 30_000 }).toBe(1);
    // Neither is repeated by the lead's own turn for the notice.
    expect(await count(w, CARD)).toBe(1);
  } finally {
    await w.close();
  }
});

test('a held lead is sent nothing, and the request waits for you alone', async () => {
  const w = await world();
  try {
    await w.wake('lead');
    await makeLead(w);
    // Changing its role holds it until you confirm it.
    await openSheet(w);
    const role = sheet(w).getByRole('textbox', { name: 'Role', exact: true });
    await role.fill('Review everything.');
    await role.blur();
    await w.page.keyboard.press('Escape');
    await expect(sheet(w)).toHaveCount(0);
    await openSheet(w);
    await expect(sheet(w).getByRole('region', { name: 'Lead' })).toContainText('its role changed');
    await w.page.keyboard.press('Escape');
    await w.queues().getByRole('button', { name: 'Back', exact: true }).click();

    await w.call('message', { canvas: w.canvas, to: 'worker', body: 'please run it' });
    const { group } = await workerView(w);
    await expect(group.getByRole('button', { name: 'Yes', exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await w.page.keyboard.press('Escape');
    await openNeeds(w.page);
    await expect(w.page.getByText(/Lead may answer until/)).toHaveCount(0);
    const needs = await w.call('needs', { canvas: w.canvas });
    expect(
      needs.items.find((item) => item.agent === 'worker' && item.kind === 'prompt')?.by,
      'A held lead must not be an answerer of its worker’s request',
    ).toEqual(['you']);
    expect(await count(w, CARD)).toBe(0);
  } finally {
    await w.close();
  }
});
