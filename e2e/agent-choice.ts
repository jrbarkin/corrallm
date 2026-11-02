import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { GuiBridge } from '../src/shared/gui-link';
import type { AdapterId, ConnectionId } from '../src/shared/adapter';
import { adapterName } from './catalog';

/** Choose the fixture's endpoint through the same Add confirmation as a person. */
export async function chooseAddedAgent(
  page: Page,
  adapter: AdapterId,
  connection?: ConnectionId,
): Promise<void> {
  const chooser = page.getByRole('dialog', { name: 'Choose an agent', exact: true });
  await expect(chooser).toBeVisible();
  await chooser.getByRole('radio', { name: adapterName(adapter), exact: true }).check();
  if (connection !== undefined)
    await chooser
      .getByRole('combobox', { name: `How ${adapterName(adapter)} runs` })
      .selectOption(connection);
  await chooser.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(chooser).toHaveCount(0);
}

/** Keep these native-template fixtures' former endpoints, with every role explicitly chosen. */
export async function chooseTemplateAgents(page: Page, unassigned: AdapterId): Promise<void> {
  const gallery = page.getByRole('dialog', { name: 'Templates', exact: true });
  const name = await gallery.getByRole('heading', { level: 2 }).textContent();
  const { items } = await page.evaluate(async () => {
    const bridge = globalThis as unknown as { api: GuiBridge };
    const result = await bridge.api.templatesList({});
    if (!result.ok) throw new Error(result.error.sentence);
    return result.value;
  });
  const template = items.find((item) => item.name === name);
  if (template === undefined) throw new Error(`No fixture template ${String(name)}`);
  for (const role of template.agents)
    await gallery
      .getByRole('combobox', { name: `${role.name}'s agent`, exact: true })
      .selectOption(role.adapter ?? unassigned);
}
