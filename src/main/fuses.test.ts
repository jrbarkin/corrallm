import { FuseState, FuseV1Options } from '@electron/fuses';
import { describe, expect, it } from 'vitest';

import { FUSES, diffFuses } from '../../build/fuses';

describe('the fuses the app ships with', () => {
  it('sets every fuse explicitly, with the escape hatches off', () => {
    expect(FUSES[FuseV1Options.RunAsNode]).toBe(false);
    expect(FUSES[FuseV1Options.EnableNodeOptionsEnvironmentVariable]).toBe(false);
    expect(FUSES[FuseV1Options.EnableNodeCliInspectArguments]).toBe(false);
    expect(FUSES[FuseV1Options.EnableEmbeddedAsarIntegrityValidation]).toBe(true);
    expect(FUSES[FuseV1Options.OnlyLoadAppFromAsar]).toBe(true);
    expect(Object.keys(FUSES)).toHaveLength(9);
  });
});

describe('diffFuses', () => {
  const read = (overrides: Partial<Record<FuseV1Options, FuseState>> = {}) => {
    const wire: Record<number, FuseState> = {};
    for (const [key, on] of Object.entries(FUSES))
      wire[Number(key)] = on ? FuseState.ENABLE : FuseState.DISABLE;
    return { ...wire, ...overrides };
  };

  it('is empty when the binary carries the configured fuses', () => {
    expect(diffFuses(read())).toEqual([]);
  });

  it('names a fuse that differs', () => {
    expect(diffFuses(read({ [FuseV1Options.RunAsNode]: FuseState.ENABLE }))).toEqual([
      'RunAsNode: binary has enabled, configured disabled',
    ]);
  });

  it('names a configured fuse the binary lacks, and one it cannot read', () => {
    const wire = read();
    Reflect.deleteProperty(wire, FuseV1Options.OnlyLoadAppFromAsar);
    wire[FuseV1Options.WasmTrapHandlers] = FuseState.INHERIT;
    expect(diffFuses(wire)).toEqual([
      'OnlyLoadAppFromAsar: binary has none, configured enabled',
      'WasmTrapHandlers: binary has inherit, configured enabled',
    ]);
  });
});
