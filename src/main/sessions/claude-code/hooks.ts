import { postHookCommand } from '../terminal/hooks';

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
 * `url`: HTTP headers live in this private settings file; commands read a private header file.
 * Claude Code merges these hooks with the user's and the project's hooks.
 */
export function hookSettings(url: string, token: string): { hooks: Record<string, HookGroup[]> } {
  const hook = {
    type: 'http',
    url,
    headers: { Authorization: `Bearer ${token}` },
    timeout: TIMEOUT_S,
  };
  return {
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: postHookCommand(url), timeout: 10 }] }],
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
