import { lstat, readdir } from 'node:fs/promises';
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

/** Only exact non-destructive names from this generation are pre-approved. */
export function entrySettings(api: SessionApi, available: boolean): Record<string, unknown> {
  return {
    deniedMcpServers: api.off.map((serverName) => ({ serverName })),
    ...(available
      ? {
          allowedMcpServers: [{ serverName: api.server }],
          permissions: {
            allow: api.tools
              .filter((tool) => !tool.destructive)
              .map((tool) => `mcp__${api.server}__${tool.name}`),
          },
        }
      : {}),
  };
}

/** Only the documented sideload refusals retry a Terminal startup without our entry. */
export function sideloadRefused(text: string): boolean {
  return /You cannot dynamically configure MCP servers when an enterprise MCP config is present|disableSideloadFlags|MCP sideload[^\n]*disabled/i.test(
    text,
  );
}
