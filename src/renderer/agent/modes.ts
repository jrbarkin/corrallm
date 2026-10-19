import type { AdapterId } from '../../shared/adapter';
import { UNASKING_MODES } from '../../shared/session';
import type { CodexMode, PermissionMode, SessionMode } from '../../shared/session';
import type { Mode } from '../../shared/model/session';

/*
 * The modes the composer offers each adapter's agents, as their CLIs name them, until the
 * descriptors declare them (Build Plan B12).
 */

/** A mode as the composer shows it. */
export interface ModeInfo {
  mode: Mode;
  label: string;
  description: string;
}

/**
 * Claude Code's modes as its desktop app names them, in its order. Shift+Tab cycles them, all but
 * bypassing permissions (cycledModes), which is chosen from the mode menu, once confirmed, as
 * Claude Code offers it only when told to.
 */
export const MODES: readonly (ModeInfo & { mode: PermissionMode })[] = [
  { mode: 'manual', label: 'Manual', description: 'Asks before editing files or running commands' },
  {
    mode: 'acceptEdits',
    label: 'Accept edits',
    description: 'Edits files freely; asks before commands',
  },
  { mode: 'plan', label: 'Plan', description: 'Reads and proposes a plan; changes nothing' },
  { mode: 'bypassPermissions', label: 'Bypass permissions', description: 'Never asks' },
  { mode: 'auto', label: 'Auto', description: 'Decides for itself what needs your approval' },
];

/**
 * Codex's modes, as its /permissions names its presets, then plan mode; Default first in use. Full
 * access, like bypassing permissions, is chosen from the mode menu only, once confirmed.
 */
export const CODEX_MODES: readonly (ModeInfo & { mode: CodexMode })[] = [
  {
    mode: 'read-only',
    label: 'Read only',
    description: 'Reads and runs read-only commands; asks before editing',
  },
  {
    mode: 'auto',
    label: 'Default',
    description: 'Edits and runs commands in the project folder; asks before going outside it',
  },
  {
    mode: 'full-access',
    label: 'Full access',
    description: 'Edits and runs anything, with network access; never asks',
  },
  { mode: 'plan', label: 'Plan', description: 'Explores and proposes a plan; changes nothing' },
];

/** Each adapter's modes, as the composer shows them. */
const ADAPTER_MODES: Readonly<
  Partial<Record<AdapterId, readonly (ModeInfo & { mode: SessionMode })[]>>
> = { 'claude-code': MODES, codex: CODEX_MODES };

/** The modes an agent offers: its adapter's (none, for an adapter this build doesn't have). */
export function modesOf(adapter: AdapterId): readonly ModeInfo[] {
  return Object.hasOwn(ADAPTER_MODES, adapter) ? (ADAPTER_MODES[adapter] ?? []) : [];
}

/** The modes Shift+Tab cycles an agent through, in order: never one that never asks. */
export function cycledModes(adapter: AdapterId): readonly Mode[] {
  return modesOf(adapter).flatMap(({ mode }) => (UNASKING_MODES.includes(mode) ? [] : [mode]));
}

/** How an agent shows its reported mode; an unknown mode keeps its own name. */
export function modeOf(adapter: AdapterId, mode: Mode): ModeInfo {
  return (
    modesOf(adapter).find((one) => one.mode === mode) ?? { mode, label: mode, description: '' }
  );
}
