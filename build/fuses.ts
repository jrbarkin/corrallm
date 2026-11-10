import { FuseState, FuseV1Options } from '@electron/fuses';

/**
 * Every Electron fuse the packaged app is flipped to, set explicitly. forge.config.mts applies
 * them; scripts/check-fuses.mjs reads them back from a packaged binary and `diffFuses` compares.
 */
export const FUSES: Record<FuseV1Options, boolean> = {
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableCookieEncryption]: true,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  // Enforced on macOS and Windows; Electron has no ASAR integrity check on Linux.
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
  // The renderer is served from app://, so file:// needs no extra privileges.
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
  [FuseV1Options.WasmTrapHandlers]: true,
};

const STATE_NAMES: Record<number, string> = {
  [FuseState.ENABLE]: 'enabled',
  [FuseState.DISABLE]: 'disabled',
  [FuseState.REMOVED]: 'removed',
  [FuseState.INHERIT]: 'inherit',
};

/** One line for each fuse whose state in a binary differs from `FUSES`; none when they agree. */
export function diffFuses(wire: Partial<Record<number, FuseState>>): string[] {
  const lines: string[] = [];
  for (const [key, on] of Object.entries(FUSES)) {
    const actual = wire[Number(key)];
    const wanted = on ? FuseState.ENABLE : FuseState.DISABLE;
    if (actual === wanted) continue;
    const name = FuseV1Options[Number(key)] ?? key;
    const had = actual === undefined ? 'none' : (STATE_NAMES[actual] ?? String(actual));
    lines.push(`${name}: binary has ${had}, configured ${on ? 'enabled' : 'disabled'}`);
  }
  return lines;
}
