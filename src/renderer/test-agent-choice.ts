import { act, fireEvent, screen, within } from '@testing-library/react';
import { catalog } from './catalog';

/** Explicit endpoint choices for tests whose main guarantee follows an Add gesture. */
export async function pickAddedAgent(adapter = 'claude-code'): Promise<void> {
  const dialog = screen.queryByRole('dialog', { name: 'Choose an agent' });
  if (!dialog) return;
  const descriptor = catalog().adapters.find((one) => one.id === adapter);
  if (!descriptor) throw new Error(`No fixture adapter ${adapter}`);
  await act(async () => {
    fireEvent.click(within(dialog).getByRole('radio', { name: descriptor.name }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    await Promise.resolve();
  });
}

/** A gallery submission names every role; these tests explicitly choose their fixture adapter. */
export function pickTemplateAgents(adapter = 'claude-code'): void {
  const dialog = screen.getByRole('dialog', { name: 'Templates' });
  for (const select of dialog.querySelectorAll<HTMLSelectElement>(
    'select[id^="template-agent-"]',
  )) {
    if (select.value === '') fireEvent.change(select, { target: { value: adapter } });
  }
}
