import type { SessionApi } from '../connector';
import { askAppServer, startAppServer } from './rpc';
import type { AppServerOptions } from './rpc';
import { folderTrust } from './terminal/hooks';

export type HttpApi = Extract<SessionApi, { kind: 'http' }>;
export const SESSION_TOKEN = 'CORRALLM_SESSION_TOKEN';
export const SHELL_TOKEN = 'shell_environment_policy.set.CORRALLM_SESSION_TOKEN=""';
const REASON =
  'Codex could not verify corrallm’s session entry and shell policy; its API is off for this session.';

/** A session's native entry has no inline credential and no wildcard permission. */
export function apiEntry(api: HttpApi): Record<string, unknown> {
  return {
    url: api.url,
    enabled: true,
    disabled_tools: [],
    bearer_token_env_var: SESSION_TOKEN,
    default_tools_approval_mode: 'prompt',
    tools: Object.fromEntries(
      api.tools.map((tool) => [
        tool.name,
        { approval_mode: tool.destructive ? 'prompt' : 'approve' },
      ]),
    ),
  };
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const valued = (value: unknown): boolean =>
  value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0);
function same(left: unknown, right: unknown): boolean {
  if (!valued(left) && !valued(right)) return true;
  const l = record(left),
    r = record(right);
  if (l && r) return Object.keys({ ...l, ...r }).every((key) => same(l[key], r[key]));
  return JSON.stringify(left) === JSON.stringify(right);
}
function leaves(value: unknown, prefix = ''): string[] {
  const obj = record(value);
  return obj
    ? Object.entries(obj).flatMap(([key, one]) =>
        leaves(one, prefix === '' ? key : `${prefix}.${key}`),
      )
    : valued(value)
      ? [prefix]
      : [];
}
function sessionOrigin(value: unknown): boolean {
  if (value === 'sessionFlags') return true;
  const obj = record(value);
  return record(obj?.source)?.type === 'sessionFlags' || obj?.type === 'sessionFlags';
}
function fromFlags(origins: Record<string, unknown>, key: string): boolean {
  const found = [origins[key], origins[`mcp_servers.${key}`]].filter(
    (value) => value !== undefined,
  );
  return found.length > 0 && found.every(sessionOrigin);
}

/** Effective values and origins are checked together, including every planned valued leaf. */
export function entryIsCurrent(read: unknown, planned: Record<string, unknown>): boolean {
  const response = record(read),
    config = record(response?.config),
    origins = record(response?.origins);
  const entry = record(record(config?.mcp_servers)?.corrallm);
  if (!entry || !origins) return false;
  if (entry.environment_id !== undefined && entry.environment_id !== 'local') return false;
  const environmentOrigins = [
    origins['corrallm.environment_id'],
    origins['mcp_servers.corrallm.environment_id'],
  ].filter((value) => value !== undefined);
  if (environmentOrigins.some((value) => !sessionOrigin(value))) return false;
  const effective = Object.fromEntries(
    Object.entries(entry).filter(([key]) => key !== 'environment_id'),
  );
  if (!same(effective, planned)) return false;
  return leaves(effective).every((key) => fromFlags(origins, `corrallm.${key}`));
}

/** Outside registrations named by the issuer are inert under these same session flags. */
export function outsideIsCurrent(read: unknown, names: readonly string[]): boolean {
  const response = record(read),
    config = record(response?.config),
    origins = record(response?.origins);
  if (config === undefined || origins === undefined) return false;
  const servers = record(config.mcp_servers);
  return names.every(
    (name) => record(servers?.[name])?.enabled === false && fromFlags(origins, `${name}.enabled`),
  );
}

/** The shell receives an empty variable while MCP retains its process's bearer. */
export function shellIsCurrent(read: unknown): boolean {
  const response = record(read),
    config = record(response?.config),
    origins = record(response?.origins);
  return (
    record(record(config?.shell_environment_policy)?.set)?.[SESSION_TOKEN] === '' &&
    origins !== undefined &&
    sessionOrigin(origins[`shell_environment_policy.set.${SESSION_TOKEN}`])
  );
}
export function withoutSessionToken(env: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => key.toUpperCase() !== SESSION_TOKEN),
  );
}
function toml(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number')
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(toml).join(',')}]`;
  const obj = record(value);
  if (obj)
    return `{${Object.entries(obj)
      .map(([key, one]) => `${JSON.stringify(key)}=${toml(one)}`)
      .join(',')}}`;
  throw new Error('Invalid session MCP configuration.');
}
export function entryArgs(api: HttpApi): string[] {
  return [`mcp_servers.${api.server}=${toml(apiEntry(api))}`, SHELL_TOKEN].flatMap((one) => [
    '-c',
    one,
  ]);
}

/** Preflight never receives the bearer; nothing is written to native configuration. */
export async function prepareApi(
  context: Pick<AppServerOptions, 'codex' | 'cwd' | 'env'>,
  api: HttpApi,
  { start = startAppServer }: { start?: typeof startAppServer } = {},
): Promise<{
  args: string[];
  off: string[];
  disabled: string[];
  env: Record<string, string>;
  available: boolean;
  reason?: string;
}> {
  const env = withoutSessionToken(context.env);
  const base = {
    ...context,
    env,
    clientInfo: { name: 'corrallm', title: 'corrallm', version: '0.0.0' },
  };
  let off: string[] = [];
  let disabled: string[] = [];
  const read = (args: string[]) =>
    askAppServer(
      { ...base, args },
      (server) => server.request('config/read', { cwd: context.cwd, includeLayers: true }),
      { start, ms: 15_000, slow: REASON },
    );
  try {
    const original = record(record(await read(['-c', folderTrust(context.cwd)]))?.config);
    const servers = record(original?.mcp_servers);
    if (original === undefined || servers === undefined) {
      // An absent table is empty; an unreadable config is not.
      if (
        original === undefined ||
        (original.mcp_servers !== undefined && original.mcp_servers !== null)
      )
        throw new Error(REASON);
    }
    disabled = api.off.filter((name) => servers !== undefined && Object.hasOwn(servers, name));
    off = disabled.flatMap((name) => ['-c', `mcp_servers.${name}.enabled=false`]);
    const args = [...off, ...entryArgs(api)];
    const effective = await read(['-c', folderTrust(context.cwd), ...args]);
    if (
      !entryIsCurrent(effective, apiEntry(api)) ||
      !shellIsCurrent(effective) ||
      !outsideIsCurrent(effective, disabled)
    )
      throw new Error(REASON);
    return { args, off, disabled, env: { ...env, [SESSION_TOKEN]: api.token }, available: true };
  } catch {
    return { args: off, off, disabled, env, available: false, reason: REASON };
  }
}
