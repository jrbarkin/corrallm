import { createHash } from 'node:crypto';

import { postHookCommand } from '../../terminal/hooks';

/*
 * Codex's hooks, reporting to corrallm. A Codex Terminal session is started with command hooks of
 * its own, given only to that session as config overrides on its command line
 * (`-c hooks.<Event>=[…]`; the user's config.toml is never touched, and their own hooks still
 * run): on the events corrallm follows, Codex runs a command that posts the event (the JSON Codex
 * writes to its stdin) to main's hook server (sessions/terminal/hooks.ts), with the bearer token
 * only that session has (in its environment). The command prints nothing and always succeeds, so
 * Codex goes on as it would without it.
 *
 * Codex runs a hook only once the user has trusted it (else its TUI stops at "Hooks need review"):
 * corrallm trusts its own for the session alone (`-c hooks.state={<key>={trusted_hash=…}}`), by
 * the key and hash Codex gives each hook (computed here as Codex computes them, and checked with
 * Codex itself: trust.ts).
 */

/** The events corrallm hears: startup permissions, a prompt, its turn's end and an interrupt. */
export const CODEX_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop', 'Interrupt'] as const;
export type CodexHookEvent = (typeof CODEX_HOOK_EVENTS)[number];

/** Each event's name in Codex's hook keys and hashes (its hook_event_key_label). */
const LABELS: Record<CodexHookEvent, string> = {
  SessionStart: 'session_start',
  UserPromptSubmit: 'user_prompt_submit',
  Stop: 'stop',
  Interrupt: 'interrupt',
};

/**
 * How long Codex waits for each, in seconds (it waits before it goes on; Interrupt's may be at
 * most 3). The command itself gives up sooner (five seconds).
 */
const TIMEOUTS: Record<CodexHookEvent, number> = {
  SessionStart: 10,
  UserPromptSubmit: 10,
  Stop: 10,
  Interrupt: 2,
};

/** One of a session's hooks: the event, the command Codex runs for it, how long it waits. */
export interface SessionHook {
  event: CodexHookEvent;
  command: string;
  timeout: number;
}

/**
 * The command that posts a hook event to `url`, with the token from its environment. Codex runs
 * it with the user's login shell (`$SHELL -lc`, which may be zsh, fish or another; on Windows
 * `cmd /C`), so on POSIX it runs its own `/bin/sh`, whose syntax is known. Without curl it reads
 * the event and drops it (corrallm then follows Codex by its window title alone). It never fails:
 * a hook that fails shows in Codex's transcript, and a Stop hook's exit code 2 would continue the
 * turn.
 */
export function hookCommand(url: string, platform: NodeJS.Platform = process.platform): string {
  return postHookCommand(url, platform === 'win32' ? 'cmd' : 'posix');
}

/** A session's hooks, each posting to `url`. */
export function sessionHooks(
  url: string,
  platform: NodeJS.Platform = process.platform,
): SessionHook[] {
  const command = hookCommand(url, platform);
  return CODEX_HOOK_EVENTS.map((event) => ({ event, command, timeout: TIMEOUTS[event] }));
}

/** A TOML basic string: JSON's escapes are TOML's, for the text corrallm writes. */
export const toml = (text: string): string => JSON.stringify(text);

/**
 * The override that trusts the project folder for one run of Codex (a `-c` value): the user chose
 * it in corrallm's folder dialog, the trust gate; their config.toml is never written. `names` are
 * other paths of the same folder (its real path, where it is reached through a link).
 */
export function folderTrust(cwd: string, ...names: string[]): string {
  const folders = [...new Set([cwd, ...names])];
  return `projects={${folders.map((folder) => `${toml(folder)}={trust_level="trusted"}`).join(',')}}`;
}

/** The overrides that add a session's hooks (`-c` values). */
export function hookOverrides(hooks: readonly SessionHook[]): string[] {
  return hooks.map(
    ({ event, command, timeout }) =>
      `hooks.${event}=[{hooks=[{type="command",command=${toml(command)},timeout=${String(timeout)}}]}]`,
  );
}

/** The override that trusts hooks for the session alone: their keys, and the hashes trusted. */
export function trustOverride(trust: ReadonlyMap<string, string>): string {
  const entries = [...trust].map(([key, hash]) => `${toml(key)}={trusted_hash=${toml(hash)}}`);
  return `hooks.state={${entries.join(',')}}`;
}

/**
 * The key Codex gives a hook passed on its command line (a session flag): its synthetic source
 * file, the event, its group and its place there. This is the key on POSIX; on Windows the file's
 * path is resolved against the drive, so trust.ts asks Codex.
 */
export function sessionHookKey(event: CodexHookEvent): string {
  return `/<session-flags>/config.toml:${LABELS[event]}:0:0`;
}

/**
 * The hash Codex trusts a hook by: SHA-256 of its normalized identity (the event, then its group:
 * its handler, with Codex's defaults filled in), as JSON with sorted keys, as Codex 0.160 hashes
 * it (codex-rs/hooks/src/engine/discovery.rs). trust.ts checks it with Codex itself.
 */
export function hookHash({ event, command, timeout }: SessionHook): string {
  const identity = {
    event_name: LABELS[event],
    hooks: [{ async: false, command, timeout, type: 'command' }],
  };
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(sorted(identity)))
    .digest('hex')}`;
}

/** The trust Codex 0.160 would need for `hooks` on POSIX: each one's key, and its hash. */
export function computedTrust(hooks: readonly SessionHook[]): Map<string, string> {
  return new Map(hooks.map((hook) => [sessionHookKey(hook.event), hookHash(hook)]));
}

/** `value` with every object's keys in order (as serde_json writes Codex's TOML values). */
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sorted((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}
