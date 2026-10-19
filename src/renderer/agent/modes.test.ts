import { describe, expect, it } from 'vitest';

import { catalog } from '../catalog';
import { cycledModes, modeOf, modesOf } from './modes';

describe('modes', () => {
  it('offers a Codex agent Codex’s modes, and other agents Claude Code’s', () => {
    expect(modesOf('codex').map((m) => m.mode)).toEqual([
      'read-only',
      'auto',
      'full-access',
      'plan',
    ]);
    expect(modesOf('claude-code').map((m) => m.mode)).toEqual([
      'manual',
      'acceptEdits',
      'plan',
      'bypassPermissions',
      'auto',
    ]);
  });

  it('offers each adapter the modes the catalog declares, as it declares them', () => {
    for (const adapter of catalog().adapters) {
      expect(modesOf(adapter.id)).toEqual(
        adapter.modes.map(({ id, label, description }) => ({ mode: id, label, description })),
      );
      // Shift+Tab never cycles into a mode that never asks.
      expect(cycledModes(adapter.id)).toEqual(
        adapter.modes.flatMap(({ id, asks }) => (asks ? [id] : [])),
      );
    }
  });

  it('shows a known mode by its label, and never substitutes an adapter’s default', () => {
    expect(modeOf('codex', 'full-access').label).toBe('Full access');
    expect(modeOf('codex', 'acceptEdits').label).toBe('acceptEdits');
    expect(modeOf('claude-code', 'read-only').label).toBe('read-only');
    expect(modeOf('claude-code', 'plan').label).toBe('Plan');
  });
});
