import type { Query } from '@anthropic-ai/claude-agent-sdk';

import { EFFORT_PATTERN, MODEL_PATTERN } from '../../../shared/session';
import type { PermissionMode } from '../../../shared/session';
import { corrallmMode } from './translate';

/** What the CLI's settings say, as far as corrallm reads them. */
export interface ModeSettings {
  /** The user's own default mode (permissions.defaultMode), if it is one of corrallm's modes. */
  defaultMode?: PermissionMode;
  /** Whether bypassing permissions is turned off (permissions.disableBypassPermissionsMode). */
  bypassDisabled: boolean;
  /** The model their settings set (`model`, as written there: an alias or an id), if any. */
  model?: string;
  /**
   * The model the session runs unless told otherwise, as the CLI says (`applied`: with
   * ANTHROPIC_MODEL and the like counted; an id, as the CLI resolves it), if it says.
   */
  appliedModel?: string;
  /** The effort it reasons at unless told otherwise (`applied`, else their `effortLevel`). */
  effort?: string;
}

/** A Query that can be asked for the CLI's settings: the runtime has it; the SDK's types don't. */
interface WithSettings {
  getSettings?: () => Promise<unknown>;
}

/**
 * Asks the running CLI for its settings (the get_settings control request: the user's, project's,
 * local and managed settings, merged, as `effective`, and what it will use, as `applied`), for the
 * user's own default mode, whether bypassing permissions is turned off, and the model and effort
 * it starts with. A CLI or SDK that can't say, or an answer of another shape, says nothing: Manual,
 * bypassing offered, and the account's default model.
 */
export async function modeSettings(query: Query): Promise<ModeSettings> {
  const asking = query as Query & WithSettings;
  let answer: unknown;
  try {
    answer = await asking.getSettings?.();
  } catch {
    return { bypassDisabled: false };
  }
  const effective = field(answer, 'effective');
  const applied = field(answer, 'applied');
  const permissions = field(effective, 'permissions');
  const defaultMode = corrallmMode(field(permissions, 'defaultMode'));
  const model = matching(field(effective, 'model'), MODEL_PATTERN);
  const appliedModel = matching(field(applied, 'model'), MODEL_PATTERN);
  const effort =
    matching(field(applied, 'effort'), EFFORT_PATTERN) ??
    matching(field(effective, 'effortLevel'), EFFORT_PATTERN);
  return {
    ...(defaultMode === undefined ? {} : { defaultMode }),
    bypassDisabled: field(permissions, 'disableBypassPermissionsMode') === 'disable',
    ...(model === undefined ? {} : { model }),
    ...(appliedModel === undefined ? {} : { appliedModel }),
    ...(effort === undefined ? {} : { effort }),
  };
}

/** `value`, if it is text that `pattern` matches. */
function matching(value: unknown, pattern: RegExp): string | undefined {
  return typeof value === 'string' && pattern.test(value) ? value : undefined;
}

/** `value[key]`, if `value` is an object. */
function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;
}
