import { expect, it } from 'vitest';
import { launchInstructions, MAX_WORKSPACE_CONTEXT_BYTES } from './instructions';

it('preserves exact role-only launches and keeps core context separate from the saved role', () => {
  expect(launchInstructions({})).toBeUndefined();
  expect(launchInstructions({ role: 'Review\ncarefully' })).toBe('Review\ncarefully');
  const spec = { role: 'Review', workspaceContext: 'Branch: refs/heads/corrallm/p/w' };
  expect(launchInstructions(spec)).toBe(
    'Review\n\n[corrallm workspace context]\nBranch: refs/heads/corrallm/p/w',
  );
  expect(spec.role).toBe('Review');
  expect(launchInstructions({ workspaceContext: 'Base: abc' })).toBe(
    '[corrallm workspace context]\nBase: abc',
  );
});

it('bounds context in UTF-8 bytes rather than clipping a ref or name', () => {
  expect(
    launchInstructions({ workspaceContext: 'x'.repeat(MAX_WORKSPACE_CONTEXT_BYTES) }),
  ).toBeDefined();
  expect(() =>
    launchInstructions({ workspaceContext: 'é'.repeat(MAX_WORKSPACE_CONTEXT_BYTES) }),
  ).toThrow('exceeds 8 KiB');
});
