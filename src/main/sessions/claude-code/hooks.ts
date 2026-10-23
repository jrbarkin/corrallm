import { HOOK_TOKEN, postHookCommand } from '../terminal/hooks';

/** The events heard through HTTP; SessionStart requires a command hook. */
export const HOOK_EVENTS = [
  'UserPromptSubmit',
  'Stop',
  'StopFailure',
  'SessionEnd',
  'PostModelSwitch',
  'PermissionRequest',
  'Notification',
  'PreToolUse',
] as const;
/**
 * Which calls an event is heard for, where not all: before a tool runs, only the tools that ask the
 * user something (AskUserQuestion's questions, ExitPlanMode's plan), which no permission hook tells.
 */
const MATCHERS: Partial<Record<(typeof HOOK_EVENTS)[number], string>> = {
  PreToolUse: 'AskUserQuestion|ExitPlanMode',
};
/** How long Claude Code waits for corrallm's answer, in seconds; it answers at once. */
const TIMEOUT_S = 5;

/**
 * The settings (for `claude --settings <file>`) that add corrallm's hooks: each event posted to
 * `url`, with the token from the session's environment. Claude Code merges them with the user's
 * and the project's hooks.
 */
export function hookSettings(url: string, startup = true): { hooks: Record<string, HookGroup[]> } {
  const hook = {
    type: 'http',
    url,
    headers: { Authorization: `Bearer $${HOOK_TOKEN}` },
    allowedEnvVars: [HOOK_TOKEN],
    timeout: TIMEOUT_S,
  };
  return {
    hooks: {
      ...(startup
        ? {
            SessionStart: [
              { hooks: [{ type: 'command', command: postHookCommand(url), timeout: 10 }] },
            ],
          }
        : {}),
      ...Object.fromEntries(
        HOOK_EVENTS.map((name) => {
          const matcher = MATCHERS[name];
          return [name, [{ ...(matcher === undefined ? {} : { matcher }), hooks: [hook] }]];
        }),
      ),
    },
  };
}

/** Hooks for an event in Claude Code's settings: for the calls `matcher` names (or all). */
export interface HookGroup {
  matcher?: string;
  hooks: Record<string, unknown>[];
}
