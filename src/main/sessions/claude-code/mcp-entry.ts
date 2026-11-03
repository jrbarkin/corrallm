import { lstat, readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { SessionApi } from '../connector';
import { managedSettingsFolder } from './hooks-off';

/** Managed policy is authoritative; a deployed or unreadable managed source keeps our API off. */
export async function managedApiReason(
  managed = managedSettingsFolder(),
): Promise<string | undefined> {
  const reason = 'Claude Code’s managed settings keep corrallm’s API off for this session.';
  for (const name of ['managed-mcp.json', 'managed-settings.json']) {
    try {
      await lstat(path.join(managed, name));
      return reason;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return reason;
    }
  }
  try {
    if (
      (await readdir(path.join(managed, 'managed-settings.d'))).some((name) =>
        name.endsWith('.json'),
      )
    )
      return reason;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return reason;
  }
  return undefined;
}

/** The native settings sources read for a session, without its own flag settings. */
function settingsFiles(cwd: string, env: Readonly<Record<string, string>>): string[] {
  const config = env.CLAUDE_CONFIG_DIR ?? path.join(env.HOME ?? homedir(), '.claude');
  return [
    path.join(cwd, '.claude', 'settings.local.json'),
    path.join(cwd, '.claude', 'settings.json'),
    path.join(config, 'settings.json'),
  ];
}

/** A channel is installed only where the native settings permit its server name. */
export async function channelApiReason(
  cwd: string,
  env: Readonly<Record<string, string>>,
  managed?: string,
): Promise<string | undefined> {
  const policy = await managedApiReason(managed);
  if (policy !== undefined) return policy;
  for (const file of settingsFiles(cwd, env)) {
    try {
      const settings: unknown = JSON.parse(await readFile(file, 'utf8'));
      if (typeof settings !== 'object' || settings === null || Array.isArray(settings))
        throw new Error('Invalid settings.');
      const denied = (settings as Record<string, unknown>).deniedMcpServers;
      if (Array.isArray(denied)) {
        if (
          denied.some(
            (one: unknown) =>
              typeof one === 'object' &&
              one !== null &&
              (one as Record<string, unknown>).serverName === 'corrallm',
          )
        )
          return 'Your settings keep corrallm’s API off for this session.';
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        return 'Claude Code’s settings could not be read; corrallm’s API is off for this session.';
    }
  }
  return undefined;
}

/**
 * Whether the settings Claude Code reads for a session in `cwd` (the project's local and shared
 * settings, then the user's, in CLAUDE_CONFIG_DIR or ~/.claude) hold an MCP server allowlist
 * (`allowedMcpServers`). Lists merge across them, so the session's own entry joins yours only where
 * you have one: one naming corrallm alone would block your other servers in that session. Managed
 * settings aren't read: any of them keeps corrallm's API off (managedApiReason). Never written.
 */
export async function mcpAllowlisted(
  cwd: string,
  env: Readonly<Record<string, string>>,
): Promise<boolean> {
  const held = await Promise.all(
    settingsFiles(cwd, env).map(async (file) => {
      try {
        const settings: unknown = JSON.parse(await readFile(file, 'utf8'));
        return (
          typeof settings === 'object' &&
          settings !== null &&
          Array.isArray((settings as Record<string, unknown>).allowedMcpServers)
        );
      } catch {
        return false;
      }
    }),
  );
  return held.includes(true);
}

/** The session's MCP allowlist entry: only where yours holds an allowlist (mcpAllowlisted). */
function allowlist(api: SessionApi, allowlisted: boolean): Record<string, unknown> {
  return allowlisted ? { allowedMcpServers: [{ serverName: api.server }] } : {};
}

/**
 * Terminal's session settings: the outside names denied; with the entry, the server let through
 * your allowlist if you have one, and only exact non-destructive names from this generation
 * pre-approved.
 */
export function entrySettings(
  api: SessionApi,
  available: boolean,
  allowlisted: boolean,
): Record<string, unknown> {
  return {
    deniedMcpServers: api.off.map((serverName) => ({ serverName })),
    ...(available
      ? {
          ...allowlist(api, allowlisted),
          permissions: {
            allow: api.tools
              .filter((tool) => !tool.destructive)
              .map((tool) => `mcp__${api.server}__${tool.name}`),
          },
        }
      : {}),
  };
}

/**
 * The Agent SDK's flag settings, as its recording gave them: the outside names denied and, with
 * the entry, the server let through your allowlist if you have one. Its `allowedTools` pre-approves.
 */
export function sdkSettings(
  api: SessionApi,
  available: boolean,
  allowlisted: boolean,
): Record<string, unknown> {
  return {
    deniedMcpServers: api.off.map((serverName) => ({ serverName })),
    ...(available ? allowlist(api, allowlisted) : {}),
  };
}

/** Only the documented sideload refusals retry a Terminal startup without our entry. */
export function sideloadRefused(text: string): boolean {
  return /You cannot dynamically configure MCP servers when an enterprise MCP config is present|disableSideloadFlags|MCP sideload[^\n]*disabled/i.test(
    text,
  );
}
