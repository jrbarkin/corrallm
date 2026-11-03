import { expect, test } from '@playwright/test';
import { launchApp } from './launch';
import { dismissStart } from './canvas-actions';
import { chooseAddedAgent } from './agent-choice';
import { adapterName, agentChipName } from './catalog';

test('the chip and settings share a saved fallback chain, handoff settings and a usage-rule action', async () => {
  const { app, close } = await launchApp({ env: { CORRALLM_FAKE_SESSIONS: '1' } });
  try {
    const page = await app.firstWindow();
    await dismissStart(page);
    await page.locator('.react-flow__pane').dblclick({ position: { x: 360, y: 250 } });
    await chooseAddedAgent(page, 'codex', 'codex.app-server');
    const card = page.locator('.react-flow__node-agent');
    await expect(card).toHaveCount(1);
    await card.dblclick();
    const agentWindow = page.getByRole('dialog', { name: 'Agent 1', exact: true });
    await expect(
      agentWindow.getByRole('button', { name: agentChipName('codex.app-server'), exact: true }),
    ).toBeVisible();
    await agentWindow.getByRole('button', { name: 'Fallback chain', exact: true }).click();
    const chain = page.getByRole('dialog', { name: 'Fallback chain', exact: true });
    await expect(chain.getByText(/first turn may wait for your consent/)).toBeVisible();
    await chain.getByRole('button', { name: 'Add step', exact: true }).click();
    await expect(chain.getByRole('combobox', { name: 'Step 1 agent' })).toHaveValue('');
    await chain
      .getByRole('combobox', { name: 'Step 1 agent' })
      .selectOption({ label: adapterName('claude-code') });
    await chain
      .getByRole('combobox', { name: 'Step 1 connection' })
      .selectOption('claude-code.sdk');
    await expect(chain.getByText(/never falls back on its own/)).toBeVisible();
    await chain.getByRole('checkbox', { name: 'Return when its own usage resets' }).check();
    await chain.getByRole('button', { name: 'Save chain', exact: true }).click();
    await expect(chain).toHaveCount(0);
    await expect(
      agentWindow.getByRole('button', { name: agentChipName('codex.app-server'), exact: true }),
    ).toBeVisible();
    await agentWindow.getByRole('button', { name: 'Agent settings: Agent 1' }).click();
    const settings = page.getByRole('dialog', { name: 'Agent settings: Agent 1', exact: true });
    await settings.getByRole('button', { name: 'Fallback chain', exact: true }).click();
    await expect(chain.getByRole('combobox', { name: 'Step 1 connection' })).toHaveValue(
      'claude-code.sdk',
    );
    await expect(
      chain.getByRole('checkbox', { name: 'Return when its own usage resets' }),
    ).toBeChecked();
    await chain.getByRole('button', { name: 'Cancel', exact: true }).click();
    await settings.getByRole('button', { name: 'Handoff settings' }).click();
    const handoff = page.getByRole('dialog', { name: 'Handoff settings', exact: true });
    await handoff.getByRole('spinbutton', { name: 'Ask at context percent' }).fill('85');
    await handoff.getByRole('textbox', { name: 'Markdown export' }).fill('notes/handoff.md');
    await handoff.getByRole('button', { name: 'Save handoff settings' }).click();
    await expect(handoff).toHaveCount(0);
    await settings.getByRole('button', { name: 'Handoff settings' }).click();
    await expect(handoff.getByRole('spinbutton', { name: 'Ask at context percent' })).toHaveValue(
      '85',
    );
    await expect(handoff.getByRole('textbox', { name: 'Markdown export' })).toHaveValue(
      'notes/handoff.md',
    );
    await handoff.getByRole('button', { name: 'Cancel', exact: true }).click();
    await settings.getByRole('button', { name: 'Close agent settings' }).click();
    await agentWindow.getByRole('button', { name: 'Back to the canvas' }).click();
    const gauge = page.getByRole('button', { name: /^Codex usage:/ });
    await gauge.click();
    await page.getByRole('button', { name: 'Add a rule…' }).click();
    await page.getByRole('option', { name: /Carry on with the next backend/ }).click();
    await expect(
      page.getByRole('button', { name: 'Change what happens: Carry on with the next backend' }),
    ).toBeVisible();
    // Configuration alone changes neither the active endpoint nor the run.
    const state = await page.evaluate(async () => {
      const shown = await window.api.windowGet({});
      if (!shown.ok) throw new Error(shown.error.sentence);
      const run = await window.api.runGet({ canvas: shown.value.canvas });
      if (!run.ok) throw new Error(run.error.sentence);
      return run.value;
    });
    expect(state.running).toBe(false);
  } finally {
    await close();
  }
});
