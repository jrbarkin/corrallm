import type { Query } from '@anthropic-ai/claude-agent-sdk';

import type { PermissionMode } from '../../../shared/session';
import { corrallmMode } from './translate';

/** What the CLI's settings say of permission modes, as far as corrallm reads them. */
export interface ModeSettings {
  /** The user's own default mode (permissions.defaultMode), if it is one of corrallm's modes. */
  defaultMode?: PermissionMode;
  /** Whether bypassing permissions is turned off (permissions.disableBypassPermissionsMode). */
  bypassDisabled: boolean;
}

/** A Query that can be asked for the CLI's settings: the runtime has it; the SDK's types don't. */
interface WithSettings {
  getSettings?: () => Promise<unknown>;
}

/**
 * Asks the running CLI for its settings (the get_settings control request: the user's, project's,
 * local and managed settings, merged, as `effective`), for the user's own default mode and whether
 * bypassing permissions is turned off. A CLI or SDK that can't say, or an answer of another shape,
 * says nothing: Manual, and bypassing offered.
 */
export async function modeSettings(query: Query): Promise<ModeSettings> {
  const asking = query as Query & WithSettings;
  let answer: unknown;
  try {
    answer = await asking.getSettings?.();
  } catch {
    return { bypassDisabled: false };
  }
  const permissions = field(field(answer, 'effective'), 'permissions');
  const defaultMode = corrallmMode(field(permissions, 'defaultMode'));
  return {
    ...(defaultMode === undefined ? {} : { defaultMode }),
    bypassDisabled: field(permissions, 'disableBypassPermissionsMode') === 'disable',
  };
}

/** `value[key]`, if `value` is an object. */
function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;
}
