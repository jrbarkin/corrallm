import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { UsageState } from '../../shared/usage';
import { UsageGauges } from './UsageGauge';

const HOUR = 3_600_000;

function show(usage: UsageState) {
  const onRule = vi.fn();
  const onSimulate = vi.fn();
  render(
    <UsageGauges
      backends={['claude-code']}
      usage={usage}
      onRule={onRule}
      onSimulate={onSimulate}
    />,
  );
  return { gauge: screen.getByRole('button', { name: /^Claude usage:/ }), onRule, onSimulate };
}

describe('UsageGauges', () => {
  it('keeps the prepared fallback action out of the picker until its service is built', () => {
    const { gauge } = show({ readings: [], rules: {} });
    fireEvent.click(gauge);
    fireEvent.click(screen.getByRole('button', { name: 'Add a rule…' }));
    expect(screen.getAllByRole('option')).toHaveLength(3);
    expect(screen.getByRole('option', { name: /^Warn me/ })).toBeTruthy();
    expect(screen.getByRole('option', { name: /^Pause and ask me/ })).toBeTruthy();
    expect(screen.getByRole('option', { name: /^Finish the task/ })).toBeTruthy();
    expect(screen.queryByText('Carry on with the next backend')).toBeNull();
  });

  it('says how old a stale reading is, on the gauge and in its panel', () => {
    const { gauge } = show({
      readings: [
        {
          backend: 'claude-code',
          windows: { weekly: { usedPercent: 40, resetsAt: Date.now() + 48 * HOUR } },
          at: Date.now() - 3 * HOUR,
        },
      ],
      rules: {},
    });
    expect(gauge.getAttribute('aria-label')).toBe('Claude usage: 40% of weekly window');
    expect(gauge.textContent).toContain('3 h ago');
    fireEvent.click(gauge);
    expect(within(screen.getByRole('dialog')).getByText('Read 3 h ago')).toBeTruthy();
  });

  it('shows a window that has reset since the reading as not read since', () => {
    const { gauge } = show({
      readings: [
        {
          backend: 'claude-code',
          windows: { fiveHour: { usedPercent: 99, resetsAt: Date.now() - HOUR } },
          at: Date.now() - 6 * HOUR,
        },
      ],
      rules: { 'claude-code': { window: 'fiveHour', percent: 80, action: 'ask' } },
    });
    // What was used then no longer counts: nothing is over the rule.
    expect(gauge.getAttribute('aria-label')).toBe('Claude usage: reset since read');
    expect(gauge.hasAttribute('data-over')).toBe(false);
    fireEvent.click(gauge);
    expect(within(screen.getByRole('dialog')).getByText(/^Reset .*; not read since$/)).toBeTruthy();
  });

  it('takes a rule off, and clears a reading', () => {
    const { gauge, onRule, onSimulate } = show({
      readings: [],
      rules: { 'claude-code': { window: 'weekly', percent: 90, action: 'warn' } },
    });
    fireEvent.click(gauge);
    const panel = within(screen.getByRole('dialog'));
    fireEvent.click(panel.getByRole('button', { name: 'Take the usage rule off' }));
    expect(onRule).toHaveBeenCalledWith('claude-code', null);
    fireEvent.click(panel.getByRole('button', { name: 'Simulate usage…' }));
    fireEvent.change(panel.getByRole('textbox', { name: '5-hour window: resets in' }), {
      target: { value: 'soon' },
    });
    fireEvent.click(panel.getByRole('button', { name: 'Simulate' }));
    expect(panel.getByRole('alert').textContent).toBe(
      'Type how long until the 5-hour window resets, e.g. 2 hours.',
    );
    fireEvent.click(panel.getByRole('button', { name: 'Clear reading' }));
    expect(onSimulate).toHaveBeenCalledWith('claude-code', null);
  });
});
