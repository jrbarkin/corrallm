import { describe, expect, it } from 'vitest';
import { OPS } from '../registry';

const canvas = '7d0c2b9e-4f1a-4c3d-9e8b-2a1f0e6d5c4b';

describe('creation endpoints', () => {
  it('requires an adapter for frame-to-agent conversion', () => {
    expect(OPS['canvas.addParent'].input.safeParse({ canvas, frame: 'f' }).success).toBe(false);
    expect(
      OPS['canvas.addParent'].input.safeParse({
        canvas,
        frame: 'f',
        adapter: 'zed',
        connection: 'zed.acp',
      }).success,
    ).toBe(true);
  });
  it('takes an explicit endpoint when grouping as an agent', () => {
    expect(
      OPS['canvas.group'].input.safeParse({
        canvas,
        nodes: ['a'],
        kind: 'agent',
        adapter: 'zed',
        connection: 'zed.acp',
      }).success,
    ).toBe(true);
  });
  it('refuses null template role choices', () => {
    expect(
      OPS['canvas.insertTemplate'].input.safeParse({
        canvas,
        template: 'd63d090e-b83c-4f73-8c60-dbd6fc9efaa9',
        agents: { coder: null },
      }).success,
    ).toBe(false);
  });
});
